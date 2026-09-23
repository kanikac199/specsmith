/**
 * The generation + self-correction loop: two initial LLM calls produce
 * schemas.ts and client.ts, then repair iterations alternate between
 * compile feedback (tsc) and runtime feedback (Prism mock exercise) until
 * the client is clean, repairs are exhausted, or repairs stop improving.
 */

import { mkdir } from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import type {
  ClientIR,
  CompileResult,
  ExerciseResult,
  GenerateOptions,
  GeneratedFiles,
  GenerationResult,
  IterationKind,
  IterationRecord,
  TokenUsage,
} from "../types.js";
import { transpile, typecheck } from "../validate/compile.js";
import { exerciseClient } from "../validate/exercise.js";
import { renderCompileFeedback, renderExerciseFeedback } from "../validate/feedback.js";
import { startMock, type MockServer } from "../validate/mock-server.js";
import { buildClientPrompt, buildRepairPrompt, buildSchemasPrompt, parseFiles } from "./prompts.js";

/** Deterministic index.ts re-export — written without LLM involvement. */
const INDEX_SOURCE = 'export * from "./schemas.js";\nexport * from "./client.js";\n';

/** The only files the model is allowed to create or replace (index.ts is deterministic). */
const ALLOWED_FILES = new Set(["schemas.ts", "client.ts"]);

/**
 * The package root (the directory containing `src/` and `node_modules/`),
 * resolved from this module's location — never from `process.cwd()`. Scratch
 * work dirs must live under it so `zod` resolves during typecheck/transpile.
 */
const PACKAGE_ROOT = fileURLToPath(new URL("../..", import.meta.url));

/** Sum a call's token usage into an accumulator. */
function accumulate(into: TokenUsage, add: TokenUsage): void {
  into.inputTokens += add.inputTokens;
  into.outputTokens += add.outputTokens;
}

/** Human-readable message from an unknown thrown value. */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Extract the expected file from a model response: prefer a parsed
 * `===FILE===` block with the exact name; otherwise accept the whole response
 * as the file only when it plainly looks like code (starts with "import").
 */
function extractExpectedFile(text: string, name: string): string | undefined {
  const block = parseFiles(text)[name];
  if (block !== undefined) return block;
  const trimmed = text.trim();
  if (trimmed.startsWith("import")) return `${trimmed}\n`;
  return undefined;
}

/**
 * Generate a typed, runtime-validated client for `ir` and self-correct it
 * against tsc and a Prism mock of the spec at `specPath`.
 *
 * Loop semantics:
 * - iteration 0 ("initial"): one LLM call for schemas.ts, one for client.ts,
 *   plus a deterministic index.ts;
 * - while not clean and repair rounds remain (default 3): compile errors
 *   drive a "compile-repair", exercise failures a "runtime-repair"; parsed
 *   repair files are merged over the current set and re-validated;
 * - a runtime-repair that improves neither responsesOk nor requestsOk stops
 *   the loop, and the best file set seen (by responsesOk, then requestsOk)
 *   is returned;
 * - a provider failure mid-loop stops the loop and returns what exists,
 *   recorded as a synthetic compile error — unless iteration 0 produced no
 *   files at all, in which case it throws.
 *
 * The mock server is started lazily (first time compile passes with
 * exercising enabled) and always stopped before returning.
 */
