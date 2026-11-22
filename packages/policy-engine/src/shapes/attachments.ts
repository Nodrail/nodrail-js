// Attachment points S01–S09: where each declared shape is used, and what
// each place adds to the shape's own rules.
import {
  bindBrief,
  briefOf,
  checkAliases,
  nestedProperty,
} from "./brief-binding.ts";
import { agentResource } from "./grammar-agent.ts";
import { bind, type Registry } from "./registry.ts";
import type { Path } from "./resolve.ts";
import type { ResolvedShape } from "./types.ts";
import { validateValue } from "./validate.ts";
import { compileWhere, single } from "./where.ts";

const M = "nodrail.yaml";

/** A set of names in one order, whatever order it was written in. */
const sorted = (names: readonly string[]) => [...new Set(names)].sort();

/**
 * Header lines are flat: scalars, enums, and findings as a list of
 * categories or an object of integer counts (`0 blocker / 1 major`).
 */
function headerProblem(shape: ResolvedShape) {
  return Object.entries(shape.properties).find(([, p]) => {
    if (p.type === "object")
      return !(
        p.role === "findings" &&
        Object.values(p.properties).every((c) => c.type === "integer")
      );
    return (
      p.type === "list" && !(p.role === "findings" && p.of.type === "enum")
    );
  })?.[0];
}

type Receipt = NonNullable<Registry["manifest"]["receipts"]>[string];

function checkHeader(
  registry: Registry,
  receipt: Receipt,
  shape: ResolvedShape,
  at: Path,
) {
  const nested = headerProblem(shape);
  if (nested)
    registry.report(
      "header-nesting",
      [...at, "format"],
      `A header receipt is flat; ${nested} nests`,
    );
  checkAliases(registry, shape, receipt.header?.aliases ?? {}, at);
}

// S01
function bindReceipts(registry: Registry) {
  for (const [name, receipt] of Object.entries(
    registry.manifest.receipts ?? {},
  )) {
    const at = [M, "receipts", name];
    const header = receipt.header ?? {
      title: "RECEIPT {agent}",
      mode_prefix: false,
    };
    const options =
      receipt.format === "header"
        ? { format: "header", header }
        : { format: "fenced" };
    const shape = bind(
      registry,
      {
        surface: "S01",
        name: `receipt:${name}`,
        shape: receipt.shape,
        options,
      },
      at,
    );
    if (!shape) continue;
    if (Object.hasOwn(shape.properties, "agent"))
      registry.report(
        "reserved-name",
        [...at, "shape"],
        "agent is the receipt's reserved identity; rename the property",
      );
    if (receipt.format === "header") checkHeader(registry, receipt, shape, at);
  }
}

// S01 selection and S02, from Agent resources.
function bindAgents(registry: Registry, resources: unknown[]) {
  resources.forEach((resource, index) => {
    if ((resource as { kind?: unknown } | null)?.kind !== "Agent") return;
    const at = ["resources", index];
    const parsed = agentResource.safeParse(resource);
    if (!parsed.success) {
      for (const issue of parsed.error.issues)
        registry.report(
          "grammar",
          [...at, ...(issue.path as (string | number)[])],
          issue.message,
        );
      return;
    }
    const { name } = parsed.data.metadata;
    const { receipt, brief } = parsed.data.spec;
    const briefing = brief === undefined ? null : briefOf(brief);
    registry.agents.set(name, {
      ...pickReceipt(registry, name, receipt, at),
      brief: briefing?.shape ?? null,
    });
    if (briefing) bindBrief(registry, name, briefing, [...at, "spec", "brief"]);
  });
}

/** The receipt an Agent reads: the one it names, else the one of its name. */
function pickReceipt(
  registry: Registry,
  name: string,
  receipt: string | undefined,
  at: Path,
) {
  const receipts = registry.manifest.receipts ?? {};
  if (receipt !== undefined && !Object.hasOwn(receipts, receipt))
    registry.report(
      "unknown-reference",
      [...at, "spec", "receipt"],
      `No receipt named ${receipt}`,
    );
  const picked = receipt ?? (Object.hasOwn(receipts, name) ? name : null);
  return {
    receipt: picked && Object.hasOwn(receipts, picked) ? picked : null,
    implicit: receipt === undefined && picked !== null,
  };
}

