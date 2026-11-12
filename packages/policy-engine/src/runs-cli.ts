// `nodrail-policy runs`: what the local ledger recorded, for people to read.
import {
  ledgerDirectory,
  readRun,
  readRuns,
  type Environment,
} from "./ledger.ts";
import type { RunEvent } from "./runs.ts";

type Out = { log: (text: string) => void; error: (text: string) => void };

const time = (at: string) => at.slice(0, 16).replace("T", " ");

function describe(event: RunEvent) {
  if (event.type === "step.started") return `${event.agent} started`;
  if (event.type === "step.finished") {
    const findings = event.findings.length
      ? ` (${event.findings.join(", ")})`
      : "";
    return `${event.agent} finished: ${event.verdict ?? "no receipt"}${findings}`;
  }
  return `${event.agent} ${event.tool} ${event.operation}: ${event.outcome}`;
}

/** One line per step and per held action; allowed actions are only counted. */
function show(run: string, events: RunEvent[], out: Out) {
  out.log(`Run ${run}`);
  let allowed = 0;
  const flush = () => {
    if (allowed) out.log(`                   ${allowed} allowed actions`);
    allowed = 0;
  };
  for (const event of events) {
    if (event.type === "action" && event.outcome === "allow") {
      allowed += 1;
      continue;
    }
    flush();
    out.log(`  ${time(event.at)}  ${describe(event)}`);
  }
  flush();
}

type Tally = { steps: number; verdicts: Map<string, number>; held: number };

/** Per agent: steps, verdicts, and how many of its actions were held. */
function report(runs: { run: string; events: RunEvent[] }[], out: Out) {
  const agents = new Map<string, Tally>();
  const of = (agent: string) => {
    const tally = agents.get(agent) ?? {
      steps: 0,
      verdicts: new Map(),
      held: 0,
    };
    agents.set(agent, tally);
    return tally;
  };
  for (const { events } of runs)
    for (const event of events) {
      const tally = of(event.agent);
      if (event.type === "step.finished") {
        tally.steps += 1;
        const verdict = event.verdict ?? "no receipt";
        tally.verdicts.set(verdict, (tally.verdicts.get(verdict) ?? 0) + 1);
      }
      if (event.type === "action" && event.outcome !== "allow") tally.held += 1;
    }
  out.log(`${runs.length} runs`);
  for (const [agent, { steps, verdicts, held }] of [...agents].sort(
    ([a], [b]) => a.localeCompare(b),
  )) {
    const said = [...verdicts].map(([verdict, count]) => `${verdict} ${count}`);
    out.log(
      `  ${agent}: ${steps} steps${said.length ? ` (${said.join(", ")})` : ""}, ${held} actions held`,
    );
  }
}

export function runsCommand(
  [what = "list", run]: string[],
  out: Out,
  env: Environment = process.env,
) {
  const directory = ledgerDirectory(process.cwd(), env);
  if (what === "show" && run) {
    const events = readRun(directory, run);
    if (!events.length) {
      out.error(`No run called "${run}" in ${directory}.`);
      return 1;
    }
    show(run, events, out);
    return 0;
  }
  const runs = readRuns(directory);
  if (what === "report") return (report(runs, out), 0);
  if (what !== "list") {
    out.error("Usage: nodrail-policy runs [list | show <run> | report]");
    return 2;
  }
  if (!runs.length) out.log(`No runs recorded in ${directory}.`);
  for (const { run: key, events } of runs) {
    const steps = events.filter(
      (event) => event.type === "step.finished",
    ).length;
    const last = events.at(-1)?.at;
    out.log(
      `${key}  ${steps} steps, ${events.length} events${last ? `, last ${time(last)}` : ""}`,
    );
  }
  return 0;
}
