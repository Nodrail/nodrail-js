import { readFile } from "node:fs/promises";
import { simulate, type Descriptor } from "../src/index";

const descriptor: Descriptor = {
  agentId: "support-agent",
  installationId: "support-dev",
  toolKey: process.env.NODRAIL_TOOL ?? "github",
  operationKey: process.env.NODRAIL_OPERATION ?? "issues.read",
  resourceKind: "repository",
  resourceId: "acme/support",
  params: {},
};

const file = process.argv[2] ?? new URL("./policy.json", import.meta.url);
const document = JSON.parse(await readFile(file, "utf8"));
const result = simulate({
  document,
  descriptor,
  now: new Date("2026-11-09T12:00:00.000Z"),
});
console.log(JSON.stringify(result, null, 2));