/** Operations a memory declaration writes its records through, with the record shape. */
function memoryWrites(registry: Registry) {
  const writes = new Map<string, string>();
  for (const memory of Object.values(registry.manifest.memory ?? {}))
    for (const operation of [
      memory.operations.create,
      memory.operations.update,
    ])
      if (operation)
        writes.set(`${memory.connection}.${operation}`, memory.shape);
  return writes;
}

/**
 * A resource id goes into the action's resource, which every reviewer, log
 * and Cloud view shows, so it can't come from a classified argument (R317).
 */
function classifiedResource(
  registry: Registry,
  input: ResolvedShape,
  resource: unknown,
  at: Path,
) {
  const from =
    typeof resource === "object" && resource !== null
      ? (resource as { from?: unknown }).from
      : undefined;
  if (typeof from !== "string" || !Object.hasOwn(input.properties, from))
    return;
  if (input.properties[from]!.classification !== null)
    registry.report(
      "classified-resource",
      [...at, "resource", "from"],
      `${from} is classified, so it can't name the resource: the resource is shown wherever the action is`,
    );
}

// S03 and S04
function bindConnections(registry: Registry) {
  const writes = memoryWrites(registry);
  for (const [connection, spec] of Object.entries(
    registry.manifest.connections ?? {},
  ))
    for (const [operation, slots] of Object.entries(spec.operations)) {
      const at = [M, "connections", connection, "operations", operation];
      const id = `${connection}.${operation}`;
      // The input of a memory write is the record: S06's rules, kind included, apply.
      const surface = writes.get(id) === slots.input ? "S06" : "S03";
      const input = slots.input
        ? bind(
            registry,
            { surface, name: `input:${id}`, shape: slots.input, options: {} },
            [...at, "input"],
          )
        : null;
      if (input) classifiedResource(registry, input, slots.resource, at);
      if (slots.output)
        bind(
          registry,
          {
            surface: "S04",
            name: `output:${id}`,
            shape: slots.output,
            options: {},
          },
          [...at, "output"],
        );
    }
}

// S05
function bindEvidence(registry: Registry) {
  for (const [name, evidence] of Object.entries(
    registry.manifest.evidence ?? {},
  )) {
    const { producers, subject } = evidence;
    bind(
      registry,
      {
        surface: "S05",
        name: `evidence:${name}`,
        shape: evidence.shape,
        options: { producers, subject },
      },
      [M, "evidence", name],
    );
  }
}

const knownAgents = (registry: Registry, agents: string[], at: Path) => {
  agents.forEach((agent, index) => {
    if (!registry.agents.has(agent))
      registry.report(
        "unknown-reference",
        [...at, index],
        `No Agent named ${agent}`,
      );
  });
};

type Memory = NonNullable<Registry["manifest"]["memory"]>[string];

function checkOperations(registry: Registry, memory: Memory, at: Path) {
  const declared =
    registry.manifest.connections?.[memory.connection]?.operations;
  for (const [slot, operation] of Object.entries(memory.operations)) {
    const op = declared?.[operation];
    if (!op)
      registry.report(
        "unknown-reference",
        [...at, "operations", slot],
        `No operation ${operation} on connection ${memory.connection}`,
      );
    else if (
      slot !== "delete" &&
      op.input !== undefined &&
      op.input !== memory.shape
    )
      registry.report(
        "binding-conflict",
        [...at, "operations", slot],
        `${operation}'s input is ${op.input}, not the record shape ${memory.shape}`,
      );
  }
}

