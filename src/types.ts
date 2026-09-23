/**
 * Core shared types for specsmith.
 *
 * Every module implements against these contracts. Keep this file
 * dependency-free (types only, no runtime imports beyond TS lib).
 */

// ---------------------------------------------------------------------------
// Intermediate Representation (IR) of an OpenAPI spec
// ---------------------------------------------------------------------------

/** A JSON Schema fragment (already dereferenced — no $ref cycles except via x-circular markers). */
export type JsonSchema = Record<string, unknown>;

export type HttpMethod = "get" | "put" | "post" | "delete" | "options" | "head" | "patch" | "trace";

export type ParamLocation = "path" | "query" | "header" | "cookie";

export interface ParamIR {
  name: string;
  in: ParamLocation;
  required: boolean;
  description?: string;
  schema: JsonSchema;
}

/** How a request body must be serialized on the wire. */
export type BodyEncoding = "json" | "form" | "raw";

export interface BodyIR {
  required: boolean;
  /** The selected content type, e.g. "application/json". */
  contentType: string;
  /**
   * Wire serialization derived from `contentType`: `json` for
   * application/json and *+json types, `form` for
   * application/x-www-form-urlencoded, `raw` for everything else
   * (multipart, octet-stream, text/*, …).
   */
  encoding: BodyEncoding;
  schema: JsonSchema;
  description?: string;
}

export interface ResponseIR {
  /** Status code as written in the spec: "200", "404", or "default". */
  status: string;
  description?: string;
  /** Selected content type if a body is defined. */
  contentType?: string;
  schema?: JsonSchema;
}

export type AuthScheme =
  | { kind: "apiKey"; name: string; in: "header" | "query" | "cookie"; schemeName: string }
  | { kind: "http"; scheme: "bearer" | "basic" | string; schemeName: string }
  | { kind: "oauth2"; schemeName: string }
  | { kind: "openIdConnect"; schemeName: string };

export interface OperationIR {
  /** Always present — synthesized from method+path when the spec omits operationId. */
  operationId: string;
  /** camelCase method name the generated client must expose. */
  methodName: string;
  method: HttpMethod;
  /** Path template as written in the spec, e.g. "/pets/{petId}". */
  path: string;
  summary?: string;
  description?: string;
  /** First tag, or "default". Used for chunking generation. */
  tag: string;
  params: ParamIR[];
  requestBody?: BodyIR;
  responses: ResponseIR[];
  /** True if the operation requires auth per the spec (operation- or root-level security). */
  requiresAuth: boolean;
  deprecated?: boolean;
}

export interface ClientIR {
  title: string;
  version: string;
  description?: string;
  /** First server URL, if any. */
  baseUrl?: string;
  auth: AuthScheme[];
  operations: OperationIR[];
  /**
   * Named component schemas (dereferenced). Keys are the original
   * `components.schemas` names; generated code must export a zod schema
   * named `<Name>Schema` and a type named `<Name>` for each.
   */
  schemas: Record<string, JsonSchema>;
}

// ---------------------------------------------------------------------------
// LLM provider abstraction
// ---------------------------------------------------------------------------

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface CompletionRequest {
  system: string;
  user: string;
  /** Defaults to provider-specific value (large; generation produces whole files). */
  maxTokens?: number;
}

export interface CompletionResponse {
  text: string;
  usage: TokenUsage;
}

export interface LLMProvider {
  /** e.g. "anthropic:claude-opus-4-8" or "claude-code:default" */
  readonly name: string;
  complete(req: CompletionRequest): Promise<CompletionResponse>;
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

/** Map of relative file path -> file contents, e.g. { "schemas.ts": "...", "client.ts": "..." } */
export type GeneratedFiles = Record<string, string>;

export interface CompileError {
  file?: string;
  line?: number;
  message: string;
}

export interface CompileResult {
  ok: boolean;
  errors: CompileError[];
}

/** Outcome of exercising one operation against the mock server. */
export interface OpExerciseResult {
  operationId: string;
  /** Client exposed a callable method for this operation. */
  methodFound: boolean;
  /** The request was accepted by the spec-validating mock (no 4xx validation error, no thrown request-build error). */
  requestOk: boolean;
  /** The response body parsed/validated against the generated zod schema. */
  responseOk: boolean;
  /** Human-readable failure detail used for repair feedback. */
  failure?: string;
}

export interface ExerciseResult {
  total: number;
  methodsFound: number;
  requestsOk: number;
  responsesOk: number;
  ops: OpExerciseResult[];
}

export type IterationKind = "initial" | "compile-repair" | "runtime-repair";

export interface IterationRecord {
  index: number;
  kind: IterationKind;
  compile: CompileResult;
  exercise?: ExerciseResult;
  /**
   * Set when this iteration could not be validated normally: a provider error
   * (the repair call threw) or an exercise-infrastructure failure (the mock
   * could not boot / the bundle could not be imported). Distinct from a
   * compile failure, which is a model fault recorded in `compile`.
   */
  error?: string;
  usage: TokenUsage;
  wallTimeMs: number;
}

export interface GenerateOptions {
  provider: LLMProvider;
  /** Max repair iterations after the initial generation. Default 3. */
  maxIterations?: number;
  /** Skip the mock-server exercise phase (compile-only loop). */
  exercise?: boolean;
  /** Directory for scratch compilation output. Defaults to a tmp dir. */
  workDir?: string;
  /** Progress callback for CLI display. */
  onProgress?: (msg: string) => void;
}

export interface GenerationResult {
  files: GeneratedFiles;
  iterations: IterationRecord[];
  /**
   * Compile state of the **returned** `files`. When the loop falls back to an
   * earlier best file set, this reflects that set — NOT the last iteration
   * record (which may describe a worse, discarded attempt). Always read this,
   * not `iterations.at(-1)`, to describe what was actually produced.
   */
  finalCompile: CompileResult;
  /** Exercise state of the **returned** `files` (undefined if exercising was disabled or never ran). */
  finalExercise?: ExerciseResult;
  /** Aggregated across all LLM calls. */
  usage: TokenUsage;
  wallTimeMs: number;
}

// ---------------------------------------------------------------------------
// Evals
// ---------------------------------------------------------------------------

export interface SpecManifestEntry {
  /** Stable id, e.g. "petstore". */
  id: string;
  /** Path to the spec file, relative to the manifest. */
  file: string;
  title: string;
  /** easy | medium | hard — by structural complexity. */
  tier: "easy" | "medium" | "hard";
  source: string;
  license?: string;
  notes?: string;
}

export interface IterationMetrics {
  index: number;
  kind: IterationKind;
  compileOk: boolean;
  compileErrorCount: number;
  /** Fractions in [0,1]; undefined when the phase didn't run. */
  requestSuccessRate?: number;
  responseValidationRate?: number;
}

export interface SpecEvalResult {
  specId: string;
  title: string;
  tier: string;
  operationCount: number;
  schemaCount: number;

  /** Final state. */
  compiled: boolean;
  operationCoverage: number;
  requestSuccessRate: number;
  responseValidationRate: number;
  /** Fraction of named schemas whose generated type is mutually assignable with openapi-typescript ground truth. Undefined if probe skipped. */
  typeFidelity?: number;

  /** Self-correction lift: final minus iteration-0 rates. */
  iterations: IterationMetrics[];
  iterationsUsed: number;

  usage: TokenUsage;
  wallTimeMs: number;
  error?: string;
}

export interface EvalRunResult {
  runId: string;
  startedAt: string;
  provider: string;
  maxIterations: number;
  specs: SpecEvalResult[];
}
