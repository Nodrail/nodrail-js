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

## Where the code comes from, and how your change ships

These repositories are generated from Nodrail's private monorepo, which also
holds the hosted service. Pull requests are welcome all the same, and here is
what happens to one:

1. A maintainer reviews it here, in the open, like any pull request.
2. When it's accepted, the maintainer applies it to the monorepo, with you as
   co-author, and runs the full checks there.
3. The next sync brings it back here as a commit that credits you with
   `Co-authored-by`, so it shows on your GitHub profile.
4. Your pull request is closed with a link to that commit, rather than merged.

Your change keeps your name all the way through, and it appears in the
changelog of the release that ships it.
