# Evidence (engine level 5)

A gate can wait for **evidence**: the declared result of a check (tests, a QA pass, a scan) about the exact revision of the work. The grammar and the order of checks are the engine's ([`docs/contracts.md`](../../policy-engine/docs/contracts.md#evidence-requirements-enforced-engine-level-5), S05 on C01). This page covers the commands that produce evidence and what `plan` says about it.

```yaml
- required_engine_version: 5
- contracts:
    shapes:
      ci-result:
        properties:
          status: { values: [passed, failed], report: true }
          tests: { type: integer, min: 0, report: true }
    evidence:
      ci-tests:
        shape: ci-result
        producers:
          - { class: runtime-observed }
          - { class: externally-verified, verifier: github-actions }
        subject: revision
- gate: Tested before a push
  command: { prefix: git push }
  requires:
    - {
        evidence: ci-tests,
        authority: runtime-observed,
        subject: revision,
        where: { status: passed },
      }
  otherwise: deny
```

A requirement is met only by the latest event about **this** revision: the commit, the tracked changes and the untracked files. An old result never opens a gate for new work, and passing a gate never allows what no rule allows.

## Who produces it

| Producer              | Command                                                     | Where it is kept                                                               | What it can satisfy                                                   |
| --------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| `runtime-observed`    | `nodrail evidence run <name> -- <command>`, on this machine | the ledger folder (`.git/nodrail/runs/evidence/<name>.jsonl`), never committed | local gates asking for `runtime-observed` or less; never a control-plane gate |
| `externally-verified` | `nodrail evidence submit <name>` in a GitHub Actions job    | The control plane, checked against a verifier                                              | every authority, local (the hook asks the control plane) and the control plane                |

A URL, a provider name or an exit code in the payload proves nothing: who produced the evidence is the runtime's or the verifier's to say, never the value's.

## `nodrail evidence run <name> -- <command>`

Runs a check and records what it observed:

1. Reads the work's revision.
2. Runs the command with `NODRAIL_EVIDENCE_OUT` set to a temporary file. The command writes its result there as one JSON object (16 KiB at most).
3. Reads the revision again. If it changed while the command ran, the subject is unknown (`null`): the result is about neither revision and never meets a requirement.
4. Validates the result against the evidence's pinned contract and appends the event.

Pass the executable and its arguments after `--`. Windows package-manager
launchers such as `npm.cmd` also work. To use pipes or redirects inside the
check, name the shell explicitly, as in the example below.

| What the command did                                     | Recorded state                                         |
| -------------------------------------------------------- | ------------------------------------------------------ |
| Wrote a value that follows the contract                  | `valid`, with the value (kept on this machine only)    |
| Wrote something that doesn't                             | `invalid`, with the paths and codes, without the value |
| Wrote nothing (or an empty file), whatever its exit code | `missing`                                              |

The command's exit code is recorded but is never a value: a check that exits 0 without writing a result is `missing`. `evidence run` exits with the command's own code when that isn't 0, 1 when the result is `missing` or `invalid`, and 0 otherwise.

```sh
nodrail evidence run ci-tests -- sh -c 'npm test && echo "{\"status\":\"passed\",\"tests\":$(cat .count)}" > "$NODRAIL_EVIDENCE_OUT"'
```

**Only a person runs it.** Local runtime-observed evidence is worth something only if agents can't make it up, so a gate that reads it needs the **setup guard**: the policy hook with the protect list, which refuses `nodrail` run by an agent. With the protect list, the hook also checks each call for writes to the run ledger (`.git/nodrail`, or `NODRAIL_LEDGER` when set), all of `.git`, and the setup's folders (`.nodrail`, `.claude`, …). It checks:

