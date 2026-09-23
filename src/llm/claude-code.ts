/**
 * Claude Code CLI provider.
 *
 * Runs completions through the locally installed `claude` binary in headless
 * mode (`claude -p --output-format json`), so specsmith works without an
 * `ANTHROPIC_API_KEY` wherever Claude Code is installed and authenticated.
 * The prompt is written to stdin (argv would overflow on large specs).
 */

import { spawn } from "node:child_process";
import type { CompletionRequest, CompletionResponse, LLMProvider } from "../types.js";

/** Hard wall-clock limit for one CLI invocation. */
const TIMEOUT_MS = 10 * 60 * 1000;

/** How much trailing stderr to include in error messages. */
const STDERR_TAIL_CHARS = 500;

/** Shape of the single JSON object `claude -p --output-format json` prints. */
interface ClaudeCliOutput {
  is_error?: boolean;
  result?: unknown;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

/**
 * {@link LLMProvider} backed by the local Claude Code CLI.
 *
 * Note: the CLI exposes no max-output-tokens knob, so
 * {@link CompletionRequest.maxTokens} is ignored by this provider.
 */
export class ClaudeCodeProvider implements LLMProvider {
  /** Provider identifier, e.g. `"claude-code:default"` or `"claude-code:<model>"`. */
  readonly name: string;

  private readonly model?: string;

  /**
   * @param model Optional model passed to the CLI via `--model`; when omitted
   *   the CLI's own configured default is used.
   */
  constructor(model?: string) {
    this.model = model;
    this.name = `claude-code:${model ?? "default"}`;
  }

  /**
   * Run one completion through `claude -p --output-format json`, writing
   * `"# System\n" + system + "\n\n# Task\n" + user` to stdin and parsing the
   * single JSON object the CLI prints to stdout.
   *
   * @throws {Error} when the `claude` binary is missing from PATH, the run
   *   exceeds the 10-minute timeout, the process exits non-zero, the output
   *   is not valid JSON, or the CLI reports `is_error: true`.
   */
  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    const prompt = `# System\n${req.system}\n\n# Task\n${req.user}`;
    const args = ["-p", "--output-format", "json", ...(this.model ? ["--model", this.model] : [])];

    const stdout = await new Promise<string>((resolve, reject) => {
      const child = spawn("claude", args, { stdio: ["pipe", "pipe", "pipe"] });

      let out = "";
      let err = "";
      let settled = false;

      const fail = (error: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      };

      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        fail(
          new Error(
            `claude CLI timed out after ${TIMEOUT_MS / 60_000} minutes and was killed. ` +
              "The prompt may be too large, or the CLI may be waiting for interactive input.",
          ),
        );
      }, TIMEOUT_MS);

      child.on("error", (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") {
          fail(
            new Error(
              "claude CLI not found on PATH. Install Claude Code (https://claude.com/claude-code) and make " +
                'sure the `claude` command works in your shell, or use the "anthropic" provider with an ' +
                "ANTHROPIC_API_KEY instead.",
            ),
          );
        } else {
          fail(new Error(`Failed to spawn claude CLI: ${error.message}`));
        }
      });

      child.stdout.on("data", (chunk: Buffer) => {
        out += chunk.toString("utf8");
      });
      child.stderr.on("data", (chunk: Buffer) => {
        err += chunk.toString("utf8");
      });

      child.on("close", (code) => {
        if (settled) return;
        if (code !== 0) {
          const tail = err.slice(-STDERR_TAIL_CHARS).trim();
          fail(
            new Error(
              `claude CLI exited with code ${String(code)}.` +
                (tail ? ` stderr (last ${STDERR_TAIL_CHARS} chars): ${tail}` : " (no stderr output)"),
            ),
          );
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve(out);
      });

      // If the process dies before consuming stdin, writing raises EPIPE;
      // swallow it here — the "close"/"error" handlers report the real cause.
      child.stdin.on("error", () => {});
      child.stdin.end(prompt, "utf8");
    });

    let parsed: ClaudeCliOutput;
    try {
      parsed = JSON.parse(stdout) as ClaudeCliOutput;
    } catch {
      throw new Error(
        `claude CLI produced output that is not valid JSON (first 500 chars): ${stdout.slice(0, 500)}`,
      );
    }

    if (parsed.is_error) {
      const detail = typeof parsed.result === "string" ? parsed.result : JSON.stringify(parsed.result);
      throw new Error(`claude CLI reported an error: ${detail}`);
    }
    if (typeof parsed.result !== "string") {
      throw new Error(
        `claude CLI JSON output is missing a string "result" field (got ${typeof parsed.result}).`,
      );
    }

    const usage = parsed.usage ?? {};
    return {
      text: parsed.result,
      usage: {
        inputTokens:
          (usage.input_tokens ?? 0) +
          (usage.cache_creation_input_tokens ?? 0) +
          (usage.cache_read_input_tokens ?? 0),
        outputTokens: usage.output_tokens ?? 0,
      },
    };
  }
}
