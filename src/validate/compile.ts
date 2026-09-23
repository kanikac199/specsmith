/**
 * Compilation utilities for generated client files.
 *
 * `typecheck` runs the TypeScript compiler API over the generated files and
 * maps diagnostics into repair feedback; `transpile` bundles the generated
 * client (zod included) into a single importable ESM file with esbuild.
 *
 * Callers pass a `workDir` under the project root so that `"zod"` resolves
 * against the project's node_modules.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import ts from "typescript";
import { build } from "esbuild";
import type { CompileError, CompileResult, GeneratedFiles } from "../types.js";

/** Write every generated file into `workDir` (created recursively); returns absolute-ish written paths. */
async function writeFiles(files: GeneratedFiles, workDir: string): Promise<string[]> {
  await mkdir(workDir, { recursive: true });
  const paths: string[] = [];
  for (const [relPath, contents] of Object.entries(files)) {
    const filePath = join(workDir, relPath);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, contents, "utf8");
    paths.push(filePath);
  }
  return paths;
}

/**
 * Type-check the generated files with the TypeScript compiler API.
 *
 * Writes `files` into `workDir`, builds a program over them (strict, ES2022,
 * bundler module resolution, ES2022+DOM libs), and maps every error-category
 * pre-emit diagnostic to a `CompileError` with basename file and 1-based line.
 */
export async function typecheck(files: GeneratedFiles, workDir: string): Promise<CompileResult> {
  const filePaths = await writeFiles(files, workDir);
  const options: ts.CompilerOptions = {
    strict: true,
    noUncheckedIndexedAccess: false,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    lib: ["lib.es2022.d.ts", "lib.dom.d.ts"],
    skipLibCheck: true,
    noEmit: true,
  };
  const program = ts.createProgram(filePaths, options);
  const diagnostics = ts.getPreEmitDiagnostics(program);
  const errors: CompileError[] = [];
  for (const diagnostic of diagnostics) {
    if (diagnostic.category !== ts.DiagnosticCategory.Error) continue;
    const error: CompileError = {
      message: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
    };
    if (diagnostic.file !== undefined && diagnostic.start !== undefined) {
      const { line } = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
      error.file = basename(diagnostic.file.fileName);
      error.line = line + 1;
    }
    errors.push(error);
  }
  return { ok: errors.length === 0, errors };
}

/**
 * Bundle the generated client into a single ESM file with esbuild.
 *
 * Writes `files` into `workDir`, bundles `index.ts` (zod gets inlined,
 * platform node, ES2022) to `client.bundle.mjs`, and returns the bundle path.
 * Throws a descriptive error if esbuild fails.
 */
export async function transpile(files: GeneratedFiles, workDir: string): Promise<string> {
  await writeFiles(files, workDir);
  const entryPoint = join(workDir, "index.ts");
  const outfile = join(workDir, "client.bundle.mjs");
  try {
    await build({
      entryPoints: [entryPoint],
      bundle: true,
      platform: "node",
      format: "esm",
      target: "es2022",
      outfile,
      logLevel: "silent",
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`esbuild failed to bundle the generated client (entry: ${entryPoint}): ${detail}`, {
      cause: err,
    });
  }
  return outfile;
}
