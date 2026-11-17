import type { Preview } from "../api.ts";
import type { Command } from "../context.ts";
import { lineDiff } from "../diff.ts";
import { CliError, confirm, UsageError } from "../io.ts";

export async function pullRules(command: Command, file?: string) {
  const rules = await (await command.api()).rules();
  if (!file) {
    command.print(rules, () => rules.yaml.replace(/\n$/, ""));
    return;
  }
  await command.io.writeFile(file, rules.yaml);
  command.print(
    { ...rules, file },
    () => `Wrote ${rules.environment} rules to ${file}.`,
  );
}

const located = (issue: Preview["issues"][number]) =>
  `  line ${issue.line}:${issue.column} ${issue.message}`;

function previewText(preview: Preview) {
  const lines: string[] = [];
  if (preview.issues.length)
    lines.push("Problems:", ...preview.issues.map(located));
  if (preview.warnings.length)
    lines.push("Warnings:", ...preview.warnings.map(located));
  for (const [label, names] of [
    ["Added", preview.added],
    ["Changed", preview.changed],
    ["Removed", preview.removed],
  ] as const)
    if (names.length) lines.push(`${label}:`, ...names.map((n) => `  ${n}`));
  lines.push(
    `${preview.added.length} added, ${preview.changed.length} changed, ${preview.removed.length} removed, ${preview.unchanged} unchanged (from revision ${preview.policy_revision}).`,
  );
  return lines.join("\n");
}

const nothingChanges = (preview: Preview) =>
  !preview.added.length && !preview.changed.length && !preview.removed.length;

/** Preview, show what changes, ask, then publish exactly what was previewed. */
export async function pushRules(command: Command, file?: string) {
  if (!file) throw new UsageError("Missing the rules file to push.");
  const { io, values } = command;
  if (!values.yes && !io.interactive)
    throw new UsageError(
      "Publishing needs a person to confirm. Run it at a terminal, or pass --yes.",
    );
  const yaml = await io.readFile(file);
  const api = await command.api();
  const [current, preview] = [await api.rules(), await api.previewRules(yaml)];
  const diff = lineDiff(current.yaml, yaml);
  if (diff.length) command.say(diff.join("\n"));
  command.say(previewText(preview));
  if (preview.issues.length)
    throw new CliError("The file has problems; nothing was published.");
  if (nothingChanges(preview)) {
    command.print({ preview, published: null }, () => "Nothing to publish.");
    return;
  }
  if (!values.yes && !(await confirm(io, `Publish to ${current.environment}?`)))
    throw new CliError("Nothing was published.");
  const published = await api.publishRules(yaml, preview);
  command.print(
    { preview, published },
    () =>
      `Published revision ${published.policy_revision}.` +
      (published.closed_requests
        ? ` ${published.closed_requests} waiting request(s) were closed.`
        : ""),
  );
}

export async function rules(command: Command) {
  const [action, file, extra] = command.args;
  if (extra !== undefined) throw new UsageError(`Unexpected "${extra}".`);
  if (action === "pull") return pullRules(command, file);
  if (action === "push") return pushRules(command, file);
  throw new UsageError(
    "Use `nodrail rules pull [file]` or `nodrail rules push <file>`.",
  );
}
