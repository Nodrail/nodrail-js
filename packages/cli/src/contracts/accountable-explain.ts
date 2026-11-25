// `nodrail contracts explain` for engine level 5: an evidence requirement
// of a gate (authority, producers, the verifier it depends on, where it is
// read), a numeric budget (its label, source, window and scope, and why it
// can't be activated locally), and the evidence binding itself. Declared
// values only; nothing runs.
import { BUDGET_LABELS } from "@nodrail/policy-engine";
import type { CompiledContracts } from "./engine.ts";

type Item = Record<string, unknown>;
type Binding = CompiledContracts["bindings"][number];

const text = (value: unknown) =>
  typeof value === "string" ? value : JSON.stringify(value);

type Producer = { class: string; verifier: string | null };

/** The producers an evidence binding declares, as its options carry them. */
function producersOf(binding: Binding | undefined): Producer[] {
  const raw = binding?.options.producers;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((p: unknown) => {
    if (typeof p !== "object" || p === null) return [];
    const { class: kind, verifier } = p as Record<string, unknown>;
    return typeof kind === "string"
      ? [
          {
            class: kind,
            verifier: typeof verifier === "string" ? verifier : null,
          },
        ]
      : [];
  });
}

const producerText = (p: Producer) =>
  p.verifier ? `${p.class} by verifier ${p.verifier}` : p.class;

/** Where each producer's events are read, and what a gate needs of them. */
function producerLines(producers: Producer[], authority: string) {
  const lines: string[] = [];
  if (
    authority !== "externally-verified" &&
    producers.some((p) => p.class === "runtime-observed")
  )
    lines.push(
      "Read here from `nodrail evidence run`, which a person runs; the setup guard keeps agents from running it (without the guard, plan fails activation).",
    );
  for (const p of producers)
    if (p.verifier)
      lines.push(
        `Verifier ${p.verifier}: Cloud resolves it (\`nodrail plan\` checks it with a token; a missing or revoked verifier fails activation). The hook asks Cloud for the published workspace revision; offline or unpublished stays unmet.`,
      );
  if (lines.length === 0)
    lines.push(
      `No producer listed can give ${authority} evidence here: the requirement stays unmet.`,
    );
  return lines;
}

/** The producers a rule file's own `contracts` entry declares for an evidence. */
function declaredProducers(items: Item[], name: string) {
  for (const item of items) {
    const evidence = (item?.contracts as Item | undefined)?.evidence as
      Item | undefined;
    const declared = evidence?.[name] as Item | undefined;
    if (declared)
      return producersOf({ options: declared } as unknown as Binding);
  }
  return [];
}

/** A requirement's `where` as written, when no compiled condition is at hand. */
function rawConditions(where: unknown): string[] {
  if (typeof where !== "object" || where === null) return [];
  return Object.entries(where as Item).map(([path, value]) => {
    if (typeof value !== "object" || value === null)
      return `${path} is ${text(value)}`;
    const range = value as Item;
    if (Array.isArray(range.in))
      return `${path} is one of ${range.in.map(text).join(", ")}`;
    return [
      range.min !== undefined ? `${path} is at least ${text(range.min)}` : "",
      range.max !== undefined ? `${path} is at most ${text(range.max)}` : "",
    ]
      .filter(Boolean)
      .join(" and ");
  });
}

/** An evidence requirement of a gate, as the explanation lists it. */
export function evidenceNeedLines(
  contracts: CompiledContracts | null,
  need: Item,
  at: number,
  /** The compiled conditions, and the rule items for what isn't compiled. */
  read: { compiled: string[]; items: Item[] },
) {
  const { compiled, items } = read;
  const name = text(need.evidence);
  const authority = text(need.authority ?? "runtime-observed");
  const binding = contracts?.bindings.find(
    (b) => b.name === `evidence:${name}`,
  );
  const fromBinding = producersOf(binding);
  const producers = fromBinding.length
    ? fromBinding
    : declaredProducers(items, name);
  const conditions = compiled.length ? compiled : rawConditions(need.where);
  return [
    `    ${at + 1}. evidence ${name}, authority ${authority}, about the current revision (subject: ${text(need.subject ?? "revision")})`,
    `       Producers: ${producers.length ? producers.map(producerText).join("; ") : "none declared"}.`,
    ...producerLines(producers, authority).map((line) => `       ${line}`),
    "       Met by the latest event for this exact revision, from a producer of at least that authority, validated with the pinned contract; an old result never opens a gate for new work.",
    ...conditions.map((c) => `       And ${c}.`),
  ];
}

