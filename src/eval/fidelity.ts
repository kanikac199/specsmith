/**
 * Type-fidelity measurement.
 *
 * Compares the LLM-generated `schemas.ts` types against a ground-truth type
 * model produced by `openapi-typescript` from the same spec. For each named
 * schema `X` a probe asserts **mutual assignability** between the generated
 * `X` and `components["schemas"]["X"]`; the fidelity score is the fraction of
 * schemas whose probe lines produce no compile error.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import openapiTS, { astToString } from "openapi-typescript";
import ts from "typescript";

/**
 * Compiler options duplicated from `src/validate/compile.ts`. Deliberately
 * NOT imported from the validate module so the eval harness stays decoupled
 * from the generation pipeline; keep in sync manually.
 */
const COMPILER_OPTIONS: ts.CompilerOptions = {
  strict: true,
  noUncheckedIndexedAccess: false,
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  lib: ["lib.es2022.d.ts", "lib.dom.d.ts"],
  skipLibCheck: true,
  noEmit: true,
};

/** Schema names must be plain TS identifiers to be probed via `G.<name>` / `gen_<name>`. */
const IDENTIFIER_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

interface ProbeRange {
  name: string;
  /** 0-based inclusive line range of this schema's probe block in probe.ts. */
  start: number;
  end: number;
}

/**
 * Measure type fidelity of generated schemas against `openapi-typescript`
 * ground truth.
 *
 * @param specPath - Path to the OpenAPI spec file.
 * @param schemasTs - Source of the generated `schemas.ts`.
 * @param schemaNames - Named component schemas to probe (keys of `ir.schemas`).
 * @param workDir - Scratch directory; must live under the project root so
 *   `"zod"` resolves from `schemas.ts`. Created if missing.
 * @returns Fraction in [0,1] of probed schemas that are mutually assignable
 *   with the ground truth; `0` when `schemas.ts` itself fails to compile in
 *   the probe context; `undefined` on any infrastructure failure
 *   (openapi-typescript throws, no probeable schema names, unattributable
 *   probe errors, I/O failure).
 *
 * Schema names that are not valid TS identifiers cannot be probed and are
 * excluded from the denominator (they neither pass nor fail).
 */
export async function measureTypeFidelity(
  specPath: string,
  schemasTs: string,
  schemaNames: string[],
  workDir: string,
): Promise<number | undefined> {
  try {
    const probedNames = schemaNames.filter((name) => IDENTIFIER_RE.test(name));
    if (probedNames.length === 0) return undefined;

    // Ground truth from openapi-typescript (programmatic).
    const ast = await openapiTS(pathToFileURL(resolve(specPath)));
    const groundTruthSource = astToString(ast);

    await mkdir(workDir, { recursive: true });
    const schemasPath = resolve(workDir, "schemas.ts");
    const groundTruthPath = resolve(workDir, "groundtruth.ts");
    const probePath = resolve(workDir, "probe.ts");

    // Probe file: per schema X, two declarations asserting assignability in
    // both directions. Stable "// schema: X" markers plus a recorded line
    // range map diagnostics back to schema names. The `const` declarations
    // are intentionally unused — COMPILER_OPTIONS enables no unused checks.
    const lines: string[] = [
      'import type * as G from "./schemas.js";',
      'import type * as GT from "./groundtruth.js";',
      "",
    ];
    const ranges: ProbeRange[] = [];
    for (const name of probedNames) {
      const start = lines.length;
      const gt = `GT.components["schemas"][${JSON.stringify(name)}]`;
      lines.push(`// schema: ${name}`);
      // Mutual-assignability check (both directions).
      lines.push(`const gen_${name}: G.${name} = null as unknown as ${gt};`);
      lines.push(`const gt_${name}: ${gt} = null as unknown as G.${name};`);
      // Not-any guard: `any` is mutually assignable with everything, so a
      // schema generated as z.any() would pass the check above vacuously.
      // `0 extends (1 & T)` is true only when T is `any`, so this line errors
      // (false is not assignable to true) exactly when G.<name> is `any`.
      lines.push(`const notAny_${name}: 0 extends (1 & G.${name}) ? false : true = true;`);
      ranges.push({ name, start, end: lines.length - 1 });
      lines.push("");
    }

    await writeFile(schemasPath, schemasTs, "utf8");
    await writeFile(groundTruthPath, groundTruthSource, "utf8");
    await writeFile(probePath, lines.join("\n"), "utf8");

    const program = ts.createProgram([schemasPath, groundTruthPath, probePath], COMPILER_OPTIONS);
    const diagnostics = ts.getPreEmitDiagnostics(program);

    const failing = new Set<string>();
    let schemasHaveErrors = false;
    let unattributable = false;
    for (const diagnostic of diagnostics) {
      if (diagnostic.category !== ts.DiagnosticCategory.Error) continue;
      const file = diagnostic.file;
      if (!file) continue; // global/options noise — not attributable to a schema
      const fileName = resolve(file.fileName);
      if (fileName === schemasPath) {
        schemasHaveErrors = true;
        continue;
      }
      // Errors inside groundtruth.ts itself (openapi-typescript output can
      // carry harmless noise) are ignored; only probe.ts errors count.
      if (fileName !== probePath) continue;
      const { line } = file.getLineAndCharacterOfPosition(diagnostic.start ?? 0);
      const range = ranges.find((r) => line >= r.start && line <= r.end);
      if (range) {
        failing.add(range.name);
      } else {
        // Error on the probe's import lines (e.g. groundtruth has no
        // `components` export) — an infrastructure problem, not a verdict.
        unattributable = true;
      }
    }

    if (schemasHaveErrors) return 0;
    if (unattributable) return undefined;
    return (probedNames.length - failing.size) / probedNames.length;
  } catch {
    // Any infrastructure failure (openapi-typescript throw, fs error, …)
    // means "could not measure", never "failed".
    return undefined;
  }
}
