/**
 * Pure normalization of a dereferenced OpenAPI 3.x document into the compact
 * `ClientIR` shape defined in `src/types.ts`.
 *
 * This module performs no I/O and never throws on malformed/missing fields:
 * every lookup is defensively narrowed, and any schema node that still
 * contains a `$ref` after dereferencing (i.e. a circular reference left
 * behind by `dereference: { circular: "ignore" }`) is replaced with the
 * permissive empty schema `{}`.
 */

import type {
  AuthScheme,
  BodyEncoding,
  BodyIR,
  ClientIR,
  HttpMethod,
  JsonSchema,
  OperationIR,
  ParamIR,
  ParamLocation,
  ResponseIR,
} from "../types.js";

type UnknownRecord = Record<string, unknown>;

const HTTP_METHODS: readonly HttpMethod[] = [
  "get",
  "put",
  "post",
  "delete",
  "options",
  "head",
  "patch",
  "trace",
];

const PARAM_LOCATIONS: readonly ParamLocation[] = ["path", "query", "header", "cookie"];

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** Split arbitrary text into alphanumeric word chunks (camelCase building blocks). */
function splitWords(text: string): string[] {
  return text.split(/[^A-Za-z0-9]+/).filter((word) => word.length > 0);
}

function upperFirst(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/**
 * Synthesize an operationId from an HTTP method and a path template.
 * Path parameters are included without their braces:
 * `synthesizeOperationId("get", "/pets/{petId}")` → `"getPetsPetId"`.
 */
export function synthesizeOperationId(method: string, path: string): string {
  const segments = path
    .split("/")
    .flatMap((segment) => splitWords(segment.replace(/[{}]/g, "")));
  return method.toLowerCase() + segments.map(upperFirst).join("");
}

/**
 * Turn an operationId into a valid camelCase JS identifier:
 * non-alphanumerics are stripped (acting as word boundaries), the first
 * character is lowercased, and a leading digit gets an "op" prefix.
 */
function sanitizeToIdentifier(operationId: string): string {
  const [first, ...rest] = splitWords(operationId);
  if (first === undefined) return "op";
  let name =
    first.charAt(0).toLowerCase() + first.slice(1) + rest.map(upperFirst).join("");
  if (/^[0-9]/.test(name)) name = `op${name}`;
  return name;
}

/** Reserve a unique name in `used`, appending numeric suffixes (foo, foo2, foo3, …). */
function dedupeName(base: string, used: Set<string>): string {
  let candidate = base;
  for (let suffix = 2; used.has(candidate); suffix += 1) {
    candidate = `${base}${suffix}`;
  }
  used.add(candidate);
  return candidate;
}

/** Resolve a local JSON pointer (`#/a/b/c`) against the document root; undefined if unresolvable. */
function resolveJsonPointer(doc: UnknownRecord, ref: string): unknown {
  if (!ref.startsWith("#/")) return undefined;
  const parts = ref
    .slice(2)
    .split("/")
    .map((p) => p.replace(/~1/g, "/").replace(/~0/g, "~"));
  let current: unknown = doc;
  for (const part of parts) {
    if (!isRecord(current)) return undefined;
    current = current[part];
  }
  return current;
}

/**
 * Normalize OpenAPI 3.1 type arrays into the 3.0 shape the rest of the
 * pipeline (sampler, zod prompt rules) understands: `type: ["string", "null"]`
 * becomes `type: "string"` plus `nullable: true`. A lone `type: ["null"]`
 * collapses to `nullable: true` with no `type`.
 */
function normalizeTypeArray(out: UnknownRecord): void {
  const type = out["type"];
  if (!Array.isArray(type)) return;
  const named = type.filter((t): t is string => typeof t === "string");
  const hasNull = named.includes("null");
  const nonNull = named.filter((t) => t !== "null");
  if (hasNull) out["nullable"] = true;
  if (nonNull.length === 1) out["type"] = nonNull[0];
  else if (nonNull.length === 0) delete out["type"];
  else out["type"] = nonNull[0]; // multiple non-null types: keep the first (best-effort)
}

/**
 * Deep-clone a schema value while resolving the circular `$ref` nodes the
 * dereferencer left behind (`dereference: { circular: "ignore" }`). A leftover
 * `{ "$ref": "#/components/schemas/X" }` is inlined as a one-level-expanded,
 * scrubbed copy of `X`; the inner self-reference at the next level collapses
 * to `{}` because the same target object is already on the recursion stack.
 * Non-resolvable `$ref`s and true object-graph cycles collapse to `{}`. The
 * `WeakSet` stack guarantees termination.
 */
function scrubValue(value: unknown, stack: WeakSet<object>, doc: UnknownRecord): unknown {
  if (Array.isArray(value)) {
    if (stack.has(value)) return [];
    stack.add(value);
    const items = value.map((item) => scrubValue(item, stack, doc));
    stack.delete(value);
    return items;
  }
  if (isRecord(value)) {
    if ("$ref" in value) {
      const ref = asString(value["$ref"]);
      const target = ref !== undefined ? resolveJsonPointer(doc, ref) : undefined;
      if (isRecord(target)) {
        if (stack.has(target)) return {};
        stack.add(target);
        const out: UnknownRecord = {};
        for (const [key, item] of Object.entries(target)) {
          out[key] = scrubValue(item, stack, doc);
        }
        stack.delete(target);
        normalizeTypeArray(out);
        return out;
      }
      return {};
    }
    if (stack.has(value)) return {};
    stack.add(value);
    const out: UnknownRecord = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = scrubValue(item, stack, doc);
    }
    stack.delete(value);
    normalizeTypeArray(out);
    return out;
  }
  return value;
}

