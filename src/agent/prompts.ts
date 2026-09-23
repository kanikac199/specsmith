/**
 * Prompt engineering for specsmith's generation agent.
 *
 * Builds the system/user prompts for the three LLM call kinds (schema
 * generation, client generation, repair) and parses the `===FILE===` blocks
 * the model returns. Everything here is deterministic: the same `ClientIR`
 * always produces byte-identical prompts.
 */

import type {
  ClientIR,
  CompletionRequest,
  GeneratedFiles,
  JsonSchema,
  ResponseIR,
} from "../types.js";

/** Role preamble shared by every generation prompt. */
const ROLE =
  "You are an expert TypeScript + zod engineer generating runtime validators and typed HTTP " +
  "clients from OpenAPI specifications. You write complete, strict-mode TypeScript files that " +
  "compile and run correctly on the first attempt.";

/** Contract rules 1-9: zod conventions for schemas.ts. */
const SCHEMA_RULES = [
  "schemas.ts:",
  '1. Import ONLY from "zod" (`import { z } from "zod";`). No other imports.',
  "2. For every named component schema X, export exactly two declarations: " +
    "`export const XSchema = z....;` and `export type X = z.infer<typeof XSchema>;`. " +
    "The names `XSchema` and `X` must match the component name exactly (case-sensitive).",
  "3. Objects are plain z.object({ ... }). Never use .passthrough(), .strict(), or .catchall().",
  '4. A property is required only when listed in the schema\'s "required" array; every other property gets .optional().',
  '5. "nullable": true on a schema adds .nullable().',
  '6. Every string stays plain z.string() regardless of "format": "date-time" is z.string() ' +
    "(NOT z.string().datetime() — mock examples are not always RFC3339), and the same applies to " +
    "date, uuid, email, uri, byte, etc. Never add .datetime(), .uuid(), .email(), .url(), or format regexes.",
  '7. "type": "integer" is z.number().int(); "number" is z.number(); "boolean" is z.boolean().',
  '8. A string "enum" is z.enum([...]); non-string enums are a z.union of z.literal(...) members. ' +
    "oneOf/anyOf become z.union([...]). allOf of objects merges into a single z.object (or z.intersection). " +
    "An unconstrained schema {} is z.unknown().",
  "9. Declare schemas in dependency order: a schema constant must appear before any schema that references it. " +
    "For genuinely recursive shapes, write the TypeScript type by hand and use z.lazy() with an explicit annotation, e.g. " +
    "`export type Node = { children?: Node[] }; export const NodeSchema: z.ZodType<Node> = " +
    "z.lazy(() => z.object({ children: z.array(NodeSchema).optional() }));`.",
].join("\n");

/** Contract rules 10-22: the client.ts contract. */
const CLIENT_RULES = [
  "client.ts:",
  '10. Import ONLY from "zod" and "./schemas.js" (note the .js suffix). No other imports of any kind ' +
    "(no node:* modules, no Buffer). The file must compile under TypeScript strict mode.",
  "11. Export exactly this configuration interface:",
  "    export interface ClientConfig {",
  "      baseUrl: string;",
  "      apiKey?: string;",
  "      bearerToken?: string;",
  "      basicAuth?: { username: string; password: string };",
  "      headers?: Record<string, string>;",
  "      fetch?: typeof fetch;",
  "    }",
  "12. Export both error classes; each MUST set its `name` property to the class name via a class field:",
  '    export class ApiError extends Error { name = "ApiError"; status: number; body: unknown; }',
  '    export class ResponseValidationError extends Error { name = "ResponseValidationError"; issues: unknown; }',
  "    Constructor signatures are up to you, but the class names, the `name` field values, " +
    "`ApiError.status`, `ApiError.body`, and `ResponseValidationError.issues` are mandatory.",
  "13. Export `class ApiClient` with `constructor(config: ClientConfig)` and exactly ONE public async " +
    "method per operation, named exactly the operation's methodName.",
  "14. Every method takes a SINGLE object argument with one key per declared parameter (the exact " +
    "parameter name from the spec) plus a `body` key when the operation declares a request body. " +
    "Required parameters and a required body are required keys; optional ones are optional keys. " +
    "When every key is optional, the whole argument object itself must be optional too.",
  "15. Path parameters: substitute each {param} in the path template using encodeURIComponent(String(value)).",
  "16. Query parameters: skip undefined values; serialize arrays as repeated keys " +
    "(e.g. ?tag=a&tag=b — append once per element); serialize everything else with String(value).",
  "17. Auth comes from the config and is attached to EVERY request whenever configured, regardless of " +
    "per-operation requirements (harmless and robust): apiKey is sent per the spec's apiKey scheme " +
    "(its declared header/query/cookie name); bearerToken as `Authorization: Bearer <token>`; basicAuth as " +
    '`Authorization: Basic <credentials>` where credentials = btoa(username + ":" + password) ' +
    "(btoa is a global — do not import anything). When BOTH bearerToken and basicAuth are configured, " +
    "bearerToken wins (a single Authorization header). Also merge config.headers into every request, and " +
    "always send `Accept: application/json` so the server returns JSON.",
  "18. Serialize the request body according to the operation's requestBody.encoding field:\n" +
    "    - \"json\": send JSON.stringify(body) with Content-Type set to the declared content type.\n" +
    "    - \"form\": send a URLSearchParams encoding with Content-Type application/x-www-form-urlencoded — " +
    "build it by iterating the body object's own entries, skipping undefined, appending String(v) once per " +
    "element for array values and String(value) otherwise; do NOT JSON.stringify.\n" +
    "    - \"raw\": send the body as-is if it is a string, otherwise String(body), with Content-Type set to " +
    "the declared content type.\n" +
    "    Use (config.fetch ?? fetch) — the global fetch — for all requests, and join config.baseUrl and the " +
    "operation path without producing double slashes.",
  '19. Match the response definition by exact status code first, then the "2XX" entry, then "default".',
  "20. Non-2xx status (status < 200 || status >= 300): throw ApiError carrying the status and the parsed " +
    "body (JSON when parseable, otherwise the raw text).",
  "21. 2xx status whose matched response declares a schema: parse the JSON body and validate it with the " +
    "corresponding zod schema; on validation failure throw ResponseValidationError carrying the zod issues; " +
    "on success return { status, data } with data typed by that schema.",
  "22. 2xx status with no declared schema (e.g. 204): do not read or validate the body; return { status, data: undefined }.",
].join("\n");

