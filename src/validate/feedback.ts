/**
 * Repair-feedback rendering.
 *
 * Turns compile diagnostics and runtime exercise results into compact,
 * actionable text the LLM can use to fix the generated client. Output is
 * grouped, includes the relevant IR fragments (params, body/response
 * schemas), and is hard-capped so prompts stay bounded.
 */

import type { ClientIR, CompileResult, ExerciseResult, OperationIR, ResponseIR } from "../types.js";

const COMPILE_MAX_ERRORS = 80;
const COMPILE_MAX_CHARS = 8_000;
const EXERCISE_MAX_CHARS = 9_000;
const SCHEMA_SNIPPET_CHARS = 600;

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function safeStringify(value: unknown): string {
  try {
    const json = JSON.stringify(value);
    return json ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * Render TypeScript compile errors as repair feedback: a header with the
 * error count, then `file:line message` lines grouped per file. Capped at
 * 80 errors and ~8000 characters.
 */
export function renderCompileFeedback(r: CompileResult): string {
  if (r.errors.length === 0) {
    return "TypeScript compilation succeeded.";
  }
  const shown = r.errors.slice(0, COMPILE_MAX_ERRORS);

  // Group by file, preserving first-seen order.
  const groups = new Map<string, string[]>();
  for (const error of shown) {
    const file = error.file ?? "(no file)";
    const location = error.line !== undefined ? `${file}:${error.line}` : file;
    const line = `${location} ${error.message.replace(/\n/g, "\n  ")}`;
    const group = groups.get(file);
    if (group !== undefined) group.push(line);
    else groups.set(file, [line]);
  }

  const plural = r.errors.length === 1 ? "" : "s";
  const lines: string[] = [`TypeScript compilation failed with ${r.errors.length} error${plural}:`];
  for (const group of groups.values()) {
    lines.push("", ...group);
  }
  if (r.errors.length > shown.length) {
    lines.push(`...(truncated, ${r.errors.length - shown.length} more errors omitted)`);
  }

  let text = lines.join("\n");
  if (text.length > COMPILE_MAX_CHARS) {
    text = `${text.slice(0, COMPILE_MAX_CHARS)}\n...(truncated)`;
  }
  return text;
}

/**
 * Render runtime exercise failures as repair feedback: a summary header, then
 * one block per failing operation with the failure detail and the relevant IR
 * fragments (expected params, request body schema, response schema for
 * validation failures). Capped at ~9000 characters.
 */
export function renderExerciseFeedback(r: ExerciseResult, ir: ClientIR): string {
  const header =
    `Runtime exercise against a spec-faithful mock server: ` +
    `${r.requestsOk}/${r.total} requests accepted, ${r.responsesOk}/${r.total} responses validated.`;

  const opsById = new Map(ir.operations.map((op) => [op.operationId, op]));
  const blocks: string[] = [];
  for (const result of r.ops) {
    if (result.methodFound && result.requestOk && result.responseOk) continue;
    blocks.push(renderOpBlock(result.operationId, result.failure, result.requestOk, result.responseOk, opsById));
  }

  let text = header;
  for (const block of blocks) {
    if (text.length + block.length + 1 > EXERCISE_MAX_CHARS) {
      text += "\n...(truncated)";
      break;
    }
    text += `\n${block}`;
  }
  return text;
}

/** Render one failing operation's feedback block with its IR context. */
function renderOpBlock(
  operationId: string,
  failure: string | undefined,
  requestOk: boolean,
  responseOk: boolean,
  opsById: Map<string, OperationIR>
): string {
  const detail = failure ?? "failed";
  const op = opsById.get(operationId);
  if (op === undefined) {
    return `- ${operationId}: ${detail}`;
  }

  const lines: string[] = [`- ${op.methodName} (${op.method.toUpperCase()} ${op.path}): ${detail}`];
  if (op.params.length > 0) {
    const params = op.params.map((p) => ({ name: p.name, in: p.in, required: p.required }));
    lines.push(`  expected params: ${safeStringify(params)}`);
  }
  if (op.requestBody !== undefined) {
    lines.push(`  request body schema: ${truncate(safeStringify(op.requestBody.schema), SCHEMA_SNIPPET_CHARS)}`);
  }
  if (requestOk && !responseOk) {
    const response = pickSuccessResponse(op);
    if (response?.schema !== undefined) {
      lines.push(
        `  response schema (${response.status}): ${truncate(safeStringify(response.schema), SCHEMA_SNIPPET_CHARS)}`
      );
    }
  }
  return lines.join("\n");
}

/** The success response whose schema the client should have validated: exact 2xx, else "2XX", else "default". */
function pickSuccessResponse(op: OperationIR): ResponseIR | undefined {
  const withSchema = op.responses.filter((res) => res.schema !== undefined);
  return (
    withSchema.find((res) => /^2\d\d$/.test(res.status)) ??
    withSchema.find((res) => res.status.toUpperCase() === "2XX") ??
    withSchema.find((res) => res.status === "default")
  );
}
