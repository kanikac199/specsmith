/**
 * Pure metric computation over a single spec's generation result.
 *
 * No I/O, no LLM calls — fully unit-testable. `runEval` combines the output
 * of {@link computeSpecMetrics} with manifest metadata and the (separately
 * measured) type-fidelity score to form a complete `SpecEvalResult`.
 */

import type {
  ClientIR,
  GenerationResult,
  IterationMetrics,
  IterationRecord,
  SpecEvalResult,
} from "../types.js";

/**
 * The slice of {@link SpecEvalResult} derivable purely from the IR and the
 * generation result (everything except manifest metadata, `typeFidelity`,
 * and `error`).
 */
export type SpecMetrics = Omit<
  SpecEvalResult,
  "specId" | "title" | "tier" | "typeFidelity" | "error"
>;

/** Safe fraction: returns 0 when the denominator is 0 (degenerate specs). */
function ratio(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : 0;
}

/** Escape a string for safe interpolation into a RegExp. */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Heuristic operation coverage for compiled runs whose exercise phase was
 * disabled: an operation counts as covered when its `methodName` appears as a
 * method definition (`methodName(` or `async methodName(`) preceded by a
 * non-identifier character — anchored so a method that is a prefix of another
 * (`getPets` vs `getPetsPetId`) and unrelated call sites (`searchParams.get(`)
 * do not produce false positives. A textual scan: it confirms a definition was
 * emitted, not that the method is callable. Only used when the client compiled
 * but was not exercised; a non-compiling client reports 0 coverage.
 */
function staticOperationCoverage(ir: ClientIR, clientSource: string): number {
  if (ir.operations.length === 0) return 0;
  let found = 0;
  for (const op of ir.operations) {
    const re = new RegExp(`(?:^|[^A-Za-z0-9_$])(?:async\\s+)?${escapeRegExp(op.methodName)}\\s*\\(`, "m");
    if (re.test(clientSource)) found += 1;
  }
  return found / ir.operations.length;
}

/** Per-iteration metrics mirroring one {@link IterationRecord}. */
function toIterationMetrics(record: IterationRecord): IterationMetrics {
  return {
    index: record.index,
    kind: record.kind,
    compileOk: record.compile.ok,
    compileErrorCount: record.compile.errors.length,
    requestSuccessRate: record.exercise
      ? ratio(record.exercise.requestsOk, record.exercise.total)
      : undefined,
    responseValidationRate: record.exercise
      ? ratio(record.exercise.responsesOk, record.exercise.total)
      : undefined,
  };
}

/**
 * Compute eval metrics for one spec from its generation result.
 *
 * All headline metrics describe the **file set actually returned** by
 * `generateClient` (`gen.finalCompile` / `gen.finalExercise`), NOT the last
 * iteration record — which may describe a worse attempt the loop discarded
 * when it fell back to an earlier best file set.
 *
 * - `compiled` reflects `gen.finalCompile.ok`.
 * - The runtime rates come from `gen.finalExercise` when present.
 * - When the returned files were not exercised (exercise disabled, or the
 *   client never compiled), both runtime rates are 0 and `operationCoverage`
 *   is a static text scan of `client.ts` only if the client compiled (a
 *   non-compiling client reports 0 coverage, per the metric definition).
 */
export function computeSpecMetrics(ir: ClientIR, gen: GenerationResult): SpecMetrics {
  const records = gen.iterations;
  const compiled = gen.finalCompile.ok;

  let operationCoverage: number;
  let requestSuccessRate: number;
  let responseValidationRate: number;
  if (gen.finalExercise) {
    const ex = gen.finalExercise;
    operationCoverage = ratio(ex.methodsFound, ex.total);
    requestSuccessRate = ratio(ex.requestsOk, ex.total);
    responseValidationRate = ratio(ex.responsesOk, ex.total);
  } else {
    operationCoverage = compiled ? staticOperationCoverage(ir, gen.files["client.ts"] ?? "") : 0;
    requestSuccessRate = 0;
    responseValidationRate = 0;
  }

  return {
    operationCount: ir.operations.length,
    schemaCount: Object.keys(ir.schemas).length,
    compiled,
    operationCoverage,
    requestSuccessRate,
    responseValidationRate,
    iterations: records.map(toIterationMetrics),
    iterationsUsed: records.length,
    usage: gen.usage,
    wallTimeMs: gen.wallTimeMs,
  };
}
