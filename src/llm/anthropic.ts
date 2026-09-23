/**
 * Anthropic API provider.
 *
 * Talks to the Claude API through `@anthropic-ai/sdk`, streaming each
 * completion (generated files are long; streaming avoids HTTP timeouts) and
 * resolving the full message via `stream.finalMessage()`.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { CompletionRequest, CompletionResponse, LLMProvider } from "../types.js";

/** Model used when the caller does not specify one. */
const DEFAULT_MODEL = "claude-opus-4-8";

/** Default `max_tokens` — generation produces whole files, so leave headroom. */
const DEFAULT_MAX_TOKENS = 32000;

/**
 * {@link LLMProvider} backed by the Anthropic Messages API.
 *
 * The API key is read from the `ANTHROPIC_API_KEY` environment variable by
 * the SDK itself; construction fails fast with a descriptive error when the
 * variable is unset so misconfiguration surfaces before any LLM call.
 */
export class AnthropicProvider implements LLMProvider {
  /** Provider identifier, e.g. `"anthropic:claude-opus-4-8"`. */
  readonly name: string;

  private readonly client: Anthropic;
  private readonly model: string;

  /**
   * @param model Claude model id; defaults to `"claude-opus-4-8"`.
   * @throws {Error} when `ANTHROPIC_API_KEY` is not set in the environment.
   */
  constructor(model: string = DEFAULT_MODEL) {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error(
        'ANTHROPIC_API_KEY is not set. Export an Anthropic API key (e.g. `export ANTHROPIC_API_KEY=sk-ant-...`) ' +
          'to use the "anthropic" provider, or switch to the "claude-code" provider, which runs through the ' +
          "local Claude Code CLI and needs no API key.",
      );
    }
    this.client = new Anthropic(); // resolves ANTHROPIC_API_KEY from the environment
    this.model = model;
    this.name = `anthropic:${model}`;
  }

  /**
   * Run one completion: stream the response and return the concatenated text
   * of all `text` content blocks plus normalized token usage (cache-creation
   * and cache-read tokens are folded into `inputTokens`).
   */
  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    const stream = this.client.messages.stream({
      model: this.model,
      max_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
      system: req.system,
      messages: [{ role: "user", content: req.user }],
    });
    const msg = await stream.finalMessage();

    let text = "";
    for (const block of msg.content) {
      if (block.type === "text") {
        text += block.text;
      }
    }

    return {
      text,
      usage: {
        inputTokens:
          msg.usage.input_tokens +
          (msg.usage.cache_creation_input_tokens ?? 0) +
          (msg.usage.cache_read_input_tokens ?? 0),
        outputTokens: msg.usage.output_tokens,
      },
    };
  }
}