/** The S05 binding's own lines: its producers and where they are read. */
export function evidenceBindingLines(binding: Binding) {
  const producers = producersOf(binding);
  return [
    `  Producers: ${producers.length ? producers.map(producerText).join("; ") : "none declared"}`,
    `  Subject: ${text(binding.options.subject ?? "none")}`,
    ...producerLines(producers, "runtime-observed").map((line) => `  ${line}`),
  ];
}

/** The label a budget's source gives it: never configured. */
function labelOf(item: Item) {
  if (item.count !== undefined) return BUDGET_LABELS["enforced-allowance"];
  if (typeof item.sum === "object" && item.sum !== null) {
    const path = text((item.sum as Item).path);
    return path.startsWith("input.")
      ? BUDGET_LABELS["enforced-allowance"]
      : BUDGET_LABELS["measured-usage"];
  }
  if (item.tokens !== undefined && item.source === "measured")
    return BUDGET_LABELS["measured-usage"];
  if (item.tool_calls !== undefined) return BUDGET_LABELS["enforced-allowance"];
  return BUDGET_LABELS["agent-reported-usage"];
}

function countsOf(item: Item) {
  if (typeof item.count === "object" && item.count !== null) {
    const c = item.count as Item;
    return `calls of ${text(c.tool)} ${text(c.operation)} the hook lets go ahead, reserved before each call`;
  }
  if (typeof item.sum === "object" && item.sum !== null) {
    const s = item.sum as Item;
    const path = text(s.path);
    return path.startsWith("input.")
      ? `${path} of ${text(s.tool)} ${text(s.operation)}, known before the call and reserved`
      : `${path} of ${text(s.tool)} ${text(s.operation)}, measured after the call: it stops further work at the limit, it can't cap one call`;
  }
  if (item.tokens !== undefined && item.source === "measured")
    return "subagent tokens the host measured (Claude Code foreground); a step without a reading is unknown and holds";
  if (item.tool_calls !== undefined) return "every decided tool call";
  return "what agents reported in receipts: advisory, it still blocks at the limit";
}

/** A budget (by name or id) explained, or null when the target isn't one. */
export function explainBudget(items: unknown[], target: string) {
  const item = (items as Item[]).find(
    (each) =>
      typeof each === "object" &&
      each !== null &&
      each.budget !== undefined &&
      (each.budget === target || each.id === target),
  );
  if (!item) return null;
  const per = text(item.per ?? "run");
  const window =
    per === "day" ? `per day in ${text(item.timezone)}` : `per ${per}`;
  const across = text(item.across ?? "run");
  const limit =
    item.limit ?? item.tool_calls ?? item.tokens ?? item.usd ?? "(none)";
  const unit = item.unit ?? (item.count !== undefined ? "calls" : "");
  return [
    `Budget "${text(item.budget)}"${item.id ? ` (id ${text(item.id)})` : ""}: ${labelOf(item)}`,
    `  Counts: ${countsOf(item)}`,
    `  Limit: ${text(limit)}${unit ? ` ${text(unit)}` : ""} ${window}, across ${across}; at the limit: ${text(item.otherwise ?? "deny")}.`,
    across === "environment"
      ? "  ! Activation fails locally: shared budgets are enforced only on a Cloud-managed connection, and the local hook would hold every call it covers."
      : "  Enforced by: the local hook, under the run's lock; PostToolUse consumes, a failed call without a mediated record stays unknown and counts until `nodrail budgets reconcile`.",
    "  An operational limit, not your Nodrail bill.",
  ].join("\n");
}