- file tools (Write, Edit, a patch) on a path there: denied;
- the words of a shell command, as written and as the shell joins quoted pieces (`".git/nod""rail/…"`): a command naming a path there is denied, and so is a wildcard that could match one, by its pattern or by what it matches on disk now (`.gi?/…`, `sub/g*` through a link to `.git`);
- a link (`ln`, `link`, `cp -s`) whose target is a protected folder, inside one or above one (`..`, the project folder): denied. A line that makes a link and runs anything after it is judged whole, as a compound command;
- a recursive copy, move or sync (`cp -r`, `mv`, `install`, `ditto`, `rsync -a`) into a protected folder: denied. Into a folder that holds one, such as the project folder, it is denied only when it would create or overwrite one: a source named like it (`cp -r sub/fake/.claude .`), or a contents copy (`SRC/.`, `SRC/*`, rsync's `SRC/`) whose source holds such a name or can't be read, and always when another part of the same line runs before it (`… && cp -R sub/x/. ./`), since that part can change the source first. `cp -r sub/deep .` and `mkdir -p dist && rsync -a src/ dist/` are left to the rules. Archives can't be read from the line, so `tar -x` and `unzip` into such a folder are denied unless `-C`/`-d` points elsewhere.

Git itself changes `.git` as usual: `git commit` names no path there.

**This is a control, not a sandbox.** Reading shell commands is best effort: a path built when the command runs (a variable, `$(…)`, `eval`, a script, a program that writes files on its own) isn't seen. A rule that allows compound commands, or a program that runs arbitrary code (`npm test`, `make`, an interpreter), can write the ledger. So can `git apply` or `patch` with a patch the agent wrote: the files it creates (`.claude/settings.local.json`, say) are in the patch, not on the command line. Don't allow them beyond exact rules if you need the guarantee. Where local evidence must hold, don't allow write-capable shell commands beyond exact ones, or run the agent in a sandbox. The machine's owner is never constrained (below).

`plan` fails activation when the guard isn't on (for example a settings file that sets `disableAllHooks`): "runtime-observed evidence needs the setup guard". There is no command that records evidence from a file.

**The trust boundary.** Local evidence is protected from the agent by the hook, not from the machine's owner: the ledger is a plain file the person can edit, as are the run and budget records ([runs](../../policy-engine/docs/runs.md), [budgets](budgets.md)). It proves what ran on this machine to the people who trust this machine, not attestation to anyone else. For evidence that holds beyond it, require `authority: externally-verified` from a verifier (below).

`--policy <file>` reads one rule file instead of the project's locked policy.

## `nodrail evidence show <name>`

The events recorded here, newest first (state, subject, exit code, contract), whether each is about the current revision, and for each gate requirement reading it whether it is met here now, with the engine's explanation when it isn't. `--json` prints the events, values included: they are this machine's.

## `nodrail evidence submit <name> --result <file>`

From a GitHub Actions job, sends a result to the control plane as externally verified evidence:

```yaml
permissions:
  id-token: write
  contents: read
steps:
  - uses: actions/checkout@v4
  - run: npm test -- --json > result.json
  - run: npx @nodrail/cli evidence submit ci-tests --result result.json --workspace "$NODRAIL_WORKSPACE" -e production
    env:
      NODRAIL_WORKSPACE: ${{ vars.NODRAIL_WORKSPACE }}
```

- The job asks GitHub for an OIDC token whose audience is `<Nodrail URL>/w/<workspace>` (`ACTIONS_ID_TOKEN_REQUEST_URL` and `ACTIONS_ID_TOKEN_REQUEST_TOKEN`, which `id-token: write` provides), and posts `{ workspace, environment, evidence, event_key, commit, contract, value }` to `POST /api/v1/evidence` with it. No Nodrail token is involved, and personal tokens can't submit evidence.
- The control plane accepts it only from a **verifier** an admin created (Settings → Verifiers): the repository and the exact `job_workflow_ref`, ideally a reusable workflow on a protected branch. The commit must be the token's `sha`; the control plane computes the subject from it, so the evidence matches a local work tree that is clean at exactly that commit.
- Use `push` or `workflow_dispatch` runs: a `pull_request` run builds a merge commit, which never matches a local head, and the control plane refuses it.
- `commit` is `GITHUB_SHA`, else `HEAD`. `contract` is the evidence's digest in the locked policy; the control plane refuses a value validated against another revision of the contract. `--key` tells apart several events of one evidence in one run (default `default`).
- Retries send the same body, which the control plane answers idempotently. Exit codes: **0** stored (valid or invalid), **3** refused (the code is printed, for example `producer-not-allowed`), **4** the control plane not reached after three attempts.

Without Node, the same with curl:

```sh
JWT=$(curl -sS -H "Authorization: Bearer $ACTIONS_ID_TOKEN_REQUEST_TOKEN" \
  "$ACTIONS_ID_TOKEN_REQUEST_URL&audience=https://app.nodrail.com/w/$NODRAIL_WORKSPACE" | jq -r .value)
curl -sS -X POST https://app.nodrail.com/api/v1/evidence \
  -H "Authorization: Bearer $JWT" -H 'content-type: application/json' \
  -d "{\"workspace\":\"$NODRAIL_WORKSPACE\",\"environment\":\"production\",\"evidence\":\"ci-tests\",\"commit\":\"$GITHUB_SHA\",\"contract\":\"sha256:…\",\"value\":$(cat result.json)}"
```

## How the local hook reads externally verified evidence

When a gate reads evidence a verifier produces, `apply` writes `.nodrail/evidence.json` (`{ url, workspace_revision }`: the Nodrail URL and the lock's workspace revision) and gives the hook `--evidence` with it. For a call that a gate covers and local evidence doesn't meet, the hook asks the control plane `GET /api/v1/evidence/status` by gate id, requirement index and subject, never with a condition of its own, and waits at most 3 seconds. It sends the person's token from `NODRAIL_TOKEN` (the `read` scope) in the host's environment.

- The revision asked about must be published: `nodrail workspace publish`.
- Offline, unpublished, a token without `read`, a timeout or an error leave the requirement unmet, with the reason. A positive answer is cached for 5 minutes per requirement and subject.
- Copilot's hook reads local evidence only.

## What `plan` and `contracts explain` say

`plan` lists each evidence requirement: its gate, authority, producers and where it is read here, and fails activation when:

- a requirement reads runtime-observed evidence and the setup guard isn't on;
- a verifier it depends on is missing or revoked (`verifier-missing`). `plan` checks verifiers with the control plane when it has a token for it (`NODRAIL_TOKEN` or `nodrail login`); without one it marks the check `?`, and the control plane checks again when the workspace is published.

`nodrail contracts explain <gate>` lists the same per requirement, with its `where` conditions; `contracts explain evidence:<name>` lists the evidence's producers.
