/**
 * specsmith public API.
 *
 * Programmatic entry points for loading OpenAPI specs, generating
 * self-corrected TypeScript clients, and running the eval harness. The CLI
 * (`src/cli.ts`) is a thin wrapper over these exports.
 */

/** Parse, validate, dereference, and normalize an OpenAPI 3.x spec into a {@link ClientIR}. */
export { loadSpec } from "./ir/load.js";
/** Pure normalization of an already-dereferenced OpenAPI document into a {@link ClientIR}. */
export { normalizeDocument } from "./ir/normalize.js";
/** Construct an {@link LLMProvider}: the Anthropic SDK or the local Claude Code CLI. */
export { createProvider } from "./llm/provider.js";
/** Run the generate + self-correct loop for a single spec. */
export { generateClient } from "./agent/generate.js";
/** Run the eval harness across a spec manifest and write results to disk. */
export { runEval } from "./eval/run.js";
/** Render an {@link EvalRunResult} as a markdown report. */
export { renderMarkdownReport } from "./eval/report.js";
/** All shared contracts: IR, provider, generation, and eval types. */
export * from "./types.js";
