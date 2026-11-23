// `nodrail connect hook`: the hook `apply` installs with `connect:` and
// `decide: cloud` (connected mode, R383). The local guards run first, exactly
// as the local hook's (the protect list, the setup, the run ledger, the
// connections' data); everything else is asked of Nodrail by the same client
// hook the plugin ships. The host runs it, never an agent.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { deny, type HookResult } from "@nodrail/policy-engine/actions";
import {
  connectedGuard,
  secretValue,
} from "@nodrail/policy-engine/command-line";
import { runHook } from "@nodrail/client/hooks";
import type { SecretRef } from "@nodrail/policy-engine/yaml";
import type { Io } from "../io.ts";

/** What `apply` writes to `.nodrail/connect.json`: references, never a secret. */
export type ConnectFile = {
  url: string;
  workspace: string;
  environment: string;
  enforce: "on" | "watch";
  credential: SecretRef;
};

const USAGE =
  "Usage: nodrail connect hook <.nodrail/connect.json> --protect-list <file> [--connections <file>]\nThe host runs it: `nodrail apply` writes it into the settings.";

/** Whether the event is a tool call about to run: the one thing a failure blocks. */
function isToolCall(stdin: string) {
  try {
    return (
      (JSON.parse(stdin) as { hook_event_name?: unknown }).hook_event_name ===
      "PreToolUse"
    );
  } catch {
    return true;
  }
}

function answer(io: Io, result: HookResult) {
  if (result.stderr) io.writeErr(result.stderr);
  if (result.stdout) io.write(result.stdout);
  return result.exitCode;
}

export async function connect(args: string[], io: Io): Promise<number> {
  const [sub, ...rest] = args;
  if (sub !== "hook") {
    io.err(USAGE);
    return 2;
  }
  const { values, positionals } = parseArgs({
    args: rest,
    options: {
      "protect-list": { type: "string" },
      connections: { type: "string" },
    },
    allowPositionals: true,
  });
  const stdin = await io.readStdin();
  // A tool call that can't be checked is blocked (2); a step, an outcome or
  // a session start never is, so a failure there doesn't stop the session.
  const fail = (reason: string) => {
    io.writeErr(`Nodrail: ${reason}\n`);
    return isToolCall(stdin) ? 2 : 0;
  };
  const file = positionals[0];
  const protectList = values["protect-list"];
  if (!file || !protectList)
    return fail(
      "the hook isn't set up whole (no connection file or protect list), so this action is blocked. Run `nodrail apply` again.",
    );
  let settings: ConnectFile;
  try {
    settings = JSON.parse(readFileSync(file, "utf8")) as ConnectFile;
  } catch (error) {
    return fail(
      `can't read ${file} (${(error as Error).message}), so this action is blocked. Run \`nodrail apply\` again.`,
    );
  }
  const guard = connectedGuard(stdin, {
    protectList,
    rules: [join(dirname(file), "effective.yaml")],
    connections: values.connections,
    env: io.env,
  });
  if (guard) return answer(io, deny(guard));
  let credential: string;
  try {
    credential = secretValue(settings.credential, io.env);
  } catch (error) {
    // Never another credential found elsewhere: only the one connect: names.
    return fail(
      `${(error as Error).message}, so this action is blocked: the hook needs the agent credential connect: names.`,
    );
  }
  const result = await runHook(
    stdin,
    { ...io.env, NODRAIL_URL: settings.url, NODRAIL_CREDENTIAL: credential },
    { agent: "claude-code", fetch: io.fetch },
  );
  return answer(io, result);
}
