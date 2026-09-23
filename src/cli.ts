#!/usr/bin/env node
/**
 * specsmith command-line interface.
 *
 * Commands:
 * - `generate <spec>` — forge a typed, runtime-validated TypeScript client
 *   from a single OpenAPI 3.x spec and write it (plus `generation.json`
 *   metadata) into an output directory.
 * - `eval` — run the generation pipeline across the eval spec suite and
 *   print/write a metrics report.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { Command, InvalidArgumentError, Option } from "commander";
import pc from "picocolors";

import { generateClient } from "./agent/generate.js";
import { renderMarkdownReport } from "./eval/report.js";
import { runEval } from "./eval/run.js";
import { loadSpec } from "./ir/load.js";
import { createProvider } from "./llm/provider.js";
import type {
  ClientIR,
  EvalRunResult,
  GeneratedFiles,
  GenerationResult,
  LLMProvider,
} from "./types.js";

/** Provider kinds accepted by `--provider`. */
type ProviderKind = "anthropic" | "claude-code";

/** Options shared by both commands (provider selection + repair budget). */
interface SharedLlmOptions {
  provider: ProviderKind;
  model?: string;
  maxIterations: number;
}

/** Parsed options for `specsmith generate`. */
interface GenerateCliOptions extends SharedLlmOptions {
  out: string;
  /** False when `--no-exercise` was passed. */
  exercise: boolean;
}

/** Parsed options for `specsmith eval`. */
interface EvalCliOptions extends SharedLlmOptions {
  manifest: string;
  out?: string;
  spec?: string[];
  /** False when `--no-fidelity` was passed. */
  fidelity: boolean;
}

/** Commander argParser for non-negative integer options. */
function parseIntOption(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new InvalidArgumentError(`expected a non-negative integer, got "${value}"`);
  }
  return parsed;
}

