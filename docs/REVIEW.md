# Adversarial review

specsmith was built with the modules implemented in parallel against a fixed
contract (`ARCHITECTURE.md` + `src/types.ts`), then put through a multi-agent
adversarial review: independent reviewers swept five dimensions (the repair
loop, the validation layer, IR normalization, **metric integrity**, and the
provider/CLI surface) and produced findings, and a separate set of verifier
agents tried to *refute* each finding by tracing call sites and reproducing the
misbehavior. Only findings that survived refutation were acted on.

56 findings were confirmed (12 high, 21 medium, 23 low). This document records
what was fixed and what was deliberately deferred, because for an eval-driven
project the honest accounting *is* part of the deliverable: a metric that
overstates quality is the worst possible bug, and the review was aimed squarely
at finding those.

## Fixed (all 12 high-severity findings + the load-bearing mediums)

**Eval-integrity bugs — the ones that would have made the headline numbers lie:**

- **Metrics read a discarded iteration.** When the repair loop fell back to an
  earlier, better file set (the no-improvement rule), `GenerationResult` still
  ended with the *worse* last iteration record, and metrics/CLI/report all read
  that last record. A regressing repair therefore *under-reported* the delivered
  client, and a provider error on the final round could mark a working client as
  `compiled: false`. Fixed by adding `finalCompile`/`finalExercise` to
  `GenerationResult` describing the file set actually returned; all consumers now
  read those.
- **Static coverage overcounted.** The no-exercise coverage fallback used bare
  substring matching, so `getPets` was credited by `getPetsPetId`, comments and
  `searchParams.get(` counted as method definitions, and a *non-compiling*
  client could score 100% coverage next to "Compiles ❌". Fixed with an anchored
  per-method regex, and coverage is now 0 for a client that didn't compile.
- **Type fidelity passed vacuously on `any`.** `z.any()` infers `any`, which is
  mutually assignable with every ground-truth type — exactly what an LLM emits
  for hard schemas, and it would have scored 100% fidelity. Added a
  `0 extends (1 & T)` not-`any` guard per schema to the compiler probe.

**Client-correctness bugs — the ones that permanently failed real operations:**

- **Non-JSON request bodies.** The contract forced `JSON.stringify` for every
  body, so `application/x-www-form-urlencoded` operations (e.g. USPTO's search)
  got a JSON string with a form content-type and were rejected by the
  spec-validating mock forever — a harness/contract gap scored as a client bug.
  The IR now carries a `json | form | raw` encoding discriminator and the
  contract has one serialization rule per encoding (`URLSearchParams` for form).
  USPTO went from a permanent 2/3 to 3/3 on the first attempt.
- **Auth header collision.** The exerciser configured the client with bearer
  *and* basic credentials simultaneously; both target the `Authorization`
  header, so one clobbered the other and bearer-secured specs randomly 401'd.
  Credentials are now filtered to the schemes the spec actually declares.
- **Circular `$ref` schemas were nuked.** Any request/response schema referencing
  a recursive component collapsed to `{}`, permanently failing the request and
  zeroing fidelity. Circular refs are now inlined one level (the inner
  self-reference collapses), which also restores their named-schema validation.

**Robustness:**

- Scratch/eval work dirs and the Prism bin are resolved from the package root,
  not `process.cwd()` — generation works when the CLI is run from anywhere.
- `@stoplight/prism-cli` and `openapi-typescript` moved to runtime dependencies
  (the self-correction loop and fidelity probe need them at runtime).
- Mock boot is retried on transient port/boot races, with a spawn-error listener.
- Repair loop: `index.ts` is re-pinned after every merge; an iteration-0 parse
  failure regenerates the missing file via its full build prompt instead of a
  spec-less repair prompt; a provider error is recorded without faking a compile
  failure; `parseFiles` no longer leaks a trailing fence + prose into file
  content; `operationId` is deduped alongside `methodName`.
- The sampler honors `minItems`/`maxItems` and normalizes OpenAPI 3.1 type
  arrays (`["string","null"]` → nullable `string`).

## Deferred (documented, not yet fixed)

These are real but low-impact for the current scope; they are tracked rather than
silently ignored:

- **Non-identifier component names** (`Error-Response`) would make the demanded
  `export const Error-ResponseSchema` uncompilable. No spec in the suite triggers
  it; a proper fix needs a name-mapping layer between spec names and TS
  identifiers.
- **Parameter serialization styles** (`style`/`explode`/`allowReserved`,
  `content`-encoded params) are not modeled — query arrays use the common
  repeated-key form only.
- **Vacuous response passes are not surfaced separately.** Operations with no
  response schema, anonymous (`z.unknown()`) schemas, or a Prism 5xx mock-gap
  count toward `responseValidationRate` without being distinguished in the
  results. The rate is therefore an upper bound on *validated* responses; a
  future version should report "validated / total / unvalidated" explicitly.
- **Sampler edge constraints** (`exclusiveMaximum`, `multipleOf`, string
  `pattern`) are not honored, so a pattern-constrained parameter can produce a
  sample the mock rejects.
- **Provider truncation** (`stop_reason: "max_tokens"`) is not surfaced; a
  cut-off file is left for the compile-repair round to catch.
- **Scratch dirs** under `.specsmith-work/` are not garbage-collected, and the
  default eval output directory has minute resolution.

The deferred items are the honest ceiling on what the current numbers mean — see
the README's Limitations section, which is written to the same standard.
