/**
 * Unit tests for src/eval/metrics.ts (computeSpecMetrics) and a smoke test of
 * src/eval/report.ts (renderMarkdownReport).
 */

import { describe, expect, it } from "vitest";
import { computeSpecMetrics } from "../../src/eval/metrics.js";
import { renderMarkdownReport } from "../../src/eval/report.js";
import type {
  ClientIR,
  EvalRunResult,
  ExerciseResult,
  GenerationResult,
  IterationRecord,
  SpecEvalResult,
} from "../../src/types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeIr(methodNames: string[], schemaNames: string[] = []): ClientIR {
  return {
    title: "Metrics Demo",
    version: "1.0.0",
    auth: [],
    operations: methodNames.map((name, i) => ({
      operationId: name,
      methodName: name,
      method: "get",
      path: `/x${i}`,
      tag: "default",
      params: [],
      responses: [],
      requiresAuth: false,
    })),
    schemas: Object.fromEntries(schemaNames.map((n) => [n, { type: "object" }])),
  };
}

function exercise(
  total: number,
  methodsFound: number,
  requestsOk: number,
  responsesOk: number,
): ExerciseResult {
  return { total, methodsFound, requestsOk, responsesOk, ops: [] };
}

function iteration(
  index: number,
  opts: {
    kind?: IterationRecord["kind"];
    compileOk: boolean;
    errorCount?: number;
    exercise?: ExerciseResult;
  },
): IterationRecord {
  return {
    index,
    kind: opts.kind ?? (index === 0 ? "initial" : "compile-repair"),
    compile: {
      ok: opts.compileOk,
      errors: Array.from({ length: opts.errorCount ?? 0 }, (_, i) => ({
        file: "client.ts",
        line: i + 1,
        message: `e${i}`,
      })),
    },
    exercise: opts.exercise,
    usage: { inputTokens: 100, outputTokens: 50 },
    wallTimeMs: 1000,
  };
}

/**
 * Build a GenerationResult. `finalCompile`/`finalExercise` describe the
 * returned file set and are what `computeSpecMetrics` reads. By default they
 * mirror the last iteration (the success path: no best-set fallback); pass
 * `final` to model a fallback where the returned files differ from the last,
 * discarded iteration record.
 */
function gen(
  iterations: IterationRecord[],
  files: Record<string, string> = {},
  final?: { finalCompile: GenerationResult["finalCompile"]; finalExercise?: ExerciseResult },
): GenerationResult {
  let derivedExercise: ExerciseResult | undefined;
  for (const it of iterations) if (it.exercise) derivedExercise = it.exercise;
  const finalCompile = final?.finalCompile ?? iterations.at(-1)?.compile ?? { ok: false, errors: [] };
  const finalExercise = final ? final.finalExercise : derivedExercise;
  const result: GenerationResult = {
    files,
    iterations,
    finalCompile,
    usage: { inputTokens: 1234, outputTokens: 567 },
    wallTimeMs: 8900,
  };
  if (finalExercise !== undefined) result.finalExercise = finalExercise;
  return result;
}

// ---------------------------------------------------------------------------
// computeSpecMetrics
// ---------------------------------------------------------------------------

