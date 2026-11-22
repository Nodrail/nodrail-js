// `nodrail budgets status|reconcile` (DC-03.3, R299): numeric budgets as the
// local run ledger counts them, and the person's word on a reservation
// whose outcome is unknown. Everything is the engine's (`/ledger`): this
// only reads it out and records what the person says, under the run's lock.
// The setup guard keeps agents from running it; reconciling in Cloud is an
// admin's or policy manager's, there.
import {
  BUDGET_LABELS,
  type NumericBudget,
  type PolicyDocument,
} from "@nodrail/policy-engine";
import {
  ledgerDirectory,
  limitState,
  openKeys,
  readRun,
  readRuns,
  reconcile,
  record,
  settlements,
  withRunLock,
  type LimitState,
} from "@nodrail/policy-engine/ledger";
import { visibleLines } from "../api.ts";
import { CliError, UsageError, type Io } from "../io.ts";
import { windowOf } from "../setup/accountable.ts";
import { policyHere } from "./policy-here.ts";
import { parseFlags, runSubcommand } from "./subcommands.ts";

export const BUDGETS_USAGE = `Usage:
  nodrail budgets status [--run <run>] [--policy <file>] [--json]
  nodrail budgets reconcile <key> --consumed|--released --note <why> [--run <run>]`;

const options = {
  run: { type: "string" },
  policy: { type: "string" },
  json: { type: "boolean" },
  consumed: { type: "boolean" },
  released: { type: "boolean" },
  note: { type: "string" },
} as const;

const parse = (args: string[]) => parseFlags(args, options);

type RunEvents = { run: string; events: ReturnType<typeof readRun> };

/** The call a budget counts, as status asks about it: what one more would add. */
function probe(budget: NumericBudget) {
  const { measure } = budget;
  return measure.kind === "tokens"
    ? { tool: "claude-code", operation: "agent", values: null }
    : { tool: measure.tool, operation: measure.operation, values: null };
}

/** Where a budget stands in one run (each step, for a per-step budget). */
function standing(budget: NumericBudget, run: RunEvents, now: Date) {
  const agent = budget.agent ?? "main";
  const steps =
    budget.per === "step"
      ? [
          ...new Set(
            run.events.flatMap((e) =>
              (e.type === "budget.reserved" && e.budget === budget.id) ||
              e.type === "budget.measured"
                ? [e.step]
                : [],
            ),
          ),
        ]
      : [null];
  return steps.flatMap((step) => {
    const state = limitState(budget, {
      run: {
        run: run.run,
        step:
          step === null
            ? budget.agent
              ? { id: "status", agent }
              : null
            : { id: step, agent },
        events: run.events,
      },
      call: probe(budget),
      now,
      authority: "local",
    });
    return state ? [{ step, state }] : [];
  });
}

/** Reservations without a runtime outcome yet, and those settled unknown. */
function pending(run: RunEvents) {
  const settled = settlements(run.events);
  const open = new Set(openKeys(run.events));
  return run.events.flatMap((e) =>
    e.type === "budget.reserved" &&
    (open.has(e.key) || settled(e.key) === "unknown")
      ? [
          {
            run: run.run,
            key: e.key,
            budget: e.budget,
            amount: e.amount,
            unit: e.unit,
            at: e.at,
            state: open.has(e.key)
              ? ("reserved" as const)
              : ("unknown" as const),
          },
        ]
      : [],
  );
}

const usedText = (state: LimitState) =>
  `${state.used}${state.unread ? ` (≥, ${state.unread} step${state.unread === 1 ? "" : "s"} unknown)` : ""} of ${state.limit} ${state.unit}${state.reserved ? `, ${state.reserved} reserved` : ""}${state.unknown ? `, ${state.unknown} unknown` : ""}${state.resets ? `; resets ${state.resets}` : ""}`;

function limitsOf(document: PolicyDocument) {
  const limits = document.version === 4 ? document.limits : [];
  if (limits.length === 0)
    throw new CliError(
      "The policy has no numeric budgets (engine level 5 `count`, `sum` or measured `tokens`).",
    );
  return limits;
}

function runsHere(io: Io, run: string | undefined): RunEvents[] {
  const ledger = ledgerDirectory(io.cwd, io.env);
  if (run === undefined) return readRuns(ledger);
  const events = readRun(ledger, run);
  if (!events.length)
    throw new CliError(`No run called "${run}" in ${ledger}.`);
  return [{ run, events }];
}

