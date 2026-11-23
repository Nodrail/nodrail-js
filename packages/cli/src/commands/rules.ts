import { ApiError, type NodrailApi, type Preview } from "../api.ts";
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

/**
 * The live rules as a file, or `yaml: null` when Cloud can't show them as
 * one (`VERSION_NOT_RENDERABLE`, engine level 5): pushing a new file over
 * them still works, without the line diff.
 */
async function liveRules(api: NodrailApi, environment: string | undefined) {
  try {
    return await api.rules();
  } catch (error) {
    if (!(error instanceof ApiError) || error.code !== "VERSION_NOT_RENDERABLE")
      throw error;
    return {
      environment: environment ?? "the default environment",
      yaml: null,
    };
  }
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
  const [current, preview] = [
    await liveRules(api, values.environment),
    await api.previewRules(yaml),
  ];
  if (current.yaml === null)
    command.say(
      "The live rules can't be shown as a file (engine level 5), so there is no line diff; the preview below says what changes.",
    );
  const diff = current.yaml === null ? [] : lineDiff(current.yaml, yaml);
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
    () => `Published revision ${published.policy_revision}.`,
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
