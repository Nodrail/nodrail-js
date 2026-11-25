// File-content contracts (preview): a typed frontmatter and
// section reader for complete files, the complete content each supported
// write would leave (Claude Code Write and Edit, apply_patch), and a check
// of a whole write against the contracts governing its files. Results are
// `preflight-only` unless a mediated writer applies the write; none is
// atomic. The hook does not call this check yet.
export { FILE_LIMITS, GUARANTEES, type Guarantee } from "./limits.ts";
export { readText, type FileIssue, type FileText } from "./text.ts";
export {
  contractsFor,
  fileContracts,
  governs,
  pathKey,
  projectPath,
  type FileContract,
  type FileSectionRule,
  type PathResult,
} from "./contracts.ts";
export {
  readStructure,
  type Frontmatter,
  type Heading,
  type Structure,
} from "./markdown.ts";
export { unsafeLink } from "./links.ts";
export {
  readFileContent,
  type FileReading,
  type FileSection,
} from "./parse.ts";
export {
  applyClaudeEdit,
  applyClaudeWrite,
  type ClaudeEdit,
  type Reconstruction,
} from "./edit.ts";
export {
  parsePatch,
  type PatchChunk,
  type PatchOperation,
  type PatchParse,
} from "./patch.ts";
export { applyUpdate } from "./patch-apply.ts";
export {
  readWriteRequest,
  WRITE_RUNTIMES,
  type RequestReading,
  type WriteRequest,
  type WriteRuntime,
} from "./requests.ts";
export {
  planWrite,
  type ChangeOperation,
  type CurrentFile,
  type FileChange,
  type Plan,
  type PlanContext,
} from "./plan.ts";
export {
  checkWrite,
  type ExpectedRevision,
  type FileVerdict,
  type WriteCheck,
  type WriteCheckInput,
} from "./check.ts";
export { checkWriteOnDisk, readCurrentFile } from "./fs.ts";
