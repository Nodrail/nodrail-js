import { visible, type ActivityEvent, type Me, type Run } from "./api.ts";

function windowsCommandWord(text: string): string {
  if (/[\r\n]/.test(text)) return JSON.stringify(text);
  if (text && !/[\s"]/.test(text)) return text;

  // Windows doubles backslashes before a closing quote or an escaped quote.
  const quoted = text.replace(/\\+$/, "$&$&").replace(/(\\*)"/g, '$1$1\\"');
  return '"' + quoted + '"';
}

/** Command and arguments for display in a plan. */
export function commandForDisplay(
  words: string[],
  platform = process.platform,
) {
  const word =
    platform === "win32"
      ? windowsCommandWord
      : (text: string) =>
          /^[A-Za-z0-9._/:=@%+,-]+$/.test(text) ? text : JSON.stringify(text);
  return words.map(word).join(" ");
}

/** Columns padded to their widest cell; the last column is never padded. */
export function table(cells: string[][]): string {
  const rows = cells.map((row) => row.map(visible));
  const widths: number[] = [];
  for (const row of rows)
    row.forEach((cell, index) => {
      widths[index] = Math.max(widths[index] ?? 0, cell.length);
    });
  return rows
    .map((row) =>
      row
        .map((cell, index) =>
          index === row.length - 1 ? cell : cell.padEnd(widths[index]!),
        )
        .join("  "),
    )
    .join("\n");
}

/** "in 12m", "3m ago". */
export function relative(iso: string, now = Date.now()) {
  const minutes = Math.round((Date.parse(iso) - now) / 60_000);
  const span = Math.abs(minutes);
  const amount =
    span < 60
      ? `${span}m`
      : span < 48 * 60
        ? `${Math.round(span / 60)}h`
        : `${Math.round(span / 1440)}d`;
  return minutes >= 0 ? `in ${amount}` : `${amount} ago`;
}

export const operation = (item: { tool_key: string; operation_key: string }) =>
  `${item.tool_key}.${item.operation_key}`;

export function actorOf(event: ActivityEvent) {
  const { actor } = event;
  const name =
    actor.kind === "human"
      ? (actor.name ?? "A former member")
      : actor.kind === "runtime"
        ? "Agent integration"
        : "Nodrail";
  return actor.via ? `${name} via API token ${actor.via}` : name;
}

export function activityTable(items: ActivityEvent[]) {
  if (items.length === 0) return "No activity matches.";
  return table([
    ["WHEN", "OUTCOME", "WHAT", "AGENT", "BY", "ID"],
    ...items.map((event) => [
      event.occurred_at,
      event.label,
      event.action
        ? `${operation(event.action)} ${event.action.resource}`
        : (event.subject ?? ""),
      event.agent_key ?? "",
      actorOf(event),
      event.id,
    ]),
  ]);
}

export function runsTable(items: Run[]) {
  if (items.length === 0) return "No runs match.";
  return table([
    ["ID", "KEY", "AGENT", "STATUS", "STEPS", "ACTIONS", "LAST ACTIVITY"],
    ...items.map((run) => [
      run.id,
      run.key,
      run.agent_key ?? "",
      run.status,
      String(run.steps),
      String(run.actions),
      run.last_activity_at,
    ]),
  ]);
}

export function whoami(me: Me, url: string) {
  const can =
    me.effective_scopes ??
    Object.entries(me.can)
      .filter(([, allowed]) => allowed)
      .map(([name]) => name.replace("_", ":"));
  return [
    `${visible(me.person.name)} in ${visible(me.workspace.name)} (${me.workspace.slug}) as ${me.role}`,
    `Token        ${visible(me.token.name)} (${me.token.prefix}…)`,
    `Scopes       ${me.token.scopes.join(", ")}`,
    `Can now      ${can.join(", ") || "nothing"}`,
    `Expires      ${me.token.expires_at ?? "never"}`,
    `Environments ${me.environments
      .map((env) => (env.default ? `${env.slug} (default)` : env.slug))
      .join(", ")}`,
    `Nodrail      ${url}`,
  ].join("\n");
}
