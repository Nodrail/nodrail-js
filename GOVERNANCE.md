# Governance

Nodrail's open-source repositories are maintained by Nodrail. Today that is
one maintainer, the `@Nodrail/maintainers` team.

## How decisions are made

- Changes arrive as pull requests. CI, CodeQL, dependency review and a workflow
  audit must pass before anything merges.
- Anything that changes how rules are judged, or what is sent to Nodrail, starts
  as an issue so it can be discussed in the open.
- Security reports are handled privately, as `SECURITY.md` describes.

## What one maintainer means

There is no second reviewer yet, so pull requests don't wait for an approval,
and organization admins can bypass the branch rules in an emergency. Releases
still need the maintainer's two-factor approval on npm, so a compromised
workflow alone can't publish.

When a second maintainer joins, every pull request will need one approval from
someone other than its author, and admin bypass will be removed. We'd welcome
regular contributors becoming maintainers; open an issue to talk about it.

## Where the code comes from

These repositories are generated from Nodrail's private monorepo, which is also
where the hosted service lives. Accepted pull requests are applied there and
come back here through a pull request from the sync. Your authorship is kept in
the changelog and release notes.