/** Compact local timestamp for default eval output dirs, e.g. "20260612-1430". */
function timestamp(now = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(
    now.getHours(),
  )}${pad(now.getMinutes())}`;
}

/**
 * Builds the shared `--provider` option. Defaults to "anthropic" when
 * ANTHROPIC_API_KEY is set, otherwise to the local "claude-code" CLI.
 */
function providerOption(): Option {
  const fallback: ProviderKind = process.env.ANTHROPIC_API_KEY ? "anthropic" : "claude-code";
  return new Option("--provider <kind>", "LLM provider backend")
    .choices(["anthropic", "claude-code"])
    .default(fallback, '"anthropic" when ANTHROPIC_API_KEY is set, else "claude-code"');
}

/** Writes every generated file under outDir, creating directories as needed. */
async function writeGeneratedFiles(outDir: string, files: GeneratedFiles): Promise<void> {
  await mkdir(outDir, { recursive: true });
  for (const [relativePath, contents] of Object.entries(files)) {
    const destination = path.join(outDir, relativePath);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, contents, "utf8");
  }
}

/**
 * Extracts the first contiguous markdown-table block (lines starting with
 * "|") from the rendered report; falls back to the whole report if no table
 * is found.
 */
function extractSummaryTable(markdown: string): string {
  const lines = markdown.split("\n");
  const isTableLine = (index: number): boolean =>
    lines[index]?.trimStart().startsWith("|") ?? false;
  const start = lines.findIndex((line) => line.trimStart().startsWith("|"));
  if (start === -1) {
    return markdown.trim();
  }
  let end = start;
  while (end < lines.length && isTableLine(end)) {
    end += 1;
  }
  return lines.slice(start, end).join("\n");
}

/** Implements `specsmith generate <spec>`. */
async function runGenerateCommand(spec: string, options: GenerateCliOptions): Promise<void> {
  const specPath = path.resolve(spec);
  const provider: LLMProvider = createProvider(options.provider, options.model);
  console.log(
    `${pc.bold("specsmith")} generating client from ${pc.cyan(spec)} ${pc.dim(
      `(provider: ${provider.name})`,
    )}`,
  );

  const ir: ClientIR = await loadSpec(specPath);
  console.log(
    pc.dim(
      `  loaded "${ir.title}" v${ir.version}: ${ir.operations.length} operation(s), ` +
        `${Object.keys(ir.schemas).length} schema(s)`,
    ),
  );

  const result: GenerationResult = await generateClient(ir, specPath, {
    provider,
    maxIterations: options.maxIterations,
    exercise: options.exercise,
    onProgress: (msg: string) => console.log(`${pc.blue("›")} ${msg}`),
  });

  await writeGeneratedFiles(options.out, result.files);
  const metaPath = path.join(options.out, "generation.json");
  const generationMeta = {
    iterations: result.iterations,
    usage: result.usage,
    wallTimeMs: result.wallTimeMs,
    provider: provider.name,
  };
  await writeFile(metaPath, `${JSON.stringify(generationMeta, null, 2)}\n`, "utf8");

  const written = [
    ...Object.keys(result.files).map((file) => path.join(options.out, file)),
    metaPath,
  ];
  for (const file of written) {
    console.log(pc.dim(`  wrote ${file}`));
  }

  // Describe the file set actually written (finalCompile/finalExercise), not
  // the last iteration record — which may be a worse, discarded attempt.
  const compiled = result.finalCompile.ok;
  const exercise = result.finalExercise;

  const summaryParts = [
    `${written.length} file(s) → ${options.out}`,
    `${result.iterations.length} iteration(s)`,
    compiled ? pc.green("compile ok") : pc.red("compile failed"),
  ];
  if (exercise) {
    summaryParts.push(
      `requests ${exercise.requestsOk}/${exercise.total} ok`,
      `responses ${exercise.responsesOk}/${exercise.total} valid`,
    );
  }
  console.log(`${compiled ? pc.green("✔") : pc.red("✖")} ${summaryParts.join(" · ")}`);

  if (!compiled) {
    process.exitCode = 1;
  }
}

/** Implements `specsmith eval`. */
async function runEvalCommand(options: EvalCliOptions): Promise<void> {
  const outDir = options.out ?? path.join("evals", "results", timestamp());
  const provider: LLMProvider = createProvider(options.provider, options.model);
  console.log(
    `${pc.bold("specsmith")} eval over ${pc.cyan(options.manifest)} ${pc.dim(
      `(provider: ${provider.name}, out: ${outDir})`,
    )}`,
  );

  const run: EvalRunResult = await runEval(options.manifest, {
    provider,
    maxIterations: options.maxIterations,
    specFilter: options.spec,
    fidelity: options.fidelity,
    outDir,
    onProgress: (msg: string) => console.log(`${pc.cyan("›")} ${msg}`),
  });

  if (run.specs.length === 0) {
    console.error(
      pc.red("error: no specs were evaluated — check the manifest path and the --spec filter"),
    );
    process.exitCode = 1;
    return;
  }

  const reportPath = path.resolve(outDir, "report.md");
  console.log(`\n${pc.bold("report:")} ${reportPath}\n`);
  console.log(extractSummaryTable(renderMarkdownReport(run)));

  const erroredCount = run.specs.filter((specResult) => specResult.error !== undefined).length;
  if (erroredCount === run.specs.length) {
    console.error(
      pc.red(`error: all ${erroredCount} spec(s) errored — see ${reportPath} for details`),
    );
    process.exitCode = 1;
  }
}

const program = new Command();

program
  .name("specsmith")
  .description(
    "Forge typed, runtime-validated TypeScript clients from OpenAPI 3.x specs " +
      "with a self-correcting LLM agent.",
  )
  .version("0.1.0");

program
  .command("generate")
  .description("Generate a typed TypeScript client from an OpenAPI 3.x spec")
  .argument("<spec>", "path to the OpenAPI 3.x spec file (JSON or YAML)")
  .requiredOption("-o, --out <dir>", "directory to write the generated client into")
  .addOption(providerOption())
  .option("--model <id>", "model id passed to the provider")
  .option(
    "--max-iterations <n>",
    "maximum repair iterations after the initial generation",
    parseIntOption,
    3,
  )
  .option("--no-exercise", "skip the mock-server exercise phase (compile-only repair loop)")
  .action(async (spec: string, options: GenerateCliOptions) => {
    await runGenerateCommand(spec, options);
  });

program
  .command("eval")
  .description("Run the generation pipeline across the eval spec suite and report metrics")
  .option("--manifest <path>", "path to the eval spec manifest", "evals/specs/manifest.json")
  .option("--out <dir>", 'results directory (default: "evals/results/<timestamp>")')
  .addOption(providerOption())
  .option("--model <id>", "model id passed to the provider")
  .option(
    "--max-iterations <n>",
    "maximum repair iterations after the initial generation",
    parseIntOption,
    3,
  )
  .option("--spec <ids...>", "only evaluate the specs with these manifest ids")
  .option("--no-fidelity", "skip the openapi-typescript type-fidelity probe")
  .action(async (options: EvalCliOptions) => {
    await runEvalCommand(options);
  });

/** CLI entry point: parse argv and surface any failure as a red one-liner. */
async function main(): Promise<void> {
  try {
    await program.parseAsync(process.argv);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(pc.red(`error: ${message}`));
    process.exit(1);
  }
}

void main();