describe("computeSpecMetrics", () => {
  const ir = makeIr(["getFoo", "createBar"], ["Foo", "Bar", "Baz"]);

  it("reads `compiled` from finalCompile (the returned file set)", () => {
    const recovered = computeSpecMetrics(
      ir,
      gen([
        iteration(0, { compileOk: false, errorCount: 2 }),
        iteration(1, { compileOk: true, exercise: exercise(2, 2, 2, 2) }),
      ]),
    );
    expect(recovered.compiled).toBe(true);

    const failed = computeSpecMetrics(
      ir,
      gen([iteration(0, { compileOk: false, errorCount: 1 })]),
    );
    expect(failed.compiled).toBe(false);
  });

  it("describes the returned best file set, NOT a worse last iteration record (regression)", () => {
    // The loop exercised 2/3 in iteration 0 (best), a runtime repair regressed
    // to 1/3, the no-improvement rule kept iteration 0's files. The returned
    // result therefore reports finalCompile=ok + finalExercise=the kept 2/3,
    // even though the LAST iteration record is the worse, discarded attempt.
    const kept = exercise(3, 3, 2, 2);
    const metrics = computeSpecMetrics(
      ir,
      gen(
        [
          iteration(0, { compileOk: true, exercise: kept }),
          iteration(1, { kind: "runtime-repair", compileOk: true, exercise: exercise(3, 3, 1, 1) }),
        ],
        {},
        { finalCompile: { ok: true, errors: [] }, finalExercise: kept },
      ),
    );
    expect(metrics.compiled).toBe(true);
    expect(metrics.requestSuccessRate).toBeCloseTo(2 / 3);
    expect(metrics.responseValidationRate).toBeCloseTo(2 / 3);
  });

  it("derives rates from finalExercise", () => {
    const metrics = computeSpecMetrics(
      ir,
      gen(
        [iteration(0, { compileOk: true, exercise: exercise(4, 3, 2, 1) })],
        {},
        { finalCompile: { ok: true, errors: [] }, finalExercise: exercise(4, 3, 2, 1) },
      ),
    );
    expect(metrics.operationCoverage).toBe(0.75);
    expect(metrics.requestSuccessRate).toBe(0.5);
    expect(metrics.responseValidationRate).toBe(0.25);
  });

  it("reports 0 coverage and 0 runtime rates for a non-compiling client", () => {
    // A client that mentions a method name but never compiles must NOT be
    // credited with coverage (the old substring fallback overcounted here).
    const clientSource = "export class ApiClient { async getFoo(args) { return undefined; } }";
    const metrics = computeSpecMetrics(
      ir,
      gen([iteration(0, { compileOk: false, errorCount: 5 })], { "client.ts": clientSource }),
    );
    expect(metrics.compiled).toBe(false);
    expect(metrics.requestSuccessRate).toBe(0);
    expect(metrics.responseValidationRate).toBe(0);
    expect(metrics.operationCoverage).toBe(0);
  });

  it("uses the static coverage fallback for a compiled-but-unexercised client", () => {
    // Compiled, exercise disabled (finalExercise undefined): coverage falls
    // back to an anchored method-definition scan. getFoo defined, createBar not.
    const clientSource = "export class ApiClient { async getFoo(args) { return undefined; } }";
    const metrics = computeSpecMetrics(
      ir,
      gen([iteration(0, { compileOk: true })], { "client.ts": clientSource }, {
        finalCompile: { ok: true, errors: [] },
      }),
    );
    expect(metrics.compiled).toBe(true);
    expect(metrics.operationCoverage).toBe(0.5);
  });

  it("static coverage is anchored: a method-name prefix and a call site don't false-positive", () => {
    const prefixIr = makeIr(["getPets", "getPetsPetId"]);
    // Only getPetsPetId is defined; getPets appears only as its prefix and as a
    // property access — neither should count as covering getPets.
    const clientSource =
      "export class ApiClient { async getPetsPetId(a) { this.cache.getPetsRef(); } }";
    const metrics = computeSpecMetrics(
      prefixIr,
      gen([iteration(0, { compileOk: true })], { "client.ts": clientSource }, {
        finalCompile: { ok: true, errors: [] },
      }),
    );
    expect(metrics.operationCoverage).toBe(0.5);
  });

  it("guards against NaN: zero-total exercise and zero-operation IR yield 0 rates", () => {
    const degenerate = computeSpecMetrics(
      makeIr([]),
      gen([iteration(0, { compileOk: true, exercise: exercise(0, 0, 0, 0) })]),
    );
    expect(degenerate.operationCoverage).toBe(0);
    expect(degenerate.requestSuccessRate).toBe(0);
    expect(degenerate.responseValidationRate).toBe(0);

    const neverRan = computeSpecMetrics(makeIr([]), gen([], {}));
    expect(neverRan.compiled).toBe(false);
    expect(neverRan.operationCoverage).toBe(0);
    expect(neverRan.iterationsUsed).toBe(0);
    expect(neverRan.iterations).toEqual([]);
  });

  it("mirrors each iteration into IterationMetrics", () => {
    const metrics = computeSpecMetrics(
      ir,
      gen([
        iteration(0, { compileOk: false, errorCount: 3 }),
        iteration(1, { compileOk: true, exercise: exercise(4, 4, 3, 2) }),
      ]),
    );
    expect(metrics.iterations).toEqual([
      {
        index: 0,
        kind: "initial",
        compileOk: false,
        compileErrorCount: 3,
        requestSuccessRate: undefined,
        responseValidationRate: undefined,
      },
      {
        index: 1,
        kind: "compile-repair",
        compileOk: true,
        compileErrorCount: 0,
        requestSuccessRate: 0.75,
        responseValidationRate: 0.5,
      },
    ]);
    expect(metrics.iterationsUsed).toBe(2);
  });

  it("passes through counts, usage, and wall time", () => {
    const metrics = computeSpecMetrics(
      ir,
      gen([iteration(0, { compileOk: true, exercise: exercise(2, 2, 2, 2) })]),
    );
    expect(metrics.operationCount).toBe(2);
    expect(metrics.schemaCount).toBe(3);
    expect(metrics.usage).toEqual({ inputTokens: 1234, outputTokens: 567 });
    expect(metrics.wallTimeMs).toBe(8900);
  });
});

