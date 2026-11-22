// `@nodrail/policy-engine/contracts` (also `/shapes`): declared contracts,
// dialect 1. The grammar, its compiler, digests, projections, the authority
// model, and reading a receipt against its contract, as the local hook and
// Cloud both do. Receipts and gates on them, briefs, operation inputs and
// `where` on rules are enforced (engine level 4); other surfaces compile
// but aren't enforced yet. docs/contracts.md
// describes all of it.
export {
  CONTRACT_DIALECT,
  CONTRACTS_DOCUMENT_VERSION,
  CONTRACTS_ENGINE_LEVEL,
  ACCOUNTABLE_DOCUMENT_VERSION,
  ACCOUNTABLE_ENGINE_LEVEL,
  ENUM_VALUE,
  LIMITS,
  PAYLOAD_BYTES,
  PROPERTY_NAME,
  SHAPE_NAME,
  UNIT,
  VERDICT_VALUE,
  isDate,
} from "./limits.ts";
export {
  CLASSIFICATIONS,
  CONSUMERS,
  ROLES,
  SURFACES,
  type Classification,
  type CompiledCondition,
  type ConsumerId,
  type ContractIssue,
  type PropertyType,
  type ResolvedProperty,
  type ResolvedShape,
  type Role,
  type SurfaceId,
} from "./types.ts";
export { contractDigest, sha256Hex, type DigestDomain } from "./digest.ts";
export {
  compileContracts,
  lockSection,
  type CaseResult,
  type CompiledContracts,
  type CompiledShape,
  type ContractSources,
  type ContractsResult,
} from "./compile.ts";
export type { AgentContracts, Binding, ConsumerRef } from "./registry.ts";
export { projectShape, projectValue, type Projection } from "./project.ts";
/** Each named property of a resolved shape with its level and path. */
export { walk } from "./resolve.ts";
export {
  findingsCount,
  matchWhere,
  validateValue,
  valueAt,
  type ValueIssue,
} from "./validate.ts";
export {
  readContractReceipt,
  receiptContracts,
  type HeaderOptions,
  type ReceiptContract,
  type ReceiptIssue,
  type ReceiptReading,
} from "./receipt.ts";
export {
  anyHeader,
  headerMatcher,
  headerNaming,
  readHeaderBlock,
  type HeaderBlock,
  type HeaderMatch,
} from "./receipt-header.ts";
export {
  PRODUCER_CLASSES,
  RUNTIME_FIELDS,
  VALIDATION_STATES,
  recordEnvelope,
  reportedRecord,
  satisfiesAuthority,
  type ProducerClass,
  type RecordEnvelope,
  type ReportedRecord,
} from "./authority.ts";
export {
  briefContracts,
  inputContracts,
  readBrief,
  type BriefContract,
  type BriefReading,
} from "./brief.ts";
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
export { agentResource, briefDecl, type BriefDecl } from "./grammar-agent.ts";
export {
  contractCheck,
  mediatedCall,
  type ContractCheck,
  type MediatedCall,
} from "../runs.ts";
export {
  briefContract,
  compiledCondition,
  contractDigestText,
  inputContract,
  receiptContract,
  resolvedProperty,
  resolvedShape,
  ruleCondition,
} from "../contract-document.ts";
export { checkContracts, type ContractCall } from "../contract-calls.ts";
