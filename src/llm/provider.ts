/**
 * Provider factory — the single entry point other modules use to obtain an
 * {@link LLMProvider}. See `src/llm/anthropic.ts` and `src/llm/claude-code.ts`
 * for the concrete implementations.
 */

import type { LLMProvider } from "../types.js";
import { AnthropicProvider } from "./anthropic.js";
import { ClaudeCodeProvider } from "./claude-code.js";

/**
 * Create an LLM provider.
 *
 * - `"anthropic"` — Claude API via `@anthropic-ai/sdk`; requires
 *   `ANTHROPIC_API_KEY` (construction throws when it is unset). Default model
 *   is `"claude-opus-4-8"`.
 * - `"claude-code"` — the local `claude` CLI in headless mode; no API key
 *   needed. When `model` is omitted the CLI's configured default is used.
 *
 * @param kind Which backend to use.
 * @param model Optional model override for the chosen backend.
 */
export function createProvider(kind: "anthropic" | "claude-code", model?: string): LLMProvider {
  switch (kind) {
    case "anthropic":
      return new AnthropicProvider(model);
    case "claude-code":
      return new ClaudeCodeProvider(model);
    default: {
      const unreachable: never = kind;
      throw new Error(
        `Unknown LLM provider kind "${String(unreachable)}" (expected "anthropic" or "claude-code").`,
      );
    }
  }
}