// S06
function bindMemory(registry: Registry) {
  for (const [name, memory] of Object.entries(registry.manifest.memory ?? {})) {
    const at = [M, "memory", name];
    const { connection, operations, writers, deleters } = memory;
    // Who may write or delete is a set: sorted, so order never changes a digest.
    const options = {
      connection,
      operations,
      writers: Object.fromEntries(
        Object.entries(writers).map(([kind, agents]) => [kind, sorted(agents)]),
      ),
      deleters: sorted(deleters),
      max_records: memory.max_records ?? null,
    };
    const shape = bind(
      registry,
      { surface: "S06", name: `memory:${name}`, shape: memory.shape, options },
      at,
    );
    checkOperations(registry, memory, at);
    const kind =
      shape && Object.values(shape.properties).find((p) => p.role === "kind");
    for (const [value, agents] of Object.entries(writers)) {
      if (kind?.type === "enum" && !kind.values.includes(value))
        registry.report(
          "kind-value",
          [...at, "writers", value],
          `${value} isn't a value of the kind property`,
        );
      knownAgents(registry, agents, [...at, "writers", value]);
    }
    knownAgents(registry, deleters, [...at, "deleters"]);
  }
}

// S07
function bindFiles(registry: Registry) {
  for (const [name, file] of Object.entries(registry.manifest.files ?? {})) {
    const at = [M, "files", name];
    const sections = file.sections.map((s) =>
      typeof s === "string" ? { name: s, optional: false } : s,
    );
    const names = sections.map((s) => s.name.toLowerCase());
    names.forEach((section, index) => {
      if (names.indexOf(section) !== index)
        registry.report(
          "grammar",
          [...at, "sections", index],
          "Names a section twice",
        );
    });
    const options = {
      root: file.root,
      pattern: file.pattern,
      sections,
      max_bytes: file.max_bytes ?? null,
      writers: file.writers ? sorted(file.writers) : null,
    };
    bind(
      registry,
      {
        surface: "S07",
        name: `file:${name}`,
        shape: file.frontmatter ?? null,
        options,
      },
      [...at, "frontmatter"],
    );
    knownAgents(registry, file.writers ?? [], [...at, "writers"]);
  }
}

// S08, and the routes C04 reads.
function bindApprovals(registry: Registry) {
  for (const [name, form] of Object.entries(
    registry.manifest.approvals ?? {},
  )) {
    const at = [M, "approvals", name];
    const request = bind(
      registry,
      {
        surface: "S08",
        name: `request:${name}`,
        shape: form.request,
        options: {},
      },
      [...at, "request"],
    );
    if (form.decision)
      bind(
        registry,
        {
          surface: "S08",
          name: `decision:${name}`,
          shape: form.decision,
          options: {},
        },
        [...at, "decision"],
      );
    const projected = registry.projections.get(form.request)?.shape;
    form.routes.forEach((route, index) => {
      const here = [...at, "routes", index];
      if (!route.where && index < form.routes.length - 1)
        registry.report(
          "route-order",
          here,
          "A route without where catches everything; only the last can",
        );
      // Cloud routes on what it receives: reported request fields only.
      const conditions =
        route.where && request && projected
          ? compileWhere(
              route.where,
              single(request, projected),
              [...here, "where"],
              registry.report,
            )
          : [];
      registry.consumers.push({
        consumer: "C04",
        at: here.join("."),
        bindings: [`request:${name}`],
        conditions: conditions ?? [],
        detail: { approvers: route.approvers },
      });
    });
  }
}

// S09
function bindInventory(registry: Registry) {
  const inventory = registry.manifest.inventory;
  if (!inventory) return;
  const at = [M, "inventory"];
  const shape = bind(
    registry,
    { surface: "S09", name: "inventory", shape: inventory.shape, options: {} },
    [...at, "shape"],
  );
  if (!shape) return;
  const nested = nestedProperty(shape);
  if (nested)
    registry.report(
      "inventory-shape",
      [...at, "shape"],
      `Labels are single values; ${nested} isn't`,
    );
  for (const issue of validateValue(shape, inventory.values))
    registry.report(
      "value",
      [...at, "values", ...issue.path.split(".")],
      `${issue.path}: ${issue.message}`,
    );
}

export function bindAll(registry: Registry, resources: unknown[]) {
  bindAgents(registry, resources);
  bindReceipts(registry);
  bindConnections(registry);
  bindEvidence(registry);
  bindMemory(registry);
  bindFiles(registry);
  bindApprovals(registry);
  bindInventory(registry);
}
