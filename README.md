# specsmith

**An LLM agent that forges typed TypeScript clients from OpenAPI specs — and proves it with evals.**

specsmith reads an OpenAPI 3.x spec and generates a fully typed, runtime-validated
TypeScript client (zod schemas + a fetch-based `ApiClient`). What makes it an *agent*
rather than a code generator: it **self-corrects against real responses**. The
generated client is compiled, then exercised operation-by-operation against a
spec-faithful mock server; compiler errors and request/response conformance failures
are fed back to the model until the client actually works.

And because "an LLM wrote it" means nothing without measurement, specsmith ships an
**eval harness** that scores every stage of generation across a suite of specs —
compile rate, operation coverage, request correctness, response-decode accuracy,
type fidelity against a deterministic ground truth, and the **lift delivered by
self-correction**.

```
 spec.yaml ──▶ IR ──▶ [LLM: schemas.ts] ──▶ [LLM: client.ts] ──▶ repair loop ──▶ client/
                │                                                   ▲
                │            tsc typecheck ── errors ───────────────┤
                └─▶ Prism mock ◀── exercise every operation ── failures
```

## Results

`specsmith eval`, six specs from easy CRUD to `oneOf`/discriminator with mixed
auth, generated with `claude-opus-4-8` (full report:
[`evals/results/run-2026-06-16/report.md`](evals/results/run-2026-06-16/report.md)):

| Spec | Tier | Ops | Compiles | Coverage | Requests OK | Responses OK | Type fidelity | Iters |
| --- | --- | ---: | :---: | ---: | ---: | ---: | ---: | ---: |
| petstore | hard | 19 | ✅ | 100% | 100% | 100% | 100% | 1 |
| petstore-expanded | easy | 4 | ✅ | 100% | 100% | 100% | 100% | 1 |
| uspto | medium | 3 | ✅ | 100% | 100% | 100% | 100% | 1 |
| taskhub | easy | 7 | ✅ | 100% | 100% | 100% | 100% | 1 |
| ledgerly | medium | 12 | ✅ | 100% | 100% | 100% | 100% | 1 |
| polyform | hard | 14 | ✅ | 100% | 100% | 100% | 100% | 1 |

All 59 operations across the suite compile, are callable, build spec-valid
requests, decode through the generated zod schemas, and match the
`openapi-typescript` ground-truth types — on the first attempt.

### The self-correction loop is what got there

The clean sweep above is the *result* of the loop and an adversarial review, not
evidence the loop is idle. An **earlier run on the same harness, before the
generated-client contract was hardened**
([`run-2026-06-12`](evals/results/run-2026-06-12/report.md)), shows it working:

| Spec | iter 0 responses OK | after self-correction | what happened |
| --- | ---: | ---: | --- |
| ledgerly | 0% | **100%** | first client didn't compile; compile feedback fixed it, then it passed |
| petstore | 63% | **100%** | runtime feedback fixed the operations the mock rejected |
| uspto | 67% | 67% (plateau) | **surfaced a contract bug**: form-urlencoded bodies were being JSON-encoded |

That plateau is the point: the harness didn't just score the client, it
**localized a bug the generator could not fix within its own contract**. The
[adversarial review](docs/REVIEW.md) confirmed it (and 11 other high-severity
issues, including metric-integrity bugs that would have *overstated* quality),
the contract was fixed to encode form/raw bodies correctly, and the same specs
now pass in one shot. The eval harness is the instrument that found the bugs —
which is the whole reason to build one.

The loop's mechanics are also pinned by an LLM-free integration test
(`test/integration/repair-loop.test.ts`): a scripted provider returns a
compile-broken client, and the test asserts the loop repairs it and exercises
the fix to all-green against a real Prism mock.

### Model-capability ablation

The same suite and harness run on `claude-haiku-4-5`
([`run-2026-06-16-haiku`](evals/results/run-2026-06-16-haiku/report.md)) shows
the harness discriminating model capability — and the loop firing where the
weaker model needs it:

