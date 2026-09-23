# specsmith — Architecture

specsmith is an LLM agent that turns an OpenAPI 3.x spec into a typed,
runtime-validated TypeScript client, then **self-corrects** the generated code
against a spec-faithful mock server until it compiles and its requests/responses
conform. An eval harness measures generation quality across a suite of specs.

```
 spec.yaml ──▶ IR ──▶ [LLM: schemas.ts] ──▶ [LLM: client.ts] ──▶ repair loop ──▶ client/
                │                                                   ▲
                │            tsc typecheck ── errors ───────────────┤
                └─▶ Prism mock ◀── exercise every operation ── failures
```

## Pipeline

1. **Load** (`src/ir/load.ts`): parse + validate + dereference the spec
   (`@apidevtools/swagger-parser`), normalize to a compact IR (`ClientIR` in
   `src/types.ts`).
2. **Generate** (`src/agent/generate.ts`): two LLM calls — one produces
   `schemas.ts` (zod schemas + inferred types for every named component
   schema), one produces `client.ts` (an `ApiClient` class with one typed
   method per operation). `index.ts` is written deterministically (no LLM).
3. **Self-correct** (repair loop inside `generate.ts`):
   - typecheck with the TypeScript compiler API → compile errors become repair
     feedback;
   - once compiling, boot a Prism mock of the spec (`--errors` mode) and
     **exercise every operation** through the generated client with
     deterministic sampled inputs → request-validation failures (Prism 4xx)
     and response zod-validation failures become repair feedback;
   - the LLM returns corrected files; loop until clean, no improvement, or
     `maxIterations`.
4. **Eval** (`src/eval/`): run the pipeline over `evals/specs/manifest.json`,
   compute metrics per spec, write JSON results + a markdown report.

## Module contracts

All shared types live in `src/types.ts` (already written — read it first).
Conventions: **ESM** (`"type": "module"`), relative imports use the `.js`
suffix (`import { x } from "../types.js"`), strict TS must pass
`npx tsc --noEmit`, no new npm dependencies, no `any` unless locally justified,
Node ≥ 20 (global `fetch`).

### `src/ir/load.ts`
```ts
export async function loadSpec(path: string): Promise<ClientIR>;
```
- Reject Swagger 2.0 with a clear error ("only OpenAPI 3.x is supported").
- Use `SwaggerParser.validate` then `SwaggerParser.dereference` with
  `dereference: { circular: "ignore" }`.

### `src/ir/normalize.ts`
```ts
export function normalizeDocument(doc: OpenAPIV3.Document-like): ClientIR;   // pure, unit-testable
```
- Synthesize `operationId` when missing (`get /pets/{petId}` → `getPetsPetId`).
- `methodName`: camelCase of operationId, sanitized to a valid JS identifier,
  deduped with numeric suffixes.
- Content-type selection: prefer `application/json`, else first JSON-ish
  (`+json`), else first declared.
- Responses: keep every status with its (optional) schema; include `default`.
- Auth: map `components.securitySchemes` to `AuthScheme[]`; an operation
  `requiresAuth` if it (or the root `security`) declares a non-empty
  requirement.
- Any schema node still containing `$ref` after dereference (circularity):
  replace that node with `{}` (permissive) — never throw.

### `src/llm/provider.ts`, `anthropic.ts`, `claude-code.ts`
```ts
export function createProvider(kind: "anthropic" | "claude-code", model?: string): LLMProvider;
```
- **anthropic**: `@anthropic-ai/sdk`, default model `claude-opus-4-8`,
  `client.messages.stream({ model, max_tokens: 32000, system, messages })` +
  `await stream.finalMessage()` (streaming because outputs are long). Map
  usage. Throw a descriptive error if `ANTHROPIC_API_KEY` is absent.
- **claude-code**: spawn the local `claude` CLI headlessly —
  `claude -p --output-format json [--model <model>]` with the prompt
  (system + user concatenated with a `# System` / `# Task` header) written to
  **stdin** (argv would overflow). Parse stdout JSON: `result` is the text,
  `usage.input_tokens`/`usage.output_tokens` (+ cache fields summed into
  inputTokens). Non-zero exit or `is_error: true` → throw with stderr tail.
  This provider exists so the project runs without an API key wherever Claude
  Code is installed/authenticated.

### `src/agent/prompts.ts`
```ts
export const CLIENT_CONTRACT: string;                       // the generated-client contract, verbatim (also used in README)
export function buildSchemasPrompt(ir: ClientIR): CompletionRequest;
export function buildClientPrompt(ir: ClientIR, schemasSource: string): CompletionRequest;
export function buildRepairPrompt(ir: ClientIR, files: GeneratedFiles, feedback: string): CompletionRequest;
export function parseFiles(text: string): GeneratedFiles;   // tolerant parser, see output format
```
**LLM output format** (all generation/repair prompts demand it; `parseFiles`
extracts it, ignoring any prose outside the markers, last occurrence wins):
```
===FILE: schemas.ts===
```typescript
// code
```
===END===
```
**The generated-client contract** (what the prompts must demand — this is the
single most important prompt content; encode it as explicit numbered rules):
- `schemas.ts`: for every named schema `X` in `ir.schemas`, export
  `const XSchema = z.…` and `export type X = z.infer<typeof XSchema>`.
  Plain `z.object` (no `.passthrough()`); optional props via `.optional()`;
  `nullable: true` → `.nullable()`; string formats: `date-time` →
  `z.string()` (NOT `.datetime()` — mock examples are not always RFC3339),
  other formats plain `z.string()`; integers `z.number().int()`. Only import
  from `"zod"`.
