import type { ProposedProject } from "../project/project.ts";
import type { Command } from "../context.ts";
import { credentialChecks } from "./connect.ts";
import { livePolicy } from "./connect-policy.ts";
import { secretChecks } from "./connections.ts";
import type { SetupPlan } from "./plan.ts";
import { verifierChecks } from "./verifiers.ts";

export async function checkSetup(
  command: Command,
  root: string,
  plan: SetupPlan,
  proposed?: ProposedProject,
) {
  const { io } = command;
  plan.checks.push(...secretChecks(plan, io.env));
  const policy = await livePolicy(plan, io, root, {
    replaceLive: command.values["replace-live"] ?? false,
    proposedLock: proposed?.lock,
  });
  plan.checks.push(...policy.checks);
  plan.remoteChanges = policy.changes;
  plan.checks.push(...(await credentialChecks(plan, io.env, io.fetch)));
  if (plan.connect?.decide !== "cloud")
    plan.checks.push(
      ...(await verifierChecks(
        { ...command, api: () => command.api(root) },
        plan,
      )),
    );
  return policy;
}
