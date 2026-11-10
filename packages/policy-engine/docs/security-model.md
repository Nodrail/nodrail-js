# Security model

## What it guarantees

- The same rules, call and clock always give the same outcome.
- Deny beats review, and review beats allow, whatever order rules are in.
- A call no rule covers is never allowed.
- A parameter that is missing or of the wrong type never helps an allow rule.
- In the Claude Code hook, unreadable events, calls it can't describe, and rules it can't load are blocked.

## What it doesn't guarantee

**It decides; it doesn't enforce.** Something has to act on the answer. Calls that don't go through the hook or your code aren't seen.

**It is not a sandbox.** It does not isolate processes or restrict the network. An allowed program can do anything that program can do.

**It can be removed.** An agent that can edit its hook configuration, or run outside it, isn't bound by it. Protect the configuration with a deny rule, and with file permissions the agent doesn't hold.

**Shell commands are hard.** The engine doesn't run a full shell parser. It normalizes simple commands, and judges anything it can't reason about as a whole line. Allowed prefixes trust the program with its arguments, and the list of risky flags can't be complete. See [What a prefix trusts](commands-and-tools.md#what-a-prefix-trusts).

**Running the project's code trusts the agent with it.** Allowing `npm test` or `make` runs whatever the project's scripts say, and an agent that may edit files may also edit those scripts or the tests. Deny rules stop the agent doing something directly, not through code it wrote and then ran. The `repo-work` pack makes this trade; `read-only` doesn't.

**Declared facts are declared.** Conditions compare what the caller says. Agent names are not authenticated, and an allow doesn't prove that the action ran or what it did.

**Redaction is best effort.** It catches common credential shapes, not everything.

**Paths can change.** A path is judged when the call is checked. A symlink changed between the check and the action isn't caught.

## Reporting a vulnerability

See [SECURITY.md](../SECURITY.md).
