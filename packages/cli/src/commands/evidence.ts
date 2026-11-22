// `nodrail evidence run|submit|show` (DC-03.1, S05): evidence a gate can
// wait for.
//
// - `run <name> -- <command>`: runtime-observed, on this machine. The CLI
//   reads the work's revision before and after the command and the JSON
//   the command wrote to $NODRAIL_EVIDENCE_OUT, validates it against the
//   evidence's pinned contract and records the event in the ledger folder.
//   The command's exit code alone is never a value (R294). The setup guard
//   keeps agents from running this themselves.
// - `submit <name> --result <file>`: externally verified, from CI. It asks
//   GitHub Actions for an OIDC token for this workspace and sends the value
//   to Cloud, which checks who sent it. Retries are idempotent.
// - `show <name>`: what was recorded here, and whether each gate
//   requirement reading it is met for the current revision.
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  declaredGateId,
  declaredGates,
  evidenceOf,
  type EvidenceContract,
  type PolicyDocument,
} from "@nodrail/policy-engine";
import {
  checkValue,
  PAYLOAD_BYTES,
  projectShape,
} from "@nodrail/policy-engine/contracts";
import {
  describeEvidence,
  evidenceShortfall,
  ledgerDirectory,
  readEvidence,
  recordEvidence,
  type EvidenceEvent,
} from "@nodrail/policy-engine/ledger";
import { cleanRevision, workRevision } from "@nodrail/policy-engine/revision";
import { visibleLines } from "../api.ts";
import { UsageError, type Io } from "../io.ts";
import { contractOf, parseEvidenceArgs, short } from "./evidence-shared.ts";
import { submit } from "./evidence-submit.ts";
import { policyHere } from "./policy-here.ts";
import { runSubcommand } from "./subcommands.ts";

export { SUBMIT_EXIT } from "./evidence-submit.ts";

export const EVIDENCE_USAGE = `Usage:
  nodrail evidence run <name> [--policy <file>] -- <command> [args…]
  nodrail evidence submit <name> --result <file> --workspace <id> -e <environment> [--key <k>] [--policy <file>] [--url <url>]
  nodrail evidence show <name> [--policy <file>] [--json]`;

type Reading = {
  state: EvidenceEvent["validation"]["state"];
  issues: EvidenceEvent["validation"]["issues"];
  value: Record<string, unknown> | null;
};

/** What the command wrote, checked against the whole contract. */
function readResult(file: string, contract: EvidenceContract): Reading {
  const missing: Reading = { state: "missing", issues: [], value: null };
  if (!existsSync(file) || statSync(file).size === 0) return missing;
  const invalid = (code: string): Reading => ({
    state: "invalid",
    issues: [{ path: "(value)", code }],
    value: null,
  });
  if (statSync(file).size > PAYLOAD_BYTES.evidence) return invalid("size");
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return invalid("json");
  }
  const checked = checkValue(contract.shape, value, PAYLOAD_BYTES.evidence);
  if (checked.state === "valid")
    return { state: "valid", issues: [], value: checked.value };
  return {
    state: "invalid",
    issues: checked.issues.slice(0, 20).map(({ path, code }) => ({
      path: path.slice(0, 400),
      code: code.slice(0, 40),
    })),
    value: null,
  };
}

/** Runs the command with the terminal; its exit code, 127 when it can't start. */
function runCommand(command: string[], cwd: string, env: Io["env"]) {
  return new Promise<{ code: number; error: string | null }>((done) => {
    const child = spawn(command[0]!, command.slice(1), {
      cwd,
      env: env as NodeJS.ProcessEnv,
      stdio: "inherit",
      shell: process.platform === "win32",
    });
    child.on("error", (error) => done({ code: 127, error: error.message }));
    child.on("close", (code, signal) =>
      done({ code: code ?? (signal ? 128 : 1), error: null }),
    );
  });
}