/** A schema scrubber bound to a document root (for inlining circular `$ref`s). */
type Scrubber = (value: unknown) => JsonSchema;

/** Build a scrubber that resolves leftover circular `$ref`s against `doc`. */
function createScrubber(doc: UnknownRecord): Scrubber {
  return (value: unknown): JsonSchema => {
    const scrubbed = scrubValue(value, new WeakSet(), doc);
    return isRecord(scrubbed) ? scrubbed : {};
  };
}

/**
 * Pick the preferred entry from an OpenAPI `content` map:
 * `application/json` (with or without parameters such as `; charset=utf-8`),
 * else the first key containing `+json`, else the first declared key.
 */
function pickContent(
  content: unknown,
): { contentType: string; media: UnknownRecord } | undefined {
  if (!isRecord(content)) return undefined;
  const keys = Object.keys(content);
  const exactJson = keys.find((key) => key.split(";")[0]?.trim() === "application/json");
  const jsonish = keys.find((key) => key.includes("+json"));
  const contentType = exactJson ?? jsonish ?? keys[0];
  if (contentType === undefined) return undefined;
  const media = content[contentType];
  return { contentType, media: isRecord(media) ? media : {} };
}

/** Classify a content type into its wire encoding. */
function bodyEncoding(contentType: string): BodyEncoding {
  const base = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (base === "application/json" || base.endsWith("+json")) return "json";
  if (base === "application/x-www-form-urlencoded") return "form";
  return "raw";
}

/** Normalize one parameter object; returns undefined when it is unusable (no name / bad location). */
function normalizeParam(raw: unknown, scrub: Scrubber): ParamIR | undefined {
  if (!isRecord(raw)) return undefined;
  const name = asString(raw.name);
  if (name === undefined || name.length === 0) return undefined;
  const location = asString(raw.in);
  if (!PARAM_LOCATIONS.includes(location as ParamLocation)) return undefined;
  const where = location as ParamLocation;

  let schema: JsonSchema;
  if (raw.schema !== undefined) {
    schema = scrub(raw.schema);
  } else {
    // Parameters may declare `content` instead of `schema` (rare; complex serialization).
    const picked = pickContent(raw.content);
    schema = picked && picked.media.schema !== undefined ? scrub(picked.media.schema) : {};
  }

  const param: ParamIR = {
    name,
    in: where,
    required: where === "path" ? true : raw.required === true,
    schema,
  };
  const description = asString(raw.description);
  if (description !== undefined) param.description = description;
  return param;
}

