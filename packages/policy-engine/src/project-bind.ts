import {
  isMap,
  isScalar,
  isSeq,
  parseDocument,
  Scalar,
  visit,
  type Pair,
} from "yaml";
import { agentName } from "./names.ts";

/** `{ binding: name }`: where a module wants one of the project's values. */
function bindingName(node: unknown) {
  if (!isMap(node) || node.items.length !== 1) return null;
  const [pair] = node.items;
  if (!pair || !isScalar(pair.key) || pair.key.value !== "binding") return null;
  return isScalar(pair.value) && typeof pair.value.value === "string"
    ? pair.value.value
    : null;
}

/** The binding names a module's file uses, in order, each once. */
export function bindingsUsed(text: string) {
  const names = new Set<string>();
  visit(parseDocument(text), {
    Map(_key, node) {
      const name = bindingName(node);
      if (name !== null) names.add(name);
    },
  });
  return [...names];
}

/**
 * The file with each `{ binding: name }` replaced by its value, as one quoted
 * string. The YAML is edited as a tree, not as text, so a value can only ever
 * be one string; comments and layout stay.
 */
export function bindFile(text: string, values: Record<string, string>) {
  const document = parseDocument(text);
  visit(document, {
    Map(_key, node) {
      const name = bindingName(node);
      if (name === null) return undefined;
      const value = values[name];
      if (value === undefined) throw new Error(`No value for ${name}`);
      const scalar = new Scalar(value);
      scalar.type = Scalar.QUOTE_DOUBLE;
      return scalar;
    },
  });
  return document.toString({ flowCollectionPadding: false, lineWidth: 0 });
}

/** Keys whose value is one agent: a rule's, a gate requirement's, a budget's. */
const AGENT_KEYS = new Set(["agent", "step_agent"]);

export type RenamedAgents = {
  text: string;
  /** Every agent the file names, as `agentName` spells it, each once. */
  names: string[];
  /** Places that name agents through a list, which a binding can't follow. */
  problems: string[];
};

/**
 * The file with each agent it names replaced as `roles` says: a role the
 * module wrote, like `github`, becomes the team's agent, like `publisher`.
 * Covers every place a rules file names an agent: `agent`, `step_agent`, a
 * requirement's `since`, and a `kind: agent` resource. A name `roles` doesn't
 * hold stays as it is, so the caller can tell what is still unmapped.
 */
export function renameAgents(
  text: string,
  roles: Readonly<Record<string, string>>,
): RenamedAgents {
  const names = new Set<string>();
  const problems: string[] = [];
  const rename = (node: unknown) => {
    if (!isScalar(node) || typeof node.value !== "string") return;
    const name = agentName(node.value);
    names.add(name);
    // Own keys only: an agent called constructor isn't Object's.
    if (Object.hasOwn(roles, name)) node.value = roles[name];
  };
  const document = parseDocument(text);
  visit(document, {
    Pair(_key, pair: Pair) {
      if (!isScalar(pair.key)) return;
      const key = pair.key.value;
      if (typeof key === "string" && AGENT_KEYS.has(key)) rename(pair.value);
      if (key !== "since") return;
      if (isSeq(pair.value)) pair.value.items.forEach(rename);
      else if (isMap(pair.value))
        problems.push("since: { list } names agents through a list");
      else rename(pair.value);
    },
    Map(_key, map) {
      if (map.get("kind") !== "agent") return;
      if (map.has("list"))
        problems.push(
          "resource: { kind: agent, list } names agents through a list",
        );
      else rename(map.get("value", true));
    },
  });
  return {
    text: document.toString({ flowCollectionPadding: false, lineWidth: 0 }),
    names: [...names],
    problems,
  };
}