/**
 * The generated-client contract: the numbered rules every generated
 * `schemas.ts`/`client.ts` pair must satisfy. Embedded verbatim in the
 * client-generation and repair prompts (and reusable in the README).
 */
export const CLIENT_CONTRACT = `GENERATED CLIENT CONTRACT — every numbered rule is mandatory.\n\n${SCHEMA_RULES}\n\n${CLIENT_RULES}`;

/** Output-format rules demanding `===FILE===` blocks and nothing else. */
function outputFormat(expected: string): string {
  return [
    "OUTPUT FORMAT — follow it exactly:",
    `- Reply with ${expected} and NOTHING else: no prose, no explanations, no markdown outside the markers.`,
    "- Each file is wrapped exactly like this:",
    "",
    "===FILE: <filename>===",
    "```typescript",
    "<complete file contents>",
    "```",
    "===END===",
    "",
    '- Always emit the COMPLETE file — never truncate or elide code with "...".',
  ].join("\n");
}

/** Output-format rules specific to repair calls (changed files only). */
const REPAIR_OUTPUT_RULES = [
  "OUTPUT FORMAT — follow it exactly:",
  "- Return ONLY the files that need changes; do not include unchanged files.",
  "- Every returned file must be COMPLETE (full file contents — never a diff, never elided code).",
  "- Wrap each file exactly like this:",
  "",
  "===FILE: <filename>===",
  "```typescript",
  "<complete file contents>",
  "```",
  "===END===",
  "",
  "- No prose outside the blocks. The only valid filenames are schemas.ts and client.ts " +
    "(index.ts is generated automatically — never return it).",
].join("\n");

/**
 * Build the prompt for the first LLM call: generate `schemas.ts` containing
 * one zod schema + inferred type per named component schema in the IR.
 */
export function buildSchemasPrompt(ir: ClientIR): CompletionRequest {
  const names = Object.keys(ir.schemas);
  const system = [
    ROLE,
    outputFormat('a single "===FILE: schemas.ts===" block (the filename must be exactly "schemas.ts")'),
    `ZOD SCHEMA RULES — every numbered rule is mandatory.\n\n${SCHEMA_RULES}`,
  ].join("\n\n");

  const parts: string[] = [`API: ${ir.title} v${ir.version}`];
  if (names.length === 0) {
    parts.push(
      "This API declares no named component schemas. Emit a schemas.ts whose entire content is:\n\nexport {};"
    );
  } else {
    parts.push(
      "Named component schemas (dereferenced JSON Schema), as JSON:",
      JSON.stringify(ir.schemas, null, 2),
      "Required exports — every one of these must be exported from schemas.ts:",
      names.map((n) => `- export const ${n}Schema = z....; export type ${n} = z.infer<typeof ${n}Schema>;`).join("\n"),
      "Schemas may reference each other: declare referenced schemas BEFORE the schemas that use them " +
        "(dependency order). For genuinely recursive shapes, declare the TypeScript type explicitly and " +
        "use z.lazy() with an explicit z.ZodType annotation (rule 9)."
    );
  }
  return { system, user: parts.join("\n\n") };
}

