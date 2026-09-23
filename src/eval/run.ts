/**
 * Eval runner: drives the full generation pipeline over every spec in a
 * manifest, computes per-spec metrics (plus optional type fidelity), and
 * writes `results.json` + `report.md` when an output directory is given.
 *
 * One spec's failure never aborts the run — it is recorded as a
 * `SpecEvalResult` with an `error` message and zeroed metrics.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { generateClient } from "../agent/generate.js";
import { loadSpec } from "../ir/load.js";
import type {
  ClientIR,
  EvalRunResult,
  LLMProvider,
  SpecEvalResult,
  SpecManifestEntry,
} from "../types.js";
import { measureTypeFidelity } from "./fidelity.js";
import { computeSpecMetrics } from "./metrics.js";
import { renderMarkdownReport } from "./report.js";

/** Default number of repair iterations (matches the CLI default). */
const DEFAULT_MAX_ITERATIONS = 3;

/** Package root, resolved from this module — scratch dirs must live under it so `zod` resolves. */
const PACKAGE_ROOT = fileURLToPath(new URL("../..", import.meta.url));

/** Options for {@link runEval}. */
export interface EvalOptions {
  /** LLM provider used for every generation. */
  provider: LLMProvider;
  /** Max repair iterations per spec. Default 3. */
  maxIterations?: number;
  /** Run only the manifest entries with these ids. */
  specFilter?: string[];
  /** Set false to skip the openapi-typescript type-fidelity probe. */
  fidelity?: boolean;
  /** When set, `results.json` and `report.md` are written here. */
  outDir?: string;
  /** Progress callback for CLI display. */
  onProgress?: (msg: string) => void;
}

/** Parse and lightly validate the manifest file. */
async function readManifest(manifestPath: string): Promise<SpecManifestEntry[]> {
  let raw: string;
  try {
    raw = await readFile(manifestPath, "utf8");
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`could not read eval manifest at ${manifestPath}: ${detail}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`eval manifest ${manifestPath} is not valid JSON: ${detail}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`eval manifest ${manifestPath} must be a JSON array of SpecManifestEntry`);
  }
  for (const entry of parsed as Array<Record<string, unknown>>) {
    if (typeof entry?.id !== "string" || typeof entry?.file !== "string") {
      throw new Error(
        `eval manifest ${manifestPath} has an entry without string "id"/"file": ${JSON.stringify(entry)}`,
      );
    }
  }
  return parsed as SpecManifestEntry[];
}

/** A zeroed result for a spec whose pipeline threw. */
function erroredResult(entry: SpecManifestEntry, ir: ClientIR | undefined, message: string): SpecEvalResult {
  return {
    specId: entry.id,
    title: entry.title,
    tier: entry.tier,
    operationCount: ir?.operations.length ?? 0,
    schemaCount: ir ? Object.keys(ir.schemas).length : 0,
    compiled: false,
    operationCoverage: 0,
    requestSuccessRate: 0,
    responseValidationRate: 0,
    iterations: [],
    iterationsUsed: 0,
    usage: { inputTokens: 0, outputTokens: 0 },
    wallTimeMs: 0,
    error: message,
  };
}

/**
 * Run the eval suite described by a manifest file.
 *
 * For each (optionally filtered) manifest entry, sequentially: load the spec
 * into an IR, run `generateClient`, compute metrics, and — unless
 * `opts.fidelity === false`, the client failed to compile, or the spec has no
 * named schemas — measure type fidelity against openapi-typescript ground
 * truth. Scratch output goes under `.specsmith-work/eval-<runId>/<specId>`
 * relative to the current working directory (it must live under the project
 * root so `zod` resolves during compilation).
 *
 * When `opts.outDir` is set, writes `results.json` (pretty-printed
 * {@link EvalRunResult}) and `report.md` (see `renderMarkdownReport`) there.
 *
 * @throws when the manifest is unreadable/malformed or `specFilter` names
 *   unknown ids — per-spec pipeline failures are captured in the results
 *   instead of thrown.
 */
export async function runEval(manifestPath: string, opts: EvalOptions): Promise<EvalRunResult> {
  const progress = opts.onProgress ?? (() => {});
  const started = new Date();
  const startedAt = started.toISOString();
  // Compact run id, e.g. "20260612T154500Z".
  const runId = startedAt.replace(/\.\d{3}Z$/, "Z").replace(/[-:]/g, "");
  const maxIterations = opts.maxIterations ?? DEFAULT_MAX_ITERATIONS;

  const allEntries = await readManifest(manifestPath);
  let entries = allEntries;
  if (opts.specFilter && opts.specFilter.length > 0) {
    const known = new Set(allEntries.map((e) => e.id));
    const unknown = opts.specFilter.filter((id) => !known.has(id));
    if (unknown.length > 0) {
      throw new Error(
        `--spec filter names unknown spec ids: ${unknown.join(", ")} (manifest has: ${[...known].join(", ")})`,
      );
    }
    const wanted = new Set(opts.specFilter);
    entries = allEntries.filter((e) => wanted.has(e.id));
  }

  const manifestDir = dirname(resolve(manifestPath));
  const workRoot = join(PACKAGE_ROOT, ".specsmith-work", `eval-${runId}`);
  const results: SpecEvalResult[] = [];

  for (const entry of entries) {
    const specPath = resolve(manifestDir, entry.file);
    const workDir = join(workRoot, entry.id);
    let ir: ClientIR | undefined;
    try {
      progress(`[${entry.id}] loading ${entry.file}...`);
      ir = await loadSpec(specPath);
      progress(
        `[${entry.id}] generating client (${ir.operations.length} operations, ${Object.keys(ir.schemas).length} schemas)...`,
      );
      const gen = await generateClient(ir, specPath, {
        provider: opts.provider,
        maxIterations,
        workDir,
        onProgress: (msg: string) => progress(`[${entry.id}] ${msg}`),
      });
      const metrics = computeSpecMetrics(ir, gen);

      let typeFidelity: number | undefined;
      const schemaNames = Object.keys(ir.schemas);
      if (opts.fidelity !== false && metrics.compiled && schemaNames.length > 0) {
        progress(`[${entry.id}] measuring type fidelity (${schemaNames.length} schemas)...`);
        typeFidelity = await measureTypeFidelity(
          specPath,
          gen.files["schemas.ts"] ?? "",
          schemaNames,
          join(workDir, "fidelity"),
        );
      }

      results.push({
        specId: entry.id,
        title: entry.title,
        tier: entry.tier,
        ...metrics,
        typeFidelity,
      });
      progress(
        `[${entry.id}] done: compile ${metrics.compiled ? "ok" : "FAILED"}, responses ok ${Math.round(metrics.responseValidationRate * 100)}%`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      progress(`[${entry.id}] FAILED: ${message}`);
      results.push(erroredResult(entry, ir, message));
    }
  }

  const run: EvalRunResult = {
    runId,
    startedAt,
    provider: opts.provider.name,
    maxIterations,
    specs: results,
  };

  if (opts.outDir) {
    await mkdir(opts.outDir, { recursive: true });
    const resultsPath = join(opts.outDir, "results.json");
    const reportPath = join(opts.outDir, "report.md");
    await writeFile(resultsPath, `${JSON.stringify(run, null, 2)}\n`, "utf8");
    await writeFile(reportPath, renderMarkdownReport(run), "utf8");
    progress(`wrote ${resultsPath}`);
    progress(`wrote ${reportPath}`);
  }

  return run;
}
