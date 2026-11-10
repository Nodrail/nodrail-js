export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** Rejects values whose serialization could vary across runtimes. */
export function isPlainJson(value: unknown): value is JsonValue {
  return isPlainJsonValue(value, new WeakSet<object>());
}

function isPlainJsonValue(
  value: unknown,
  ancestors: WeakSet<object>,
): value is JsonValue {
  if (value === null) return true;
  if (typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object") return false;
  if (ancestors.has(value)) return false;
  ancestors.add(value);
  if (Array.isArray(value)) {
    const valid = value.every((item) => isPlainJsonValue(item, ancestors));
    ancestors.delete(value);
    return valid;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  const valid =
    (prototype === Object.prototype || prototype === null) &&
    Object.values(value).every((item) => isPlainJsonValue(item, ancestors));
  ancestors.delete(value);
  return valid;
}
