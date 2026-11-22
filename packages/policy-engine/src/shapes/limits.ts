// The frozen numbers of the declared-contracts grammar, dialect 1.
// docs/contracts.md explains each one; a change here is a new dialect, never
// an edit to dialect 1. No imports: browsers bundle this.

/** The grammar version every compiled contract and digest carries. */
export const CONTRACT_DIALECT = 1;

/**
 * The rule-file engine level contract fields ask for. The engine runs at 4
 * since receipts and gates on contracts (S01, C01) are enforced; engines up
 * to 3 refuse such a file, never read it with its contract fields ignored.
 * Contract fields of later surfaces stay refused at 4 until enforced.
 */
export const CONTRACTS_ENGINE_LEVEL = 4;

/** The compiled policy document version that carries contracts. */
export const CONTRACTS_DOCUMENT_VERSION = 3;

/**
 * The rule-file engine level evidence requirements (S05 on C01) and
 * accountable budgets (C03: `count`, `sum`, `per: day`, `across`, measured
 * tokens) ask for. Engines up to 4 refuse such a file.
 */
export const ACCOUNTABLE_ENGINE_LEVEL = 5;

/** The compiled policy document version that carries them; readers of 3 refuse it. */
export const ACCOUNTABLE_DOCUMENT_VERSION = 4;

export const LIMITS = {
  /** Shapes in one workspace, its imports included. */
  shapes: 128,
  /** Nesting: a top-level property is level 1; an object or list adds one. */
  depth: 4,
  /** Named properties in one resolved shape, nested ones included. */
  properties: 64,
  /** Characters (Unicode code points) of a string, and its default maximum. */
  stringMax: 1000,
  /** Items of a list, and its default maximum. */
  listMax: 50,
  /** Values of an enum, and items of an `in` condition. */
  values: 50,
  /** Characters of a `for` text. */
  forText: 500,
  /** Conditions in one `where`. */
  conditions: 20,
  /** Routes of one approval form. */
  routes: 20,
  /** Columns, filters or groups of one view. */
  columns: 20,
  /** Named sections a file contract requires. */
  sections: 30,
  /** Test cases in one workspace. */
  cases: 200,
} as const;

/** Bytes of one payload, at the transport or attachment boundary. */
export const PAYLOAD_BYTES = {
  /** The whole fenced block, as receipts read today. */
  receipt: 8 * 1024,
  brief: 16 * 1024,
  input: 16 * 1024,
  output: 64 * 1024,
  evidence: 16 * 1024,
  memory: 16 * 1024,
  /** A file contract's default; `max_bytes` may lower it or raise it to fileMax. */
  file: 64 * 1024,
  fileMax: 256 * 1024,
  approval: 16 * 1024,
  inventory: 4 * 1024,
} as const;

/** Names in the registry, and of everything a contract attaches to. */
export const SHAPE_NAME = /^[a-z][a-z0-9-]{0,62}$/;
/** Property names: they become paths, columns and YAML keys. */
export const PROPERTY_NAME = /^[a-z][a-z0-9_]{0,62}$/;
/** Enum values. */
export const ENUM_VALUE = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
/** Verdict values, the words runs and gates already use. */
export const VERDICT_VALUE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
/** Units of a number: equal units are the only compatible ones. */
export const UNIT = /^[a-z][a-z0-9_]{0,31}$/;
/** A calendar date, checked further for a real Gregorian day. */
export const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A real Gregorian day written YYYY-MM-DD; never a parsed Date object. */
export function isDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = DATE.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1) return false;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= days[month - 1]!;
}

/** Characters as people count them: code points, not UTF-16 units. */
export const characters = (text: string) => {
  let count = 0;
  for (const _ of text) count += 1;
  return count;
};
