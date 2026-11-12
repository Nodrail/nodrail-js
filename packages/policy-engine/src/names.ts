// No imports: the hooks bundle this, and it must stay small.

/**
 * How an agent is named in a run, in a dispatch's resource and in a gate:
 * lowercase, with anything but letters, digits, `_` and `-` made a `-`.
 * `vercel:deployment-expert` is `vercel-deployment-expert` everywhere.
 * So names that differ only in those characters, `team:qa` and `team-qa`,
 * are one agent to runs and gates; docs/runs.md says so.
 */
export function agentName(text: string) {
  const name = text
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[-_]+/, "")
    .slice(0, 63);
  return name || "unnamed";
}
