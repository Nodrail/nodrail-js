import { join } from "node:path";
import {
  POLICY_CHECK_FILE,
  spoolFolder,
} from "@nodrail/policy-engine/command-line";
import { frozenPolicy } from "../commands/project.ts";
import { describeFailure } from "../io.ts";
import { CONNECT_FILE } from "./connect.ts";
import { json } from "./hook-settings.ts";

function sourceDrift(root: string, home: string) {
  try {
    const { workspace } = frozenPolicy({ root, home });
    return workspace && !workspace.ok ? workspace.detail : null;
  } catch (error) {
    return describeFailure(error);
  }
}

function lastPolicyCheck(
  home: string,
  connectFile: string,
  applied: Record<string, unknown>,
) {
  const folder = spoolFolder(home, connectFile, "policies");
  const last = json(join(folder, POLICY_CHECK_FILE));
  if (
    last?.revision === applied.workspace_revision &&
    last?.digest === applied.policy_digest &&
    typeof last?.at === "string" &&
    (last.state === "cached" ||
      last.state === "live" ||
      last.state === "unavailable")
  )
    return {
      state: last.state,
      at: last.at,
      detail: typeof last.detail === "string" ? last.detail : null,
    };
  return { state: "unchecked", at: null, detail: null } as const;
}

export function projectPolicyStatus(root: string, home: string) {
  const connectFile = join(root, CONNECT_FILE);
  const applied = json(connectFile);
  return {
    mode: applied?.enforce === "watch" ? "watch" : "on",
    source: sourceDrift(root, home),
    remote:
      applied?.decide === "cloud"
        ? lastPolicyCheck(home, connectFile, applied)
        : null,
  };
}
