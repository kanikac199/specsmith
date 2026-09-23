/**
 * Prism mock server lifecycle management.
 *
 * Boots `@stoplight/prism-cli` in `mock --errors` mode against a spec on a
 * free localhost port so generated clients can be exercised with full
 * request/response validation. The prism bin is resolved from this module's
 * location (i.e. the project root's node_modules), never from cwd, and is run
 * directly with the current Node executable so `stop()` only has to kill a
 * single process.
 */

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { dirname, join } from "node:path";

/** A running Prism mock of an OpenAPI spec. */
export interface MockServer {
  /** Base URL, e.g. "http://127.0.0.1:4123" (no trailing slash). */
  url: string;
  /** Stop the server and wait for the process to exit. Idempotent. */
  stop(): Promise<void>;
}

const READY_TIMEOUT_MS = 30_000;
const READY_POLL_INTERVAL_MS = 250;
const STOP_GRACE_MS = 3_000;
const STDERR_TAIL_CHARS = 4_000;
/** Boot attempts before giving up — a fresh port each time, to ride out transient port/boot races. */
const BOOT_ATTEMPTS = 3;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Find a free TCP port by binding to 0, reading the assigned port, and closing. */
async function getFreePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close(() => reject(new Error("Could not determine a free port: unexpected server address.")));
        return;
      }
      const { port } = address;
      server.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

/** Resolve the prism CLI entry script via its package.json "bin" field (relative to the project root). */
function resolvePrismBin(): string {
  const require = createRequire(import.meta.url);
  let pkgPath: string;
  try {
    pkgPath = require.resolve("@stoplight/prism-cli/package.json");
  } catch (err) {
    throw new Error(
      "Could not resolve @stoplight/prism-cli — is it installed in the project's node_modules? " +
        `(${err instanceof Error ? err.message : String(err)})`,
      { cause: err }
    );
  }
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { bin?: string | Record<string, string> };
  const binRel = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.["prism"];
  if (binRel === undefined) {
    throw new Error(`@stoplight/prism-cli package.json at ${pkgPath} declares no "prism" bin entry.`);
  }
  return join(dirname(pkgPath), binRel);
}

/** One boot attempt on a freshly allocated port. */
async function bootOnce(specPath: string, binPath: string): Promise<MockServer> {
  const port = await getFreePort();
  const url = `http://127.0.0.1:${port}`;

  const child = spawn(
    process.execPath,
    [binPath, "mock", specPath, "--errors", "-p", String(port), "-h", "127.0.0.1"],
    { stdio: ["ignore", "ignore", "pipe"] }
  );

  let stderrTail = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString("utf8")).slice(-STDERR_TAIL_CHARS);
  });

  // Capture both early exit and spawn failure (ENOENT, EACCES) — without an
  // "error" listener a failed spawn would throw an unhandled exception.
  let exitDescription: string | undefined;
  child.once("exit", (code, signal) => {
    exitDescription = signal !== null ? `signal ${signal}` : `exit code ${code ?? "unknown"}`;
  });
  child.once("error", (err: Error) => {
    exitDescription = `spawn error: ${err.message}`;
  });

  let stopping: Promise<void> | undefined;
  const stop = (): Promise<void> => {
    stopping ??= (async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      child.kill("SIGTERM");
      const graceful = await Promise.race([exited.then(() => true), delay(STOP_GRACE_MS).then(() => false)]);
      if (!graceful) {
        child.kill("SIGKILL");
        await exited;
      }
    })();
    return stopping;
  };

  const deadline = Date.now() + READY_TIMEOUT_MS;
  for (;;) {
    if (exitDescription !== undefined) {
      throw new Error(
        `Prism mock server for ${specPath} exited before becoming ready (${exitDescription}).` +
          (stderrTail !== "" ? `\nstderr:\n${stderrTail}` : "")
      );
    }
    try {
      // Any HTTP response — even a 404 — means the server is accepting connections.
      await fetch(`${url}/`);
      return { url, stop };
    } catch {
      if (Date.now() >= deadline) {
        await stop();
        throw new Error(
          `Prism mock server for ${specPath} did not answer on ${url} within ${READY_TIMEOUT_MS / 1000}s.` +
            (stderrTail !== "" ? `\nstderr:\n${stderrTail}` : "")
        );
      }
      await delay(READY_POLL_INTERVAL_MS);
    }
  }
}

/**
 * Start a Prism mock server (`prism mock <spec> --errors`) on a free port.
 *
 * Resolves once the server answers any HTTP request (any status counts as
 * ready), polling for up to 30 seconds. A boot that fails (transient port
 * race, slow start that loses the readiness window) is retried up to
 * {@link BOOT_ATTEMPTS} times on a fresh port before the error propagates.
 */
export async function startMock(specPath: string): Promise<MockServer> {
  const binPath = resolvePrismBin();
  let lastError: unknown;
  for (let attempt = 1; attempt <= BOOT_ATTEMPTS; attempt += 1) {
    try {
      return await bootOnce(specPath, binPath);
    } catch (err) {
      lastError = err;
      if (attempt < BOOT_ATTEMPTS) await delay(500);
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(`Prism mock server for ${specPath} failed to start: ${String(lastError)}`);
}