export async function generateClient(
  ir: ClientIR,
  specPath: string,
  opts: GenerateOptions
): Promise<GenerationResult> {
  const startedAt = Date.now();
  const maxIterations = opts.maxIterations ?? 3;
  const exerciseEnabled = opts.exercise !== false;
  const progress = opts.onProgress ?? ((): void => undefined);
  const workDir =
    opts.workDir ?? path.join(PACKAGE_ROOT, ".specsmith-work", `gen-${Date.now().toString(36)}`);
  await mkdir(workDir, { recursive: true });

  const iterations: IterationRecord[] = [];
  const files: GeneratedFiles = {};
  let mock: MockServer | undefined;
  let best: { files: GeneratedFiles; exercise: ExerciseResult } | undefined;

  // Latest validation state (overwritten by every validate()).
  let compile: CompileResult = { ok: false, errors: [] };
  let exercise: ExerciseResult | undefined;
  let exerciseError: string | undefined;

  /** Typecheck (always) and exercise (when compiling) into a fresh per-iteration subdir. */
  const validate = async (iterIndex: number): Promise<void> => {
    exercise = undefined;
    exerciseError = undefined;
    const iterDir = path.join(workDir, `iter-${iterIndex}`);
    await mkdir(iterDir, { recursive: true });
    compile = await typecheck(files, iterDir);
    if (!compile.ok || !exerciseEnabled) return;
    try {
      mock ??= await startMock(specPath);
      const bundlePath = await transpile(files, iterDir);
      exercise = await exerciseClient(bundlePath, ir, mock.url);
    } catch (err) {
      // Infrastructure failure (mock boot, bundling, import) — not a model
      // fault; surfaced via progress and stops runtime repairs gracefully.
      exerciseError = errorMessage(err);
    }
  };

  /** Append an IterationRecord capturing the current validation state. */
  const record = (kind: IterationKind, usage: TokenUsage, startMs: number, error?: string): void => {
    const rec: IterationRecord = {
      index: iterations.length,
      kind,
      compile,
      exercise,
      usage,
      wallTimeMs: Date.now() - startMs,
    };
    // Prefer an explicit provider/parse error; otherwise surface an
    // exercise-infrastructure failure (mock boot / bundle import) so it is
    // visible in results instead of silently producing 0% runtime rates.
    const recordedError = error ?? exerciseError;
    if (recordedError !== undefined) rec.error = recordedError;
    iterations.push(rec);
  };

  /** One-line status for progress callbacks. */
  const status = (): string => {
    if (!compile.ok) {
      const n = compile.errors.length;
      return `compile: ${n} error${n === 1 ? "" : "s"}`;
    }
    if (exercise !== undefined) {
      return `exercise: ${exercise.requestsOk}/${exercise.total} requests ok, ${exercise.responsesOk}/${exercise.total} responses ok`;
    }
    if (exerciseError !== undefined) return `exercise failed to run: ${exerciseError}`;
    return "compile: ok";
  };

  /** Success: compiles, and (when exercising) every op is fully clean. */
  const succeeded = (): boolean =>
    compile.ok &&
    (!exerciseEnabled ||
      (exercise !== undefined && exercise.ops.every((o) => o.methodFound && o.requestOk && o.responseOk)));

  /** Track the best exercised file set by (responsesOk, requestsOk) lexicographic. */
  const updateBest = (): void => {
    if (exercise === undefined) return;
    if (
      best === undefined ||
      exercise.responsesOk > best.exercise.responsesOk ||
      (exercise.responsesOk === best.exercise.responsesOk && exercise.requestsOk > best.exercise.requestsOk)
    ) {
      best = { files: { ...files }, exercise };
    }
  };

  /**
   * Assemble the final result. When the loop did not fully succeed and an
   * earlier best exercised file set beats the current state, return that set —
   * and report `finalCompile`/`finalExercise` for THAT set, so downstream
   * metrics describe the files actually returned, not a worse discarded
   * attempt that happens to be the last iteration record.
   */
  const finish = (): GenerationResult => {
    const usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
    for (const iter of iterations) accumulate(usage, iter.usage);
    const useBest = !succeeded() && best !== undefined && best.exercise !== exercise;
    if (useBest && best !== undefined) {
      // `best` is only set after a successful exercise, which requires a clean compile.
      return {
        files: best.files,
        iterations,
        finalCompile: { ok: true, errors: [] },
        finalExercise: best.exercise,
        usage,
        wallTimeMs: Date.now() - startedAt,
      };
    }
    const result: GenerationResult = {
      files,
      iterations,
      finalCompile: compile,
      usage,
      wallTimeMs: Date.now() - startedAt,
    };
    if (exercise !== undefined) result.finalExercise = exercise;
    return result;
  };

  try {
    // ----- Iteration 0: initial generation (schemas call + client call) -----
    const iter0Start = Date.now();
    const iter0Usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
    let parseFailure: string | undefined;
    let providerFailure: string | undefined;

    try {
      const schemasResp = await opts.provider.complete(buildSchemasPrompt(ir));
      accumulate(iter0Usage, schemasResp.usage);
      const schemasSource = extractExpectedFile(schemasResp.text, "schemas.ts");
      if (schemasSource === undefined) {
        parseFailure = "model returned no parseable file (expected a ===FILE: schemas.ts=== block)";
      } else {
        files["schemas.ts"] = schemasSource;
        const clientResp = await opts.provider.complete(buildClientPrompt(ir, schemasSource));
        accumulate(iter0Usage, clientResp.usage);
        const clientSource = extractExpectedFile(clientResp.text, "client.ts");
        if (clientSource === undefined) {
          parseFailure = "model returned no parseable file (expected a ===FILE: client.ts=== block)";
        } else {
          files["client.ts"] = clientSource;
        }
      }
    } catch (err) {
      if (Object.keys(files).length === 0) {
        throw new Error(`LLM provider failed before any file was generated: ${errorMessage(err)}`);
      }
      providerFailure = `LLM provider error during initial generation: ${errorMessage(err)}`;
    }

    files["index.ts"] = INDEX_SOURCE;

    const initialFailure = providerFailure ?? parseFailure;
    if (initialFailure !== undefined) {
      compile = { ok: false, errors: [{ message: initialFailure }] };
      exercise = undefined;
    } else {
      await validate(0);
    }
    record("initial", iter0Usage, iter0Start, initialFailure);
    progress(`[iter 0/${maxIterations}] ${initialFailure ?? status()}`);
    updateBest();

    if (providerFailure !== undefined) return finish();

    // ----- Repair rounds -----
    for (let round = 1; round <= maxIterations; round++) {
      if (succeeded()) break;

      // Pick the repair call. A missing file (parse failure in iteration 0)
      // is regenerated with its original build prompt — which carries the full
      // IR — rather than the repair prompt, which has no spec content and
      // could never recover it. Compile errors and exercise failures use the
      // repair prompt with the relevant feedback.
      let repairKind: IterationKind;
      let request: ReturnType<typeof buildRepairPrompt>;
      let expectFile: string | undefined;
      if (files["schemas.ts"] === undefined) {
        repairKind = "compile-repair";
        request = buildSchemasPrompt(ir);
        expectFile = "schemas.ts";
      } else if (files["client.ts"] === undefined) {
        repairKind = "compile-repair";
        request = buildClientPrompt(ir, files["schemas.ts"]);
        expectFile = "client.ts";
      } else if (!compile.ok) {
        repairKind = "compile-repair";
        request = buildRepairPrompt(ir, files, renderCompileFeedback(compile));
      } else if (exercise !== undefined) {
        repairKind = "runtime-repair";
        request = buildRepairPrompt(ir, files, renderExerciseFeedback(exercise, ir));
      } else {
        // Compiles but the exercise phase could not run — no runtime feedback available.
        progress(
          `[iter ${round}/${maxIterations}] stopping: cannot exercise client (${exerciseError ?? "exercise unavailable"})`
        );
        break;
      }

      const iterStart = Date.now();
      const iterUsage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
      const prevBest = best;

      let responseText: string;
      try {
        const resp = await opts.provider.complete(request);
        accumulate(iterUsage, resp.usage);
        responseText = resp.text;
      } catch (err) {
        // A provider failure is not a model fault: leave the real compile/
        // exercise state intact (finish() falls back to the best file set) and
        // record the error in the dedicated field instead of faking a compile failure.
        record(repairKind, iterUsage, iterStart, `LLM provider error during ${repairKind}: ${errorMessage(err)}`);
        progress(`[iter ${round}/${maxIterations}] provider error: ${errorMessage(err)}`);
        break;
      }

      if (expectFile !== undefined) {
        const regenerated = extractExpectedFile(responseText, expectFile);
        if (regenerated !== undefined) files[expectFile] = regenerated;
      } else {
        const parsed = parseFiles(responseText);
        for (const [name, content] of Object.entries(parsed)) {
          if (ALLOWED_FILES.has(name)) files[name] = content;
        }
      }
      // Re-pin the deterministic index so a stray model index.ts can't replace it.
      files["index.ts"] = INDEX_SOURCE;

      await validate(iterations.length);
      record(repairKind, iterUsage, iterStart);
      progress(`[iter ${round}/${maxIterations}] ${status()}`);

      // No-improvement rule: a runtime repair that beats the previous best on
      // neither responsesOk nor requestsOk ends the loop; finish() keeps the best.
      const noImprovement =
        repairKind === "runtime-repair" &&
        exercise !== undefined &&
        prevBest !== undefined &&
        exercise.responsesOk <= prevBest.exercise.responsesOk &&
        exercise.requestsOk <= prevBest.exercise.requestsOk;
      updateBest();
      if (noImprovement) {
        progress(`[iter ${round}/${maxIterations}] no improvement — keeping best earlier file set`);
        break;
      }
    }

    return finish();
  } finally {
    if (mock !== undefined) {
      try {
        await mock.stop();
      } catch {
        // The mock process is already gone — nothing to clean up.
      }
    }
  }
}
