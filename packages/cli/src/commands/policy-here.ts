// The compiled policy `nodrail evidence` and `nodrail budgets` read: the
// project's locked policy (as `nodrail policy export --frozen` gives it), or
// one rule file with `--policy`. Offline, from files only.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { PolicyDocument } from "@nodrail/policy-engine";
import { compilePolicies } from "@nodrail/policy-engine/yaml";
import { CliError } from "../io.ts";
import { frozenPolicy } from "./project.ts";

export function policyHere(input: {
  cwd: string;
  home: string;
  policy?: string;
}): PolicyDocument {
  const { cwd, home } = input;
  const name = input.policy ?? "the locked policy";
  const text = input.policy
    ? readFileSync(resolve(cwd, input.policy), "utf8")
    : frozenPolicy({ root: cwd, home }).text;
  const compiled = compilePolicies([{ name, text }]);
  if (!compiled.ok)
    throw new CliError(
      `${name} doesn't compile: ${compiled.issues.map((issue) => issue.message).join("; ")}`,
    );
  return compiled.document;
}