| | petstore | petstore-expanded | uspto | taskhub | ledgerly | polyform | mean |
| --- | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| Opus 4.8 — responses OK | 100% | 100% | 100% | 100% | 100% | 100% | **100%** |
| Haiku 4.5 — responses OK | 100% | 100% | 100% | 86% | 75% | 86% | **91%** |
| Haiku 4.5 — iterations | 1 | 1 | 1 | 2 | 2 | 2 | |

Every Haiku client still **compiles** and scores **100% type fidelity** — the
type-level generation is solid across both tiers; it's runtime request-building
on the harder specs (pagination, mixed auth, discriminated unions) that Haiku
gets wrong. On exactly those three specs the loop spends a second iteration
attempting a repair and then the no-improvement rule stops it cleanly, keeping
the best file set rather than thrashing. That spread — 100% vs 91%, concentrated
on the structurally hard specs — is the kind of signal an eval is *for*: it
tells you the loop is load-bearing and where, instead of a single pass/fail.

## How the self-correction loop works

1. **Normalize** — the spec is parsed, validated, and dereferenced
   (`@apidevtools/swagger-parser`), then lowered to a compact IR: operations with
   parameter/body/response schemas, auth schemes, and deterministic method names.
2. **Generate** — two LLM calls: one emits `schemas.ts` (a zod schema + inferred
   type per named component schema), one emits `client.ts` (an `ApiClient` with one
   typed method per operation), against a strict 22-rule generated-client contract.