function status(rest: string[], io: Io) {
  const { values, positionals } = parse(rest);
  if (
    positionals.length > 0 ||
    values.consumed ||
    values.released ||
    values.note
  )
    throw new UsageError("Usage: nodrail budgets status [--run <run>]");
  const limits = limitsOf(
    policyHere({ cwd: io.cwd, home: io.home, policy: values.policy }),
  );
  const runs = runsHere(io, values.run);
  const now = new Date();
  const budgets = limits.map((budget) => ({
    id: budget.id,
    name: budget.name,
    label: BUDGET_LABELS[budget.label],
    across: budget.across,
    window: windowOf(budget),
    runs:
      budget.across === "environment"
        ? []
        : runs.flatMap((run) =>
            standing(budget, run, now).map(({ step, state }) => ({
              run: run.run,
              step,
              state,
            })),
          ),
  }));
  const open = runs.flatMap(pending);
  if (values.json) {
    io.out(JSON.stringify({ budgets, pending: open }, null, 2));
    return 0;
  }
  const lines: string[] = [
    "Budgets (operational limits, not your Nodrail bill)",
  ];
  for (const budget of budgets) {
    lines.push(
      `  ${budget.id} · ${budget.label} · ${budget.window}, across ${budget.across}`,
    );
    if (budget.across === "environment")
      lines.push(
        "    shared across the environment: only a Cloud-managed connection counts it; the local hook holds every call it covers",
      );
    else if (budget.runs.length === 0) lines.push("    no run has used it");
    for (const each of budget.runs)
      lines.push(
        `    ${each.run}${each.step ? ` step ${each.step}` : ""}: ${usedText(each.state)}`,
      );
  }
  if (open.length > 0)
    lines.push(
      "",
      "Reservations without a known outcome (each still counts)",
      ...open.map(
        (p) =>
          `  ${p.key}  ${p.budget} ${p.amount} ${p.unit}  ${p.state}  run ${p.run}  ${p.at}`,
      ),
      "",
      "Once you know what happened: nodrail budgets reconcile <key> --consumed|--released --note <why>",
    );
  io.out(visibleLines(lines.join("\n")));
  return 0;
}

function reconcileCommand(rest: string[], io: Io) {
  const { values, positionals } = parse(rest);
  const [key, extra] = positionals;
  const note = values.note?.trim();
  if (
    !key ||
    extra !== undefined ||
    values.consumed === values.released ||
    !note
  )
    throw new UsageError(
      "Usage: nodrail budgets reconcile <key> --consumed|--released --note <why>",
    );
  const word = values.consumed ? ("consumed" as const) : ("released" as const);
  const ledger = ledgerDirectory(io.cwd, io.env);
  const holding = runsHere(io, values.run).filter((run) =>
    run.events.some((e) => e.type === "budget.reserved" && e.key === key),
  );
  if (holding.length === 0)
    throw new CliError(
      `No reservation ${key}${values.run ? ` in run ${values.run}` : ""}. \`nodrail budgets status\` lists them.`,
    );
  if (holding.length > 1)
    throw new CliError(
      `${key} is in ${holding.length} runs (${holding.map((r) => r.run).join(", ")}): name one with --run.`,
    );
  const { run } = holding[0]!;
  // Under the run's lock, as the hook writes: the next decision sees it.
  const written = withRunLock(ledger, run, () => {
    const events = readRun(ledger, run);
    const before = settlements(events)(key);
    const settled = reconcile(events, key, {
      state: word,
      at: new Date().toISOString(),
      note,
    });
    if (settled) record(ledger, run, settled);
    return settled ? { before } : null;
  });
  if (!written) throw new CliError(`No reservation ${key} in run ${run}.`);
  const result = {
    run,
    key,
    state: word,
    before: written.before ?? "reserved",
    note,
  };
  if (values.json) io.out(JSON.stringify(result, null, 2));
  else
    io.out(
      visibleLines(
        `Reconciled ${key} in run ${run}: ${result.before} → ${word} (by you). ${word === "released" ? "It no longer counts." : "It counts as used."}`,
      ),
    );
  return 0;
}

/** `nodrail budgets <status|reconcile> …`; answers its exit code. */
export const budgets = (args: string[], io: Io) =>
  runSubcommand(
    { status, reconcile: reconcileCommand },
    BUDGETS_USAGE,
    args,
    io,
  );
