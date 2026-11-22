// The numbers of file-content contracts (S07, DC-04.2). Sizes come from the
// frozen grammar (PAYLOAD_BYTES.file, fileMax); the rest bound what reading
// a proposed file or a patch may cost. docs/contracts.md describes S07.
import { PAYLOAD_BYTES } from "../shapes/limits.ts";

export const FILE_LIMITS = {
  /** A contract's default size, in UTF-8 bytes of the complete file. */
  defaultBytes: PAYLOAD_BYTES.file,
  /** The most `max_bytes` may say; also the most read of a current file. */
  maxBytes: PAYLOAD_BYTES.fileMax,
  /** The leading `---` block, fences included: as much as a memory record. */
  frontmatterBytes: PAYLOAD_BYTES.memory,
  /** YAML aliases in frontmatter, as receipts allow. */
  aliases: 50,
  /** Level-1 and level-2 headings one file may have. */
  headings: 200,
  /** Link destinations checked in one file; more is refused, not skipped. */
  links: 500,
  /** One apply_patch call: its text, and the files it may touch. */
  patchBytes: 1024 * 1024,
  patchFiles: 50,
  /** Hunks in one patch, all files together. */
  patchHunks: 1000,
  /** Characters of a project-relative path, and its folder levels. */
  pathLength: 400,
  pathDepth: 32,
} as const;

/** What an S07 check guarantees. It never claims an atomic write. */
export const GUARANTEES = ["preflight-only", "mediated"] as const;
export type Guarantee = (typeof GUARANTEES)[number];
