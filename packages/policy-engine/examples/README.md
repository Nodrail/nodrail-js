# Examples

| Path                         | What it shows                                                      |
| ---------------------------- | ------------------------------------------------------------------ |
| `rules/`                     | Layered rule files: shared rules, commands, and one team's changes |
| `cases.yaml`                 | Expected outcomes for those rules                                  |
| `policy.json`, `simulate.ts` | Evaluating a compiled document from TypeScript                     |

```sh
nodrail-policy validate examples/rules
nodrail-policy test examples/rules --cases examples/cases.yaml
```

From a clone of the repository, `pnpm simulate` returns `allow`. With `NODRAIL_OPERATION=issues.update` it returns `require_approval`, and with `NODRAIL_OPERATION=repository.delete` it returns `deny`. Nothing here calls a tool.
