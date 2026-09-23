/**
 * Runtime exercise of a generated client against a Prism mock.
 *
 * Dynamically imports the transpiled client bundle, instantiates `ApiClient`
 * with test credentials, and calls every operation's method with
 * deterministic sampled arguments. Failures are classified into
 * request-validation vs response-validation problems (by error `name` — never
 * `instanceof`, which does not survive bundling) and become repair feedback.
 * One operation's failure never aborts the rest.
 */

import { pathToFileURL } from "node:url";
import type { ClientIR, ExerciseResult, OpExerciseResult, OperationIR } from "../types.js";
import { buildOpArgs } from "../util/sample.js";

/**
 * The full set of test credentials. The generated client picks the ones a
 * given request needs; {@link authForSpec} narrows this to only the schemes a
 * spec actually declares so that `bearerToken` and `basicAuth` (which both
 * target the single `Authorization` header) are never sent together.
 */
export const TEST_AUTH = {
  apiKey: "specsmith-test-key",
  bearerToken: "specsmith-test-token",
  basicAuth: { username: "specsmith", password: "specsmith" },
};

/**
 * Select the credentials to configure the client with, based on the spec's
 * declared security schemes. Sending both `bearerToken` and `basicAuth` would
 * collide on the `Authorization` header; here `http: basic` is the only thing
 * that enables `basicAuth`, and bearer/oauth2/openIdConnect enable
 * `bearerToken`. When the spec declares no auth, all credentials are supplied
 * (harmless — the client only attaches what each request requires).
 */
export function authForSpec(auth: ClientIR["auth"]): Record<string, unknown> {
  if (auth.length === 0) return { ...TEST_AUTH };
  const config: Record<string, unknown> = {};
  const hasApiKey = auth.some((a) => a.kind === "apiKey");
  const hasBasic = auth.some((a) => a.kind === "http" && a.scheme === "basic");
  const hasBearer = auth.some(
    (a) =>
      a.kind === "oauth2" ||
      a.kind === "openIdConnect" ||
      (a.kind === "http" && a.scheme !== "basic"),
  );
  if (hasApiKey) config["apiKey"] = TEST_AUTH.apiKey;
  if (hasBearer) config["bearerToken"] = TEST_AUTH.bearerToken;
  else if (hasBasic) config["basicAuth"] = TEST_AUTH.basicAuth;
  return config;
}

const CALL_TIMEOUT_MS = 15_000;
const TIMEOUT_SENTINEL: unique symbol = Symbol("specsmith.timeout");

type DynamicClient = Record<string, unknown>;
type ClientCtor = new (config: Record<string, unknown>) => DynamicClient;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function safeStringify(value: unknown): string {
  try {
    const json = JSON.stringify(value);
    return json ?? String(value);
  } catch {
    return String(value);
  }
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

/** Locate the ApiClient constructor among the bundle's exports. */
function findApiClient(mod: Record<string, unknown>, bundlePath: string): ClientCtor {
  const def = mod["default"];
  const candidate = mod["ApiClient"] ?? (isRecord(def) ? def["ApiClient"] : undefined) ?? def;
  if (typeof candidate !== "function") {
    throw new Error(
      `Bundle at ${bundlePath} does not export an ApiClient constructor ` +
        `(checked "ApiClient", "default.ApiClient", and "default"; exports: ${Object.keys(mod).join(", ") || "none"}).`
    );
  }
  // The bundle is untyped at runtime; the contract guarantees a constructable class.
  return candidate as unknown as ClientCtor;
}

/**
 * Exercise every operation in `ir` through the bundled client at `bundlePath`
 * against the mock at `baseUrl`. Operations run sequentially with a 15s
 * timeout each; results are classified per operation and aggregated.
 */
export async function exerciseClient(bundlePath: string, ir: ClientIR, baseUrl: string): Promise<ExerciseResult> {
  const mod = (await import(pathToFileURL(bundlePath).href)) as Record<string, unknown>;
  const ApiClient = findApiClient(mod, bundlePath);

  let client: DynamicClient;
  try {
    client = new ApiClient({ baseUrl, ...authForSpec(ir.auth) });
  } catch (err) {
    // A throwing constructor is a client bug: report it as feedback on every
    // operation instead of crashing the repair loop.
    const failure = `ApiClient constructor threw: ${err instanceof Error ? err.message : String(err)}`;
    const ops = ir.operations.map<OpExerciseResult>((op) => ({
      operationId: op.operationId,
      methodFound: false,
      requestOk: false,
      responseOk: false,
      failure,
    }));
    return { total: ops.length, methodsFound: 0, requestsOk: 0, responsesOk: 0, ops };
  }

  const ops: OpExerciseResult[] = [];
  for (const op of ir.operations) {
    ops.push(await exerciseOp(client, op));
  }

  return {
    total: ops.length,
    methodsFound: ops.filter((o) => o.methodFound).length,
    requestsOk: ops.filter((o) => o.requestOk).length,
    responsesOk: ops.filter((o) => o.responseOk).length,
    ops,
  };
}

/** Call one operation's method with sampled args; classify the outcome. */
async function exerciseOp(client: DynamicClient, op: OperationIR): Promise<OpExerciseResult> {
  const method = client[op.methodName];
  if (typeof method !== "function") {
    return {
      operationId: op.operationId,
      methodFound: false,
      requestOk: false,
      responseOk: false,
      failure: `client instance has no method "${op.methodName}"`,
    };
  }

  const args = buildOpArgs(op);
  let timer: NodeJS.Timeout | undefined;
  try {
    const timeout = new Promise<typeof TIMEOUT_SENTINEL>((resolve) => {
      timer = setTimeout(() => resolve(TIMEOUT_SENTINEL), CALL_TIMEOUT_MS);
    });
    const outcome = await Promise.race([
      Promise.resolve((method as (arg: unknown) => unknown).call(client, args)),
      timeout,
    ]);
    if (outcome === TIMEOUT_SENTINEL) {
      return {
        operationId: op.operationId,
        methodFound: true,
        requestOk: false,
        responseOk: false,
        failure: "timed out after 15s",
      };
    }
    return { operationId: op.operationId, methodFound: true, requestOk: true, responseOk: true };
  } catch (err) {
    return classifyError(op, err);
  } finally {
    clearTimeout(timer);
  }
}

/** Map a thrown error to an OpExerciseResult per the classification contract. */
function classifyError(op: OperationIR, err: unknown): OpExerciseResult {
  const base = { operationId: op.operationId, methodFound: true };
  const name = isRecord(err) && typeof err["name"] === "string" ? err["name"] : undefined;

  if (name === "ApiError") {
    const status = isRecord(err) && typeof err["status"] === "number" ? err["status"] : undefined;
    if (status !== undefined && status >= 500) {
      // The mock could not produce a response — not the client's fault.
      return {
        ...base,
        requestOk: true,
        responseOk: true,
        failure: "mock returned 5xx (mock limitation, not counted against client)",
      };
    }
    const body = isRecord(err) ? err["body"] : undefined;
    return {
      ...base,
      requestOk: false,
      responseOk: false,
      failure:
        `mock rejected the request with HTTP ${status ?? "<unknown status>"}: ` +
        truncate(safeStringify(body), 500),
    };
  }

  if (name === "ResponseValidationError") {
    const issues = isRecord(err) ? err["issues"] : undefined;
    return {
      ...base,
      requestOk: true,
      responseOk: false,
      failure: `response failed zod validation: ${truncate(safeStringify(issues), 500)}`,
    };
  }

  return {
    ...base,
    requestOk: false,
    responseOk: false,
    failure: err instanceof Error ? err.message : String(err),
  };
}
