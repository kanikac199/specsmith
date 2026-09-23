/**
 * Markdown report rendering for an eval run. Pure string building — no I/O —
 * so it is unit-testable and the output can be pasted straight into a README.
 */

import type { EvalRunResult, IterationMetrics, SpecEvalResult } from "../types.js";

/** Render a fraction in [0,1] as a rounded percentage, e.g. 0.944 -> "94%". */
function pct(fraction: number): string {
  return `${Math.round(fraction * 100)}%`;
}

/** "✅" / "❌" for booleans. */
function check(ok: boolean): string {
  return ok ? "✅" : "❌";
}

/** Compact token count: 950 -> "950", 12345 -> "12.3k", 2345678 -> "2.35M". */
function fmtTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

/** Integer with comma grouping (locale-independent), e.g. 1234567 -> "1,234,567". */
function fmtInt(n: number): string {
  return Math.round(n)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** Human duration: 850 -> "850ms", 12400 -> "12.4s", 95000 -> "1m 35s". */
function fmtMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  let minutes = Math.floor(seconds / 60);
  let rest = Math.round(seconds - minutes * 60);
  if (rest === 60) {
    minutes += 1;
    rest = 0;
  }
  return `${minutes}m ${rest}s`;
}

/** Arithmetic mean; 0 for an empty list. */
function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;
}

/** Self-correction lift cell: iteration-0 responses-ok rate -> final rate. */
function liftCell(spec: SpecEvalResult): string {
  const first = spec.iterations.at(0);
  if (!first) return "—";
  // An un-exercised iteration 0 (compile failure) contributed 0 valid responses.
  return `${pct(first.responseValidationRate ?? 0)} -> ${pct(spec.responseValidationRate)}`;
}

/** One bullet describing an iteration's trajectory step. */
function iterationBullet(it: IterationMetrics): string {
  const compile = it.compileOk
    ? "compile ✅"
    : `compile ❌ (${it.compileErrorCount} error${it.compileErrorCount === 1 ? "" : "s"})`;
  const exercise =
    it.requestSuccessRate !== undefined && it.responseValidationRate !== undefined
      ? `requests OK ${pct(it.requestSuccessRate)}, responses OK ${pct(it.responseValidationRate)}`
      : "exercise not run";
  return `- Iteration ${it.index} (${it.kind}): ${compile}; ${exercise}`;
}

/** True when a spec deserves a detail section (error or any sub-100% rate). */
function needsDetails(spec: SpecEvalResult): boolean {
  return (
    spec.error !== undefined ||
    !spec.compiled ||
    spec.operationCoverage < 1 ||
    spec.requestSuccessRate < 1 ||
    spec.responseValidationRate < 1 ||
    (spec.typeFidelity !== undefined && spec.typeFidelity < 1)
  );
}

/**
 * Render the full markdown report for an eval run: run metadata, the
 * per-spec results table, aggregate statistics, and detail bullets for every
 * spec that errored or scored below 100% on any rate.
 */
export function renderMarkdownReport(run: EvalRunResult): string {
  const out: string[] = [];

  out.push("# specsmith eval report");
  out.push("");
  out.push(`- Run: \`${run.runId}\``);
  out.push(`- Started: ${run.startedAt}`);
  out.push(`- Provider: \`${run.provider}\``);
  out.push(`- Max repair iterations: ${run.maxIterations}`);
  out.push(`- Specs: ${run.specs.length}`);
  out.push("");

  // ----- Main results table -------------------------------------------------
  out.push("## Results");
  out.push("");
  out.push(
    "| Spec | Tier | Ops | Compiles | Coverage | Requests OK | Responses OK | Type fidelity | Iter0 -> Final | Iters | Tokens (in/out) | Time |",
  );
  out.push("| --- | --- | ---: | :---: | ---: | ---: | ---: | ---: | :---: | ---: | ---: | ---: |");
  for (const spec of run.specs) {
    out.push(
      [
        "",
        spec.specId,
        spec.tier,
        String(spec.operationCount),
        check(spec.compiled),
        pct(spec.operationCoverage),
        pct(spec.requestSuccessRate),
        pct(spec.responseValidationRate),
        spec.typeFidelity === undefined ? "—" : pct(spec.typeFidelity),
        liftCell(spec),
        String(spec.iterationsUsed),
        `${fmtTokens(spec.usage.inputTokens)}/${fmtTokens(spec.usage.outputTokens)}`,
        fmtMs(spec.wallTimeMs),
        "",
      ].join(" | ").trim(),
    );
  }
  out.push("");

  // ----- Aggregates ---------------------------------------------------------
  const specs = run.specs;
  const compiledSpecs = specs.filter((s) => s.compiled);
  const fidelitySpecs = specs.filter((s) => s.typeFidelity !== undefined);
  const totalIn = specs.reduce((sum, s) => sum + s.usage.inputTokens, 0);
  const totalOut = specs.reduce((sum, s) => sum + s.usage.outputTokens, 0);
  const totalTime = specs.reduce((sum, s) => sum + s.wallTimeMs, 0);

  const rateLine = (label: string, pick: (s: SpecEvalResult) => number): string =>
    `- Mean ${label}: ${pct(mean(specs.map(pick)))} (compiled specs: ${pct(mean(compiledSpecs.map(pick)))})`;

  out.push("## Aggregates");
  out.push("");
  out.push(`- Specs compiled: ${compiledSpecs.length}/${specs.length}`);
  out.push(rateLine("operation coverage", (s) => s.operationCoverage));
  out.push(rateLine("request success rate", (s) => s.requestSuccessRate));
  out.push(rateLine("response validation rate", (s) => s.responseValidationRate));
  out.push(
    fidelitySpecs.length === 0
      ? "- Mean type fidelity: — (not measured)"
      : `- Mean type fidelity: ${pct(mean(fidelitySpecs.map((s) => s.typeFidelity ?? 0)))} (across ${fidelitySpecs.length} measured spec${fidelitySpecs.length === 1 ? "" : "s"})`,
  );
  out.push(`- Total tokens: ${fmtInt(totalIn)} in / ${fmtInt(totalOut)} out`);
  out.push(`- Total wall time: ${fmtMs(totalTime)}`);
  out.push("");

  // ----- Per-spec details ---------------------------------------------------
  out.push("## Per-spec details");
  out.push("");
  const detailed = specs.filter(needsDetails);
  if (detailed.length === 0) {
    out.push("All specs passed at 100% — nothing to report.");
    out.push("");
  } else {
    for (const spec of detailed) {
      out.push(`### ${spec.specId} (${spec.tier})`);
      out.push("");
      if (spec.error !== undefined) {
        out.push(`- Error: ${spec.error}`);
      }
      for (const it of spec.iterations) {
        out.push(iterationBullet(it));
      }
      if (spec.typeFidelity !== undefined && spec.typeFidelity < 1) {
        out.push(`- Type fidelity: ${pct(spec.typeFidelity)} of schemas mutually assignable with ground truth`);
      }
      out.push("");
    }
  }

  return out.join("\n");
}