/** Compact, deterministic description of one response for the client prompt. */
interface ResponseDescriptor {
  status: string;
  hasSchema: boolean;
  contentType?: string;
  /** Exact zod expression to validate the body with (names exported by schemas.ts). */
  validate?: string;
  /** TypeScript type of the returned `data` when `validate` is present. */
  dataType?: string;
  /** Inline schema, included only when no named component matches. */
  schema?: JsonSchema;
}

/** Bounded structural equality — cheap reference check first, then deep compare. */
function deepEqual(a: unknown, b: unknown, depth = 0): boolean {
  if (a === b) return true;
  if (depth > 64) return false; // defensive cap against pathological nesting
  if (typeof a !== typeof b || typeof a !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((item, i) => deepEqual(item, b[i], depth + 1));
  }
  const recA = a as Record<string, unknown>;
  const recB = b as Record<string, unknown>;
  const keysA = Object.keys(recA);
  const keysB = Object.keys(recB);
  if (keysA.length !== keysB.length) return false;
  return keysA.every(
    (key) => Object.prototype.hasOwnProperty.call(recB, key) && deepEqual(recA[key], recB[key], depth + 1)
  );
}

/**
 * Find the named component a schema corresponds to: reference equality first
 * (dereferencing shares object instances), then deep equality. Deterministic
 * (component insertion order).
 */
function findComponentName(schema: JsonSchema, components: Record<string, JsonSchema>): string | undefined {
  for (const [name, comp] of Object.entries(components)) {
    if (comp === schema) return name;
  }
  for (const [name, comp] of Object.entries(components)) {
    if (deepEqual(schema, comp)) return name;
  }
  return undefined;
}

/** Precompute the response→zod-validator mapping for one response. */
function describeResponse(res: ResponseIR, components: Record<string, JsonSchema>): ResponseDescriptor {
  if (res.schema === undefined) {
    return { status: res.status, hasSchema: false };
  }
  const direct = findComponentName(res.schema, components);
  if (direct !== undefined) {
    return {
      status: res.status,
      hasSchema: true,
      contentType: res.contentType,
      validate: `${direct}Schema`,
      dataType: direct,
    };
  }
  const items = res.schema["items"];
  if (res.schema["type"] === "array" && typeof items === "object" && items !== null && !Array.isArray(items)) {
    const itemName = findComponentName(items as JsonSchema, components);
    if (itemName !== undefined) {
      return {
        status: res.status,
        hasSchema: true,
        contentType: res.contentType,
        validate: `z.array(${itemName}Schema)`,
        dataType: `${itemName}[]`,
      };
    }
  }
  return { status: res.status, hasSchema: true, contentType: res.contentType, schema: res.schema };
}

/** How the model must use the precomputed response descriptors. */
const RESPONSE_VALIDATION_INSTRUCTIONS = [
  "Response validation map — apply it mechanically to every response entry above:",
  '- An entry with "validate" gives the EXACT zod expression to validate the parsed JSON body with ' +
    '(every name in it is exported by "./schemas.js"); "dataType" is the TypeScript type of the returned `data`.',
  '- An entry with "hasSchema": true but NO "validate" has an anonymous schema: parse the JSON body but ' +
    "validate it with z.unknown() — it must NEVER throw ResponseValidationError; type `data` as unknown.",
  '- An entry with "hasSchema": false carries no body schema: return { status, data: undefined } without reading the body.',
].join("\n");

/**
 * Build the prompt for the second LLM call: generate `client.ts` (the
 * `ApiClient` class) against an already generated `schemas.ts` source.
 */
export function buildClientPrompt(ir: ClientIR, schemasSource: string): CompletionRequest {
  const system = [
    ROLE,
    CLIENT_CONTRACT,
    outputFormat('a single "===FILE: client.ts===" block (the filename must be exactly "client.ts")'),
  ].join("\n\n");

  const operations = ir.operations.map((op) => ({
    id: op.operationId,
    methodName: op.methodName,
    method: op.method,
    path: op.path,
    requiresAuth: op.requiresAuth,
    params: op.params.map((p) => ({ name: p.name, in: p.in, required: p.required, schema: p.schema })),
    requestBody: op.requestBody
      ? {
          required: op.requestBody.required,
          contentType: op.requestBody.contentType,
          encoding: op.requestBody.encoding,
          schema: op.requestBody.schema,
        }
      : undefined,
    responses: op.responses.map((res) => describeResponse(res, ir.schemas)),
  }));

  const user = [
    `API: ${ir.title} v${ir.version}`,
    `Default base URL: ${ir.baseUrl ?? "(none declared — rely on config.baseUrl)"}`,
    "Security schemes (JSON):",
    JSON.stringify(ir.auth, null, 1),
    "Operations (JSON). Generate one ApiClient method per entry, named exactly `methodName`:",
    JSON.stringify(operations, null, 1),
    RESPONSE_VALIDATION_INSTRUCTIONS,
    'schemas.ts has already been generated — client.ts imports it from "./schemas.js" and must use these exact export names:',
    "```typescript\n" + schemasSource + "\n```",
    "Return ONLY the ===FILE: client.ts=== block.",
  ].join("\n\n");

  return { system, user };
}

