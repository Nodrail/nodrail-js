// `@nodrail/policy-engine/contract-values`: the one strict value validator
// and the typed `where` matcher, with no dependencies at all, so a browser
// or a small hook bundle can check a value exactly as the engine and Cloud
// do. Reading a receipt (YAML) and compiling contracts are in
// `@nodrail/policy-engine/contracts`.
export {
  findingsCount,
  matchWhere,
  validateValue,
  valueAt,
  type ValueIssue,
} from "./validate.ts";
export { CONTRACT_DIALECT, LIMITS, PAYLOAD_BYTES, isDate } from "./limits.ts";
export type {
  CompiledCondition,
  ResolvedProperty,
  ResolvedShape,
} from "./types.ts";
export {
  anyHeader,
  headerMatcher,
  headerNaming,
  readHeaderBlock,
  type HeaderBlock,
  type HeaderMatch,
} from "./receipt-header.ts";
export { headerValue } from "./receipt-values.ts";
export {
  CLASSIFIED,
  briefLines,
  checkInput,
  checkValue,
  hasClassified,
  withoutClassified,
  type InputCheck,
  type InputContract,
  type InputIssue,
} from "./inputs.ts";
