# Rules

This page is the reference for rule files: every field a rule can have, how resources and conditions match, and how files layer.

A rules file is a YAML list of `rule`, `list` and `macro` entries, plus `gate` and `budget` entries, which are described in [Runs, gates and budgets](runs.md). A `required_engine_version` entry says which engine level the file needs. Several files can be loaded in order, and later ones can change earlier ones.

```yaml
- required_engine_version: 1

- list: production_repositories
  items: [acme/payments, acme/infra]

- macro: large_amount
  condition:
    - { field: amount, op: gt, value: 1000 }

- rule: Review production writes
  desc: A person checks anything written to production.
  tool: github
  operation: issues.update
  resource: { kind: repository, list: production_repositories }
  effect: require_approval
  tags: [write]

- rule: Review large refunds
  tool: stripe
  operation: refunds.create
  resource: { kind: invoice, match: any }
  condition:
    - macro: large_amount
  effect: require_approval
```

## How a decision is made

Every matching rule counts, in any order. Deny beats `require_approval`, which beats allow. If no rule matches, the outcome is `none`, and whatever calls the engine must treat that as blocked.

## Rule fields

| Field                   | Meaning                                                                                        |
| ----------------------- | ---------------------------------------------------------------------------------------------- |
| `rule`                  | Unique name                                                                                    |
| `effect`                | `allow`, `require_approval` or `deny`                                                          |
| `tool`, `operation`     | The action, such as `github` and `issues.update`                                               |
| `resource`              | `kind` plus one of the forms below                                                             |
| `command`               | Instead of `tool`, `operation` and `resource`. See [Commands and tools](commands-and-tools.md) |
| `condition`             | Conditions that must all hold                                                                  |
| `agent`, `installation` | Limit the rule to one agent, or one installation of it                                         |
| `expires`               | ISO time when the rule stops applying                                                          |
| `enabled`               | `false` switches the rule off                                                                  |
| `id`                    | Keeps the rule's identity if it is renamed                                                     |
| `title`                 | A display name, when two rules need to share one                                               |
| `desc`, `tags`          | For people reading the file                                                                    |

### Resources

| Form                                                  | Matches                                                        |
| ----------------------------------------------------- | -------------------------------------------------------------- |
| `{ kind: repository, match: any }`                    | Anything of that kind                                          |
| `{ kind: repository, match: exact, value: acme/app }` | That value only                                                |
| `{ kind: repository, match: prefix, value: acme/ }`   | Values starting with that text                                 |
| `{ kind: repository, list: names }`                   | One exact rule per list item. Add `match: prefix` for prefixes |

A prefix is literal text, so `acme/support` also matches `acme/support-extra`. End it with `/` when you mean a folder. File paths are in the machine's own form, so on Windows a folder is `C:\repo\src\`.

### Conditions

```yaml
- rule: Small refunds
  tool: stripe
  operation: refunds.create
  resource: { kind: invoice, match: any }
  condition:
    - { field: amount, op: lte, value: 1000 }
    - { field: currency, op: in, value: [USD, EUR] }
  effect: allow
```

Operators: `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `in` and `contains`. `contains` tests whether an array has a value. `field` can reach into objects with dots.

Where a field lives depends on how the call was described. With `nodrail.run()` or `check()` it is the `params` you pass. A tool wrapped by `guard()` in [`@nodrail/client`](https://github.com/Nodrail/nodrail-js/tree/main/packages/client), or an MCP tool, carries its arguments under `input`, so the condition above reads `{ field: input.amount, op: lte, value: 1000 }`. File calls carry `path` and `path_parts`; see [Commands and tools](commands-and-tools.md).

An entry can also be `{ macro: name }`, or `{ field: currency, op: in, list: name }`.

`{ field: path_parts, op: contains, list: name }` matches when the array holds any item of the list. It compiles to one rule per item, so a rule can use it once. It needs `required_engine_version: 2`:

```yaml
- required_engine_version: 2

- list: secret_places
  items: [.env, .ssh, .aws]

- rule: Never read secrets
  tool: files
  operation: file.read
  resource: { kind: file, match: any }
  condition:
    - { field: path_parts, op: contains, list: secret_places }
  effect: deny
```

Conditions compare what the caller declares. A parameter that is missing or of the wrong type never helps an allow rule, while deny and review rules still apply. So `"5"` can't pass a rule that wants a number under 1000.

### Ids

Decisions name the rule that won by its id: `matchedRuleId` in a result, and the reason Claude Code shows. Without an `id`, the id is made from the name: lowercased, with anything but letters, digits, `_` and `-` turned into `-`, so `Never force push` is `never-force-push`. One rule can compile to several, and those get a suffix:

- A `command: { prefix: … }` rule is two: the exact command keeps the id, and the command with arguments adds `-args` (`never-force-push-args`).
- A rule over a list, or a condition with `contains` and a list, adds a short hash of each item.

Set `id` when other things refer to the rule, such as dashboards, tests or a reviewer's notes, so renaming it keeps the same id. Gates and budgets take `id` the same way.

## Lists and macros

A list is reusable values. A macro is reusable conditions, and can use other macros. They can be defined after the rules that use them. An empty list used by a rule is an error, so a list can't quietly remove a deny.

## Layering files

Files load in the order given, and a folder loads its `.yaml` and `.yml` files by name. To change something from an earlier file, use `override` and say how each field changes:

```yaml fragment
- list: production_repositories
  items: [acme/billing]
  override: { items: append }

- rule: Review large refunds
  effect: deny
  override: { effect: replace }

- rule: Small refunds
  enabled: false
  override: { enabled: replace }
```

Lists, conditions and tags can be appended to. Everything else is replaced. Gates layer the same way; a budget's fields can only be replaced.

Unlike Falco, redefining a name without `override` is an error, so a later file can't silently weaken a rule.

Conditions are structured YAML rather than an expression language, which makes them simple to validate and leaves nothing to inject into. There is no general `or`: write two rules, or use `contains` with a list.

## Limits

500 compiled rules, 20 conditions per rule, 1 MB per file. YAML aliases are limited, and duplicate keys are errors. Gates and budgets have [their own limits](runs.md#limits).

Files declare the engine level they need with `required_engine_version`. A file that needs a newer engine is refused. Level 1 is the base format, level 2 adds `contains` with a list, and level 3 adds gates and budgets and describes starting a subagent as an `agent` resource. See [Versions](runs.md#versions) for how this relates to the compiled document's version.
