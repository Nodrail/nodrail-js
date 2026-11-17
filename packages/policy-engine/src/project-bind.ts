import { isMap, isScalar, parseDocument, Scalar, visit } from "yaml";

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