- `client.ts`: imports from `"./schemas.js"`; exports:
  ```ts
  export interface ClientConfig {
    baseUrl: string;
    apiKey?: string;            // sent per the spec's apiKey scheme (header/query/cookie name)
    bearerToken?: string;       // Authorization: Bearer …
    basicAuth?: { username: string; password: string };
    headers?: Record<string, string>;
    fetch?: typeof fetch;
  }
  export class ApiError extends Error { name = "ApiError"; status: number; body: unknown; }
  export class ResponseValidationError extends Error { name = "ResponseValidationError"; issues: unknown; }
  export class ApiClient { constructor(config: ClientConfig) … }
  ```
- One async method per operation, named `methodName`, taking a **single object
  argument** with one key per parameter (exact parameter name) plus `body` for
  the request body; the whole argument is optional when everything is optional.
- Methods: substitute path params with `encodeURIComponent`; serialize query
  params (arrays → repeated keys; skip `undefined`); attach auth headers/query
  from config **whenever configured** (regardless of per-op requirements —
  harmless and robust); JSON-encode the body with `Content-Type` from the IR.
- Response handling: non-2xx → throw `ApiError` (status, parsed body if JSON).
  2xx → parse JSON when the matched response (exact status, else `2XX`, else
  `default`) declares a schema, validate with the corresponding zod schema —
  on failure throw `ResponseValidationError` — and return
  `{ status, data }` typed to the success schema. No declared schema (e.g.
  204) → `{ status, data: undefined }`.
- Generated code may import **only** `"zod"` and `"./schemas.js"`; no other
  imports; must compile under `strict`.

### `src/agent/generate.ts`
```ts
export async function generateClient(ir: ClientIR, specPath: string, opts: GenerateOptions): Promise<GenerationResult>;
```
Loop semantics (each iteration appends one `IterationRecord`):
- iteration 0 (`kind: "initial"`): schemas call + client call; write
  deterministic `index.ts` (`export * from "./schemas.js"; export * from "./client.js";`).
- typecheck. If errors → next iteration is `compile-repair` (feedback =
  `renderCompileFeedback`), up to `maxIterations` total repairs.
- when compiling and `opts.exercise !== false`: `startMock(specPath)`,
  `transpile`, `exerciseClient`. Any op failure → next iteration is
  `runtime-repair` (feedback = `renderExerciseFeedback`).
- stop when: everything passes, or repairs exhausted, or an exercise repair
  produced **no improvement** (same or fewer `responsesOk`) — keep the better
  file set (compare `responsesOk`, then `requestsOk`).
- Record per-iteration usage and wall time; always stop the mock (finally).

### `src/validate/compile.ts`
```ts
export async function typecheck(files: GeneratedFiles, workDir: string): Promise<CompileResult>;
export async function transpile(files: GeneratedFiles, workDir: string): Promise<string>; // bundle path
```
- `workDir` is created under the project root (zod/node resolution must work):
  default `.specsmith-work/<random>` — the caller passes it.
- typecheck: write files, `ts.createProgram` (strict true,
  `noUncheckedIndexedAccess` false, target ES2022, module ESNext,
  moduleResolution bundler, lib ES2022+DOM, skipLibCheck) → map diagnostics to
  `CompileError` with file/line.
- transpile: esbuild `build({ entryPoints: [index.ts], bundle: true,
  platform: "node", format: "esm", outfile: client.bundle.mjs })` (zod gets
  bundled in; output is importable from anywhere).

### `src/validate/mock-server.ts`
```ts
export interface MockServer { url: string; stop(): Promise<void>; }
export async function startMock(specPath: string): Promise<MockServer>;
```
- Find a free port (bind 0, read, close). Spawn
  `node_modules/.bin/prism mock <spec> --errors -p <port> -h 127.0.0.1`
  (resolve the bin path from the **project root**, not cwd). Ready when an
  HTTP response (any status) is obtainable from the port, poll ≤ 30 s.
  `stop()` kills the process tree and awaits exit.

### `src/validate/exercise.ts` + `src/util/sample.ts`
```ts
export const TEST_AUTH = { apiKey: "specsmith-test-key", bearerToken: "specsmith-test-token",
                           basicAuth: { username: "specsmith", password: "specsmith" } };
export async function exerciseClient(bundlePath: string, ir: ClientIR, baseUrl: string): Promise<ExerciseResult>;
export function sampleFromSchema(schema: JsonSchema): unknown;   // src/util/sample.ts, deterministic
```
- `import(pathToFileURL(bundlePath))`, find `ApiClient` export, instantiate
  with `{ baseUrl, ...TEST_AUTH }`.
