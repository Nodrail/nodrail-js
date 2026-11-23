# Examples

| Path                         | What it shows                                                      |
| ---------------------------- | ------------------------------------------------------------------ |
| `rules/`                     | Layered rule files: shared rules, commands, and one team's changes |
| `cases.yaml`                 | Expected outcomes for those rules                                  |
| `policy.json`, `simulate.ts` | Evaluating a compiled document from TypeScript                     |
| `custom-harness/`            | The custom harness from the library guide, with its expected cases |

```sh
nodrail-policy validate examples/rules
nodrail-policy test examples/rules --cases examples/cases.yaml
```

From a clone of the repository, `pnpm simulate` returns `allow`, and so does `NODRAIL_OPERATION=issues.update`. With `NODRAIL_OPERATION=repository.delete` it returns `deny`, and with an operation no rule covers it returns `none`, which is blocked. Nothing here calls a tool.

`node examples/custom-harness/demo.mjs` prints `allow deny [ 'inspect' ]`: the denied operation never reaches the in-memory tool. `nodrail-policy test examples/custom-harness/rules.yaml --cases examples/custom-harness/cases.yaml` checks the allowed, denied and unmatched cases.