// ---------------------------------------------------------------------------
// renderMarkdownReport (smoke)
// ---------------------------------------------------------------------------

function specResult(overrides: Partial<SpecEvalResult> & { specId: string }): SpecEvalResult {
  return {
    title: overrides.specId,
    tier: "easy",
    operationCount: 7,
    schemaCount: 9,
    compiled: true,
    operationCoverage: 1,
    requestSuccessRate: 1,
    responseValidationRate: 1,
    iterations: [
      {
        index: 0,
        kind: "initial",
        compileOk: true,
        compileErrorCount: 0,
        requestSuccessRate: 1,
        responseValidationRate: 1,
      },
    ],
    iterationsUsed: 1,
    usage: { inputTokens: 12345, outputTokens: 950 },
    wallTimeMs: 12400,
    ...overrides,
  };
}

describe("renderMarkdownReport", () => {
  const run: EvalRunResult = {
    runId: "run-1",
    startedAt: "2026-06-12T00:00:00Z",
    provider: "fake:test",
    maxIterations: 3,
    specs: [
      specResult({ specId: "alpha-spec", typeFidelity: 1 }),
      specResult({
        specId: "beta-spec",
        tier: "hard",
        compiled: false,
        operationCoverage: 0.5,
        requestSuccessRate: 0.25,
        responseValidationRate: 0,
        iterations: [
          {
            index: 0,
            kind: "initial",
            compileOk: false,
            compileErrorCount: 3,
            requestSuccessRate: undefined,
            responseValidationRate: undefined,
          },
        ],
        usage: { inputTokens: 2_345_678, outputTokens: 1_000 },
        wallTimeMs: 95_000,
        error: "boom",
      }),
    ],
  };
  const md = renderMarkdownReport(run);

  it("contains the title, run metadata, and the results table header", () => {
    expect(md).toContain("# specsmith eval report");
    expect(md).toContain("- Run: `run-1`");
    expect(md).toContain("- Provider: `fake:test`");
    expect(md).toContain(
      "| Spec | Tier | Ops | Compiles | Coverage | Requests OK | Responses OK | Type fidelity | Iter0 -> Final | Iters | Tokens (in/out) | Time |",
    );
  });

  it("renders per-spec rows with percentages, checks, lift, tokens, and time", () => {
    expect(md).toContain("| alpha-spec | easy | 7 | ✅ | 100% | 100% | 100% | 100% |");
    expect(md).toContain("| 100% -> 100% |");
    expect(md).toContain("12.3k/950");
    expect(md).toContain("12.4s");

    expect(md).toContain("| beta-spec | hard | 7 | ❌ | 50% | 25% | 0% |");
    // No fidelity measured -> em dash; un-exercised iteration 0 -> 0% lift origin.
    expect(md).toContain("| — | 0% -> 0% |");
    expect(md).toContain("2.35M/1.0k");
    expect(md).toContain("1m 35s");
  });

  it("renders aggregates over all specs and compiled specs", () => {
    expect(md).toContain("- Specs compiled: 1/2");
    expect(md).toContain(
      "- Mean response validation rate: 50% (compiled specs: 100%)",
    );
    expect(md).toContain("- Mean type fidelity: 100% (across 1 measured spec)");
    expect(md).toContain("- Total tokens: 2,358,023 in / 1,950 out");
    expect(md).toContain("- Total wall time: 1m 47s");
  });

  it("details only the imperfect spec, with its error and iteration trajectory", () => {
    expect(md).toContain("### beta-spec (hard)");
    expect(md).toContain("- Error: boom");
    expect(md).toContain(
      "- Iteration 0 (initial): compile ❌ (3 errors); exercise not run",
    );
    expect(md).not.toContain("### alpha-spec");
  });

  it("reports nothing when every spec is perfect", () => {
    const perfect = renderMarkdownReport({
      ...run,
      specs: [specResult({ specId: "alpha-spec", typeFidelity: 1 })],
    });
    expect(perfect).toContain("All specs passed at 100% — nothing to report.");
  });
});