async function run(rest: string[], io: Io) {
  const split = rest.indexOf("--");
  if (split < 0 || split === rest.length - 1)
    throw new UsageError(
      "`nodrail evidence run` needs the command after --: nodrail evidence run <name> -- <command>",
    );
  const { values, positionals } = parseEvidenceArgs(rest.slice(0, split));
  const command = rest.slice(split + 1);
  const [name, extra] = positionals;
  if (!name || extra !== undefined)
    throw new UsageError(
      "Usage: nodrail evidence run <name> [--policy <file>] -- <command>",
    );
  const document = policyHere({ cwd: io.cwd, home: io.home, ...values });
  const contract = contractOf(document, name, "runtime-observed");
  const ledger = ledgerDirectory(io.cwd, io.env);
  const folder = mkdtempSync(join(tmpdir(), "nodrail-evidence-"));
  const out = join(folder, "result.json");
  try {
    const before = workRevision(io.cwd);
    const started = new Date().toISOString();
    const ran = await runCommand(command, io.cwd, {
      ...io.env,
      NODRAIL_EVIDENCE_OUT: out,
    });
    const finished = new Date().toISOString();
    const after = workRevision(io.cwd);
    if (ran.error)
      io.err(`nodrail: ${command[0]} couldn't start: ${ran.error}`);
    // A revision that changed while it ran: the result is about neither.
    const subject =
      before !== null && before === after
        ? { kind: "revision" as const, digest: before }
        : null;
    const reading = readResult(out, contract);
    const event: EvidenceEvent = {
      type: "evidence.recorded",
      event: randomUUID(),
      evidence: name,
      contract: contract.contract,
      projection: projectShape(contract.shape).digest,
      producer: { class: "runtime-observed", id: "cli:evidence-run" },
      subject,
      observed: {
        exit_code: ran.code,
        started_at: started,
        finished_at: finished,
      },
      validation: { state: reading.state, issues: reading.issues },
      value: reading.value,
    };
    recordEvidence(ledger, event);
    const why =
      subject === null
        ? before === null
          ? "; the revision can't be read, so the subject is unknown"
          : "; the work changed while it ran, so the subject is unknown"
        : `, subject ${short(subject.digest)}`;
    const said =
      reading.state === "missing"
        ? "missing: the command wrote nothing to $NODRAIL_EVIDENCE_OUT"
        : reading.state === "invalid"
          ? `invalid (${reading.issues.map((i) => `${i.path}: ${i.code}`).join(", ")})`
          : "valid";
    io.err(
      `nodrail: recorded ${name}: ${said}${why} (exit ${ran.code}, event ${event.event}).`,
    );
    if (ran.code !== 0) return ran.code;
    return reading.state === "valid" ? 0 : 1;
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

/** The local events of one evidence, newest first, with what each gate makes of them. */
function show(rest: string[], io: Io) {
  const { values, positionals } = parseEvidenceArgs(rest);
  const [name, extra] = positionals;
  if (!name || extra !== undefined)
    throw new UsageError("Usage: nodrail evidence show <name>");
  const ledger = ledgerDirectory(io.cwd, io.env);
  const events = readEvidence(ledger, name);
  const subject = workRevision(io.cwd);
  const head = spawnSync("git", ["rev-parse", "--verify", "HEAD"], {
    cwd: io.cwd,
    encoding: "utf8",
  });
  const clean = head.status === 0 ? cleanRevision(head.stdout.trim()) : null;
  let document: PolicyDocument | null = null;
  try {
    document = policyHere({ cwd: io.cwd, home: io.home, ...values });
  } catch {
    document = null;
  }
  const reader = { local: () => events, remote: () => null };
  const gates =
    document?.version === 4
      ? declaredGates(document.gates).flatMap((gate) =>
          evidenceOf(gate).flatMap((need, index) =>
            need.evidence === name
              ? [
                  {
                    gate: declaredGateId(gate),
                    index,
                    need: describeEvidence(need),
                    unmet:
                      need.authority === "externally-verified"
                        ? "Cloud's to confirm: the hook asks it"
                        : evidenceShortfall(
                            need,
                            { gate: gate.id, index },
                            { subject, clean, evidence: reader },
                          ),
                  },
                ]
              : [],
          ),
        )
      : [];
  if (values.json) {
    io.out(JSON.stringify({ evidence: name, subject, events, gates }, null, 2));
    return 0;
  }
  const lines = [
    `${name}: ${events.length} event${events.length === 1 ? "" : "s"} recorded here; the work is at ${short(subject)}.`,
    ...events
      .slice(-10)
      .reverse()
      .map(
        (e) =>
          `  ${e.observed.finished_at}  ${e.validation.state.padEnd(7)}  subject ${short(e.subject?.digest)}${e.subject?.digest === subject && subject ? " (this revision)" : ""}  exit ${e.observed.exit_code}  contract ${short(e.contract)}`,
      ),
    ...gates.map(
      (g) =>
        `Gate ${g.gate} #${g.index + 1}, ${g.need}: ${g.unmet === null ? "met here" : `not met: ${g.unmet}`}.`,
    ),
  ];
  io.out(visibleLines(lines.join("\n")));
  return 0;
}

/** `nodrail evidence <run|submit|show> …`; answers its exit code. */
export const evidence = (args: string[], io: Io) =>
  runSubcommand({ run, submit, show }, EVIDENCE_USAGE, args, io);
