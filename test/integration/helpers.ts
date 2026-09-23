/**
 * Shared helpers for the integration suite: fixture paths/loading and scratch
 * directory allocation under the project root (so "zod" resolves when
 * generated files are compiled/bundled there).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const PROJECT_ROOT = fileURLToPath(new URL("../../", import.meta.url));

export const TINYSPEC_PATH = fileURLToPath(new URL("./fixtures/tinyspec.json", import.meta.url));

/** index.ts exactly as generateClient writes it (deterministic, never from the LLM). */
export const INDEX_SOURCE = 'export * from "./schemas.js";\nexport * from "./client.js";\n';

/**
 * The same normalization parseFiles applies to ===FILE=== block bodies:
 * trailing whitespace trimmed, exactly one trailing newline. Applying it to
 * fixtures lets tests assert exact equality with GenerationResult.files.
 */
export function normalizeFile(source: string): string {
  return `${source.replace(/\s+$/u, "")}\n`;
}

/** Read a fixture file from test/integration/fixtures, normalized like parseFiles output. */
export function readFixture(name: string): string {
  return normalizeFile(readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), "utf8"));
}

/** Allocate a fresh scratch dir path under <project>/.specsmith-work (not created here). */
export function scratchDir(label: string): string {
  const unique = `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  return join(PROJECT_ROOT, ".specsmith-work", `it-${label}-${unique}`);
}
