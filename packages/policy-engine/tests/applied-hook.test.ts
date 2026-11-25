import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  statSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  deferToAppliedHook,
  recordAppliedHook,
  removeAppliedHook,
} from "../src/applied-hook.ts";

const settings = {
  hooks: {
    PreToolUse: [
      {
        matcher: "*",
        hooks: [
          {
            command:
              'nodrail policy hook "$CLAUDE_PROJECT_DIR/.nodrail/effective.yaml"',
          },
        ],
      },
    ],
    SessionStart: [
      {
        hooks: [{ command: 'nodrail observe "$CLAUDE_PROJECT_DIR" --detach' }],
      },
    ],
    Stop: [{ hooks: [{ command: "unrelated command" }] }],
  },
};

test("trust requires a private apply record, a matching project, and enabled hooks", () => {
  const folder = mkdtempSync(join(tmpdir(), "nodrail-apply-record-"));
  const project = join(folder, "project");
  const home = join(folder, "home");
  try {
    const claude = join(project, ".claude");
    mkdirSync(claude, { recursive: true });
    const config = join(claude, "settings.json");
    const local = join(claude, "settings.local.json");
    writeFileSync(config, JSON.stringify(settings));
    const allowed = (starting = false) =>
      deferToAppliedHook(home, project, project, { id: "test", starting });
    expect(allowed()).toBe(false);
    removeAppliedHook(home, project);
    recordAppliedHook(home, project, settings);
    expect(allowed()).toBe(false);
    expect(allowed(true)).toBe(true);
    expect(
      deferToAppliedHook(home, project, home, { id: "test", starting: false }),
    ).toBe(false);
    writeFileSync(local, '{"disableAllHooks":true}');
    expect(allowed()).toBe(false);
    writeFileSync(local, "{}");
    expect(allowed()).toBe(true);
    writeFileSync(
      config,
      JSON.stringify({ ...settings, allowManagedHooksOnly: true }),
    );
    expect(allowed()).toBe(false);
    writeFileSync(config, JSON.stringify(settings));
    if (process.getuid) {
      const records = join(home, ".nodrail", "applied-hooks");
      const name = readdirSync(records).find(
        (entry) => !entry.startsWith("session-"),
      );
      const path = join(records, name!);
      chmodSync(path, 0o666);
      expect(allowed()).toBe(false);
      chmodSync(path, 0o600);
    }
    expect(allowed()).toBe(true);
    removeAppliedHook(home, project);
    expect(allowed()).toBe(false);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test("uses native ownership checks where supported and verifies the record on Windows", () => {
  const folder = mkdtempSync(join(tmpdir(), "nodrail-owner-"));
  try {
    const home = join(folder, "home");
    const project = join(folder, "project");
    const claude = join(project, ".claude");
    mkdirSync(claude, { recursive: true });
    writeFileSync(join(claude, "settings.json"), JSON.stringify(settings));
    const windows = { getuid: undefined };
    const starting = { id: "session", starting: true };
    recordAppliedHook(home, project, settings, windows);
    const wrongOwner = {
      getuid: () => statSync(join(home, ".nodrail")).uid + 1,
    };
    expect(() =>
      recordAppliedHook(home, project, settings, wrongOwner),
    ).toThrow("private and user-owned");
    expect(
      deferToAppliedHook(home, project, project, {
        ...starting,
        owner: wrongOwner,
      }),
    ).toBe(false);
    expect(
      deferToAppliedHook(home, project, project, {
        ...starting,
        owner: windows,
      }),
    ).toBe(true);
    removeAppliedHook(home, project, wrongOwner);
    expect(
      deferToAppliedHook(home, project, project, {
        ...starting,
        starting: false,
        owner: windows,
      }),
    ).toBe(true);
    removeAppliedHook(home, project, windows);
    expect(
      deferToAppliedHook(home, project, project, {
        ...starting,
        owner: windows,
      }),
    ).toBe(false);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test("a corrupt apply record cannot authorize a previously verified session", () => {
  const folder = mkdtempSync(join(tmpdir(), "nodrail-corrupt-record-"));
  try {
    const claude = join(folder, ".claude");
    mkdirSync(claude);
    writeFileSync(join(claude, "settings.json"), JSON.stringify(settings));
    const session = { id: "session", starting: false };
    recordAppliedHook(folder, folder, settings);
    expect(
      deferToAppliedHook(folder, folder, folder, {
        ...session,
        starting: true,
      }),
    ).toBe(true);
    recordAppliedHook(folder, folder, settings);
    expect(deferToAppliedHook(folder, folder, folder, session)).toBe(true);
    writeFileSync(join(claude, "settings.local.json"), "{");
    expect(deferToAppliedHook(folder, folder, folder, session)).toBe(false);
    rmSync(join(claude, "settings.local.json"));
    const records = join(folder, ".nodrail", "applied-hooks");
    const name = readdirSync(records).find(
      (entry) => !entry.startsWith("session-"),
    );
    writeFileSync(join(records, name!), "{");
    expect(deferToAppliedHook(folder, folder, folder, session)).toBe(false);
    recordAppliedHook(folder, folder, settings);
    expect(deferToAppliedHook(folder, folder, folder, session)).toBe(false);
    expect(
      deferToAppliedHook(folder, folder, folder, {
        ...session,
        starting: true,
      }),
    ).toBe(true);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});
