# Examples

Unedited specsmith output, committed with the `generation.json` audit trail for
each run.

- **`taskhub/`** — `specsmith generate evals/specs/taskhub.json` (apiKey auth,
  enums, a 204 response). Compiled and passed 7/7 on the first attempt.
- **`uspto/`** — `specsmith generate evals/specs/uspto.json`. Shows the
  `application/x-www-form-urlencoded` body path: `client.ts` form-encodes the
  request with `URLSearchParams` and sends `Accept: application/json`. 3/3 on the
  first attempt.

Each was produced by:

```sh
specsmith generate evals/specs/<spec>.json -o examples/<spec> --provider claude-code
```

`generation.json` records the iteration trajectory (compile result + per-operation
request/response outcomes) and token usage for the run.