/** Normalize a `requestBody` object; undefined when absent or it declares no content. */
function normalizeRequestBody(raw: unknown, scrub: Scrubber): BodyIR | undefined {
  if (!isRecord(raw)) return undefined;
  const picked = pickContent(raw.content);
  if (picked === undefined) return undefined;
  const body: BodyIR = {
    required: raw.required === true,
    contentType: picked.contentType,
    encoding: bodyEncoding(picked.contentType),
    schema: picked.media.schema !== undefined ? scrub(picked.media.schema) : {},
  };
  const description = asString(raw.description);
  if (description !== undefined) body.description = description;
  return body;
}

/** Normalize the `responses` map, keeping every status entry (including "default"). */
function normalizeResponses(raw: unknown, scrub: Scrubber): ResponseIR[] {
  if (!isRecord(raw)) return [];
  const responses: ResponseIR[] = [];
  for (const [status, value] of Object.entries(raw)) {
    const response: ResponseIR = { status };
    if (isRecord(value)) {
      const description = asString(value.description);
      if (description !== undefined) response.description = description;
      const picked = pickContent(value.content);
      if (picked !== undefined) {
        response.contentType = picked.contentType;
        if (picked.media.schema !== undefined) {
          response.schema = scrub(picked.media.schema);
        }
      }
    }
    responses.push(response);
  }
  return responses;
}

/** Map `components.securitySchemes` to `AuthScheme[]`; unknown scheme types are skipped. */
function normalizeAuthSchemes(securitySchemes: unknown): AuthScheme[] {
  if (!isRecord(securitySchemes)) return [];
  const schemes: AuthScheme[] = [];
  for (const [schemeName, raw] of Object.entries(securitySchemes)) {
    if (!isRecord(raw)) continue;
    switch (raw.type) {
      case "apiKey": {
        const location = asString(raw.in);
        schemes.push({
          kind: "apiKey",
          name: asString(raw.name) ?? schemeName,
          in: location === "query" || location === "cookie" ? location : "header",
          schemeName,
        });
        break;
      }
      case "http":
        schemes.push({
          kind: "http",
          // `scheme` is required by the spec; default to "bearer" (most common) if absent.
          scheme: (asString(raw.scheme) ?? "bearer").toLowerCase(),
          schemeName,
        });
        break;
      case "oauth2":
        schemes.push({ kind: "oauth2", schemeName });
        break;
      case "openIdConnect":
        schemes.push({ kind: "openIdConnect", schemeName });
        break;
      default:
        break;
    }
  }
  return schemes;
}