/** Preferred presentation order for generated files in repair prompts. */
const FILE_ORDER = ["schemas.ts", "client.ts", "index.ts"];

/**
 * Build a repair prompt: the current files verbatim plus validation feedback
 * (compile errors or mock-exercise failures). The model must return only the
 * changed files, complete, and must not rename any export.
 */
export function buildRepairPrompt(ir: ClientIR, files: GeneratedFiles, feedback: string): CompletionRequest {
  const system = [ROLE, CLIENT_CONTRACT, REPAIR_OUTPUT_RULES].join("\n\n");

  const names = [
    ...FILE_ORDER.filter((name) => name in files),
    ...Object.keys(files)
      .filter((name) => !FILE_ORDER.includes(name))
      .sort(),
  ];
  const sections: string[] = [
    `API: ${ir.title} v${ir.version}`,
    "The previously generated client failed validation. Current files:",
  ];
  for (const name of names) {
    const content = files[name];
    if (content === undefined) continue;
    sections.push(`--- ${name} ---\n\`\`\`typescript\n${content}\n\`\`\``);
  }
  sections.push("Validation feedback — fix every issue:", feedback);
  sections.push(
    [
      "Reminders:",
      "- Do NOT rename or remove ANY exported name: every XSchema constant and X type, ClientConfig, " +
        "ApiError, ResponseValidationError, ApiClient, and every operation method name must stay exactly as-is.",
      "- All contract rules still apply.",
      "- Return ONLY the changed files, each as COMPLETE contents in a ===FILE: <name>=== block ending with ===END===.",
    ].join("\n")
  );

  return { system, user: sections.join("\n\n") };
}

/** Trim trailing whitespace and guarantee a single trailing newline; undefined when blank. */
function normalizeContent(body: string): string | undefined {
  const trimmed = body.replace(/\s+$/u, "");
  return trimmed.length === 0 ? undefined : `${trimmed}\n`;
}

/**
 * Tolerant parser for the `===FILE===` output format.
 *
 * Primary pass matches well-formed blocks (`===FILE: name===`, a fenced
 * typescript block, `===END===`). A fallback pass tolerates a missing
 * `===END===` / closing fence by capturing up to the next `===FILE:` marker
 * or the end of the text. Within each pass the last occurrence of a filename
 * wins; well-formed (primary) blocks take precedence over fallback captures.
 * Everything outside the markers is ignored. Returns `{}` when nothing
 * matches.
 */
export function parseFiles(text: string): GeneratedFiles {
  const primary: GeneratedFiles = {};
  // Tempered capture: a block's body may not swallow a following ===FILE: marker.
  const primaryRe =
    /===FILE:\s*([^=]+?)\s*===\s*\n```(?:typescript|ts)?\n((?:(?!===FILE:)[\s\S])*?)```\s*\n?===END===/g;
  for (const match of text.matchAll(primaryRe)) {
    const name = match[1]?.trim();
    const body = match[2];
    if (name === undefined || name.length === 0 || body === undefined) continue;
    const content = normalizeContent(body);
    if (content !== undefined) primary[name] = content;
  }

  const fallback: GeneratedFiles = {};
  // Capture whether an opening fence was consumed so we can cut the body at the
  // matching closing fence (the model often follows the fence with prose).
  const fallbackRe = /===FILE:\s*([^=]+?)\s*===\s*\n(```(?:typescript|ts)?\n)?([\s\S]*?)(?=\n===FILE:|$)/g;
  for (const match of text.matchAll(fallbackRe)) {
    const name = match[1]?.trim();
    const hadFence = match[2] !== undefined;
    let body = match[3];
    if (name === undefined || name.length === 0 || body === undefined) continue;
    const endIdx = body.indexOf("\n===END===");
    if (endIdx !== -1) body = body.slice(0, endIdx);
    if (hadFence) {
      // Cut at the first line that is only a closing fence — anything after it
      // (a stray fence plus the model's explanation) is not file content.
      const fenceMatch = /\n[ \t]*```[ \t]*(?:\n|$)/.exec(body);
      if (fenceMatch !== null) body = body.slice(0, fenceMatch.index);
    } else {
      body = body.replace(/\n?```\s*$/u, "");
    }
    const content = normalizeContent(body);
    if (content !== undefined) fallback[name] = content;
  }

  return { ...fallback, ...primary };
}