- Per op: method present? (`typeof client[methodName] === "function"`) — build
  the argument object: every **required** param sampled from its schema
  (path params always), `body` when a required body exists (sample it; also
  send optional bodies — Prism validates them); call with a 15 s timeout.
- Classification (check `err?.name`, never `instanceof` across bundles):
  - method missing → `methodFound: false`
  - thrown `ApiError` with status 401/403/422/400 → `requestOk: false`
    (include Prism's body detail in `failure`)
  - thrown `ResponseValidationError` → `requestOk: true, responseOk: false`
  - other throw (TypeError, etc.) → `requestOk: false`, failure = message
  - clean return → both true. Prism 5xx (mock can't produce a response) →
    count `requestOk: true, responseOk: true` but note in `failure` — don't
    punish the client for mock gaps. ApiError 5xx is NOT a client fault.
- Never let one op's failure abort the rest.

### `src/validate/feedback.ts`
```ts
export function renderCompileFeedback(r: CompileResult): string;
export function renderExerciseFeedback(r: ExerciseResult, ir: ClientIR): string;
```
- Compact, actionable, grouped by file; cap at ~80 errors / ~8000 chars.
- Exercise feedback: per failing op — method, path, the argument shape sent,
  what failed (Prism validation detail / zod issues), and the relevant IR
  fragment (params/body schema) so the LLM can fix the right thing.

### `src/eval/*`
```ts
// run.ts
export async function runEval(manifestPath: string, opts: { provider: LLMProvider; maxIterations?: number;
  specFilter?: string[]; fidelity?: boolean; outDir?: string; onProgress?: (m: string) => void }): Promise<EvalRunResult>;
// metrics.ts (pure)
export function computeSpecMetrics(ir: ClientIR, gen: GenerationResult): Omit<SpecEvalResult, "specId"|"title"|"tier"|"typeFidelity">-ish;
// fidelity.ts
export async function measureTypeFidelity(specPath: string, schemasTs: string, schemaNames: string[], workDir: string): Promise<number>;
// report.ts
export function renderMarkdownReport(run: EvalRunResult): string;
```
- Metric definitions (fractions of `operationCount` from the **final**
  iteration that has an exercise; a failed compile ⇒ all runtime rates 0):
  `operationCoverage = methodsFound/total`, `requestSuccessRate = requestsOk/total`,
  `responseValidationRate = responsesOk/total`.
- `IterationMetrics` mirrors each `IterationRecord` so the report can show
  **self-correction lift** (iteration 0 → final).
- Type fidelity: run `openapi-typescript` (programmatic import) on the spec →
  `groundtruth.ts`; emit a probe file that, for each schema name `X`, asserts
  mutual assignability between generated `X` and
  `components["schemas"]["X"]`; tsc the probe; a schema passes iff none of its
  probe lines error. Fidelity = passing/total. Skip silently (undefined) if
  openapi-typescript fails.
- Errors on one spec must not abort the run (`error` field, zeroed metrics).
- `report.ts`: a table (spec, tier, ops, compile ✓, coverage, request %,
  response %, fidelity, iter0→final lift, iterations, tokens, time) +
  per-spec failure notes. Writes `results.json` + `report.md` to `outDir`.

### `src/cli.ts` + `src/index.ts`
- commander program `specsmith`:
  - `generate <spec> -o <dir>` `--provider anthropic|claude-code` (default
    `claude-code` if no `ANTHROPIC_API_KEY`, else `anthropic`), `--model`,
    `--max-iterations <n>` (default 3), `--no-exercise`, writes files +
    `generation.json` (iterations/usage) into `-o`.
  - `eval` `--manifest evals/specs/manifest.json`, `--out evals/results/<timestamp>`,
    same provider/model/iteration flags, `--spec <id…>` filter,
    `--no-fidelity`; prints the markdown report path + a summary table.
- `src/index.ts` re-exports the public API (loadSpec, generateClient,
  createProvider, runEval, types).

## Eval spec suite (`evals/specs/`)
6 specs + `manifest.json` (shape: `SpecManifestEntry[]`): 3 vendored real
specs (small enough for single-shot generation, ≤ ~25 operations, JSON
format, license noted) + 3 crafted feature-stress specs (easy: plain CRUD +
apiKey; medium: pagination, enums, arrays, bearer auth; hard:
oneOf/discriminator, nullable, formats, mixed auth). Every spec must pass
`SwaggerParser.validate` and boot under Prism.

## Testing (`test/`)
LLM-free. Unit: normalize (petstore fixtures), sampleFromSchema, parseFiles,
feedback rendering, metrics math, report rendering. Integration: a
`FakeProvider` (scripted responses: first broken file, then fixed) drives
`generateClient` against a tiny in-repo spec with a real Prism mock —
asserts the loop repairs and records iterations.