/** Normalize one operation object into an `OperationIR`. */
function normalizeOperation(
  method: HttpMethod,
  path: string,
  op: UnknownRecord,
  pathLevelParams: readonly unknown[],
  rootSecurityNonEmpty: boolean,
  usedOperationIds: Set<string>,
  usedMethodNames: Set<string>,
  scrub: Scrubber,
): OperationIR {
  const explicitId = asString(op.operationId)?.trim();
  const baseId =
    explicitId !== undefined && explicitId.length > 0
      ? explicitId
      : synthesizeOperationId(method, path);
  // Dedupe operationId too (not just methodName), so exercise results and
  // repair feedback (keyed by operationId) stay unambiguous when a spec
  // reuses an operationId across operations.
  const operationId = dedupeName(baseId, usedOperationIds);
  const methodName = dedupeName(sanitizeToIdentifier(operationId), usedMethodNames);

  // Operation-level parameters override path-level ones with the same name+location.
  const paramsByKey = new Map<string, ParamIR>();
  const opLevelParams = Array.isArray(op.parameters) ? op.parameters : [];
  for (const raw of [...pathLevelParams, ...opLevelParams]) {
    const param = normalizeParam(raw, scrub);
    if (param !== undefined) paramsByKey.set(`${param.in}:${param.name}`, param);
  }

  const tags = Array.isArray(op.tags) ? op.tags : [];
  const firstTag = tags.find(
    (tag): tag is string => typeof tag === "string" && tag.length > 0,
  );

  // Explicit `security: []` on the operation disables auth; a non-empty array
  // requires it; no `security` key falls back to the root document security.
  const requiresAuth = Array.isArray(op.security)
    ? op.security.length > 0
    : rootSecurityNonEmpty;

  const operation: OperationIR = {
    operationId,
    methodName,
    method,
    path,
    tag: firstTag ?? "default",
    params: [...paramsByKey.values()],
    responses: normalizeResponses(op.responses, scrub),
    requiresAuth,
  };
  const summary = asString(op.summary);
  if (summary !== undefined) operation.summary = summary;
  const description = asString(op.description);
  if (description !== undefined) operation.description = description;
  const requestBody = normalizeRequestBody(op.requestBody, scrub);
  if (requestBody !== undefined) operation.requestBody = requestBody;
  if (op.deprecated === true) operation.deprecated = true;
  return operation;
}

/**
 * Normalize a fully dereferenced OpenAPI 3.x document into a `ClientIR`.
 *
 * Pure and total: it never mutates `doc`, never throws on missing or
 * malformed fields, and replaces any schema node still containing `$ref`
 * (circular references the dereferencer ignored) with `{}`.
 *
 * @param doc The dereferenced document, e.g. the result of
 *   `SwaggerParser.dereference(path, { dereference: { circular: "ignore" } })`.
 */
export function normalizeDocument(doc: Record<string, unknown>): ClientIR {
  const scrub = createScrubber(doc);
  const info = isRecord(doc.info) ? doc.info : {};
  const title = asString(info.title) ?? "Untitled API";
  const version = asString(info.version) ?? "0.0.0";
  const description = asString(info.description);

  const servers = Array.isArray(doc.servers) ? doc.servers : [];
  const firstServer = servers[0];
  const baseUrl = isRecord(firstServer) ? asString(firstServer.url) : undefined;

  const components = isRecord(doc.components) ? doc.components : {};
  const auth = normalizeAuthSchemes(components.securitySchemes);
  const rootSecurityNonEmpty = Array.isArray(doc.security) && doc.security.length > 0;

  const usedOperationIds = new Set<string>();
  const usedMethodNames = new Set<string>();
  const operations: OperationIR[] = [];
  const paths = isRecord(doc.paths) ? doc.paths : {};
  for (const [path, pathItem] of Object.entries(paths)) {
    if (!isRecord(pathItem)) continue;
    const pathLevelParams = Array.isArray(pathItem.parameters) ? pathItem.parameters : [];
    for (const method of HTTP_METHODS) {
      const op = pathItem[method];
      if (!isRecord(op)) continue;
      operations.push(
        normalizeOperation(
          method,
          path,
          op,
          pathLevelParams,
          rootSecurityNonEmpty,
          usedOperationIds,
          usedMethodNames,
          scrub,
        ),
      );
    }
  }

  const schemas: Record<string, JsonSchema> = {};
  if (isRecord(components.schemas)) {
    for (const [name, schema] of Object.entries(components.schemas)) {
      schemas[name] = scrub(schema);
    }
  }

  const ir: ClientIR = { title, version, auth, operations, schemas };
  if (description !== undefined) ir.description = description;
  if (baseUrl !== undefined && baseUrl.length > 0) ir.baseUrl = baseUrl;
  return ir;
}
