/**
 * A deterministic, offline LLMProvider for integration tests.
 *
 * Responses are scripted up front and returned in order; every
 * CompletionRequest is recorded in `calls` so tests can assert on the prompts
 * the pipeline actually sent. Throws when the script is exhausted.
 */

import type {
  CompletionRequest,
  CompletionResponse,
  LLMProvider,
  TokenUsage,
} from "../../src/types.js";

export interface ScriptedResponse {
  text: string;
  /** Defaults to { inputTokens: 0, outputTokens: 0 }. */
  usage?: TokenUsage;
}

export class FakeProvider implements LLMProvider {
  readonly name = "fake:scripted";
  /** Every request passed to complete(), in call order. */
  readonly calls: CompletionRequest[] = [];
  private readonly queue: ScriptedResponse[];

  constructor(script: ReadonlyArray<string | ScriptedResponse>) {
    this.queue = script.map((entry) => (typeof entry === "string" ? { text: entry } : { ...entry }));
  }

  /** Number of scripted responses not yet consumed. */
  get remaining(): number {
    return this.queue.length;
  }

  complete(req: CompletionRequest): Promise<CompletionResponse> {
    this.calls.push(req);
    const next = this.queue.shift();
    if (next === undefined) {
      return Promise.reject(
        new Error(`FakeProvider script exhausted: call #${this.calls.length} has no scripted response`)
      );
    }
    return Promise.resolve({
      text: next.text,
      usage: next.usage ?? { inputTokens: 0, outputTokens: 0 },
    });
  }
}

/** Wrap file contents in the ===FILE=== output format the generation prompts demand. */
export function fileBlock(name: string, contents: string): string {
  const body = contents.endsWith("\n") ? contents : `${contents}\n`;
  return `===FILE: ${name}===\n\`\`\`typescript\n${body}\`\`\`\n===END===\n`;
}
