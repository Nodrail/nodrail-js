import { canonicalOrigin } from "./control-plane-origin.ts";
import { homedir } from "node:os";
import { controlPlaneUrl } from "./connect-schema.ts";
import type { HookConnection } from "./hook-connection.ts";
import { readHostCredential } from "./host-credentials.ts";
import { secretValue } from "./secret-refs.ts";

type Environment = Record<string, string | undefined>;

export function controlPlaneOrigin(url: string) {
  const origin = canonicalOrigin(url);
  return controlPlaneUrl.parse(origin);
}

export async function hookCredential(
  settings: Extract<HookConnection, { decide: "cloud" }>,
  env: Environment,
  home = homedir(),
) {
  const origin = controlPlaneOrigin(settings.url);
  if (settings.credential) {
    if (!env.NODRAIL_URL || controlPlaneOrigin(env.NODRAIL_URL) !== origin)
      throw new Error(
        "Pair NODRAIL_URL with the credential referenced by connect.credential",
      );
    return secretValue(settings.credential, env);
  }
  const projectId = settings.project_id;
  const stored =
    projectId &&
    (await readHostCredential(home, {
      origin,
      projectId,
      workspace: settings.workspace,
      environment: settings.environment,
    }));
  if (!stored || stored.origin !== origin)
    throw new Error(
      "This machine isn't enrolled for the project. Run nodrail apply",
    );
  return stored.credential;
}