3. **Verify, don't trust** —
   - the TypeScript compiler API typechecks the output under `strict`;
   - [Stoplight Prism](https://github.com/stoplightio/prism) boots a mock of the
     spec in `--errors` mode, which **rejects requests that violate the spec**
     (wrong path/params/body/auth) and serves spec-conformant responses;
   - the exerciser calls **every operation** through the generated client with
     deterministically sampled inputs, classifying each failure: request rejected
     by the spec (client built it wrong) vs. response failing the generated zod
     schema (client validates it wrong).
4. **Repair** — failures are rendered into compact, actionable feedback (compiler
   diagnostics, Prism violation reports, zod issues + the relevant IR fragments)
   and sent back to the model, which returns corrected files. The loop keeps the
   best-scoring file set and stops on success, exhaustion, or no improvement.

## Eval methodology

Each spec in `evals/specs/manifest.json` runs through the full pipeline; metrics
are computed from the final kept file set (`src/eval/metrics.ts`):

| Metric | Definition |
| --- | --- |
| **Compiles** | final client passes `tsc --strict` |
| **Coverage** | operations exposed as callable methods / operations in spec |
| **Requests OK** | operations whose request the spec-validating mock accepts |
| **Responses OK** | operations whose response parses through the generated zod schema |
| **Type fidelity** | named schemas whose generated type is *mutually assignable* with [`openapi-typescript`](https://github.com/openapi-ts/openapi-typescript) ground-truth types, checked by a compiler probe |
| **Iter0 → Final** | response-validation rate before vs. after self-correction — the value the loop adds |

The suite mixes three vendored real-world specs (Swagger Petstore, the classic
petstore-expanded example, USPTO Data Set API) with three authored feature-stress
specs (`taskhub`: CRUD + apiKey auth; `ledgerly`: cursor pagination, query-array
params, numeric constraints; `polyform`: `oneOf` + discriminator, `allOf`
composition, nullable fields, mixed auth). Every spec is verified to validate and
boot under Prism.

**Anti-gaming properties.** The mock is derived from the spec, not from the
generated code; request validation is done by Prism, not by the code under test;
type fidelity is checked against an independent deterministic generator; and the
exerciser invokes the client through its public surface only. The harness can
fail the agent in ways the agent cannot paper over.

## Quickstart

```sh
npm install

# Generate a client (uses ANTHROPIC_API_KEY; falls back to your local Claude Code CLI)
npx tsx src/cli.ts generate path/to/openapi.json -o out/
# → out/schemas.ts, out/client.ts, out/index.ts, out/generation.json

# Run the eval suite
npx tsx src/cli.ts eval --provider anthropic --model claude-opus-4-8
# → evals/results/<timestamp>/{results.json, report.md}
```

Using the generated client:

```ts
import { ApiClient } from "./out/index.js";

const client = new ApiClient({ baseUrl: "https://api.example.com", apiKey: "..." });
const { status, data } = await client.listTasks({ status: "open" });
// `data` is statically typed AND runtime-validated against the spec
```

Two LLM providers are built in (`src/llm/`):

- `anthropic` — the [`@anthropic-ai/sdk`](https://github.com/anthropics/anthropic-sdk-typescript)
  with streaming (default model `claude-opus-4-8`);
- `claude-code` — drives a locally authenticated [Claude Code](https://claude.com/claude-code)
  CLI headlessly (`claude -p --output-format json`), so the project runs without an API key.

## Project structure

```
src/
  ir/         spec loading + normalization to IR
  llm/        provider abstraction (Anthropic SDK, Claude Code CLI)
  agent/      prompt engineering + the generate/repair loop
  validate/   tsc typecheck, Prism mock lifecycle, operation exerciser, feedback rendering
  eval/       eval runner, metrics, type-fidelity probe, markdown report
  cli.ts      `specsmith generate` / `specsmith eval`
evals/specs/  the eval suite (3 vendored + 3 authored specs + manifest)
test/         134 LLM-free tests (unit + integration with a scripted FakeProvider and a real Prism mock)
examples/     unedited generated output, with its generation.json audit trail
```

## Design decisions

- **The mock is the referee.** Prism's `--errors` mode turns the spec into an
  executable oracle: malformed requests are rejected with machine-readable
  violation reports, which become high-signal repair feedback. No hand-written
  per-spec assertions anywhere.
- **Two-error-channel client contract.** Generated clients must throw `ApiError`
  (HTTP failure) and `ResponseValidationError` (zod failure) with stable `name`
  fields, so the exerciser can attribute failures across module boundaries
  without sharing classes.
- **Deterministic everything around the LLM.** Input sampling, IR normalization,
  prompt construction, and metrics are deterministic; the only stochastic
  component is the model. Iteration trajectories in `generation.json` make each
  run auditable.
- **No-improvement cutoff with best-set tracking.** A repair that doesn't beat
  the best (responsesOk, requestsOk) so far stops the loop and the best earlier
  file set is kept — the loop can't regress the output.
- **LLM-free CI.** The repair loop's integration test drives `generateClient`
  with a scripted fake provider (broken file → fixed file) against a real Prism
  mock, so loop mechanics are tested without tokens or network.

## Limitations

- OpenAPI 3.x only (Swagger 2.0 is rejected; convert first).
- Generation is single-shot per file — specs much beyond ~25 operations would
  need chunked generation (per-tag modules) to stay inside output limits.
- The exerciser sends one sampled input per operation; it proves conformance,
  not exhaustive behavioral coverage.
- Prism mocks can't validate semantics the spec doesn't encode (e.g.
  cross-field invariants), and occasionally can't produce a response for exotic
  content types — such 5xx mock gaps are explicitly not counted against the client.
- Type fidelity compares named component schemas only; anonymous inline types
  aren't probed.
- `Responses OK` counts schema-less and anonymous-schema responses as passing
  (there is nothing to validate against), so it is an upper bound on *validated*
  responses, not a claim that every response was checked.
- Parameter serialization styles (`style`/`explode`/`allowReserved`) and a few
  sampler constraints (`pattern`, `multipleOf`, `exclusiveMaximum`) aren't
  modeled. These and the other deferred review findings are tracked in
  [`docs/REVIEW.md`](docs/REVIEW.md) — including why each is low-impact for the
  current scope.

## Development

```sh
npm test            # 134 tests, no network/LLM needed (Prism runs on localhost)
npx tsc --noEmit    # strict typecheck
```

MIT © Tushar Shukla
