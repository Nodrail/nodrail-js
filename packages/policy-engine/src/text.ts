/** The value when it is a string with something in it, else null. */
export const nonEmptyText = (value: unknown) =>
  typeof value === "string" && value ? value : null;
