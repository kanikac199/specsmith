/**
 * Deterministic JSON Schema sampling.
 *
 * Produces stable example values from (dereferenced) JSON Schema fragments so
 * every generated client method can be exercised against the Prism mock with
 * spec-conforming inputs. The sampler is total: it never throws, and the same
 * schema always yields the same value.
 */

import type { JsonSchema, OperationIR } from "../types.js";

/** Recursion guard — IR schemas are acyclic, but stay total no matter what. */
const MAX_DEPTH = 16;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Produce a deterministic sample value conforming to `schema`.
 *
 * Handles const/enum/default, type arrays, allOf/oneOf/anyOf, objects
 * (required properties only), arrays (honoring `minItems` up to 3), strings
 * (honoring `minLength` and common formats), numbers (honoring
 * minimum/maximum/exclusiveMinimum), booleans, and null. Never throws.
 */
export function sampleFromSchema(schema: JsonSchema): unknown {
  return sample(schema, 0);
}

function sample(schema: unknown, depth: number): unknown {
  if (!isPlainRecord(schema) || depth > MAX_DEPTH) {
    // Defensive fallback for malformed nodes / runaway recursion.
    return "sample";
  }

  if ("const" in schema) return schema.const;

  const enumValues = schema.enum;
  if (Array.isArray(enumValues) && enumValues.length > 0) {
    return (enumValues as unknown[])[0];
  }

  if ("default" in schema && schema.default !== undefined) return schema.default;

  const allOf = schema.allOf;
  if (Array.isArray(allOf) && allOf.length > 0) {
    return sampleAllOf(allOf as unknown[], depth);
  }

  const oneOrAny = (Array.isArray(schema.oneOf) && schema.oneOf.length > 0
    ? schema.oneOf
    : Array.isArray(schema.anyOf) && schema.anyOf.length > 0
      ? schema.anyOf
      : undefined) as unknown[] | undefined;
  if (oneOrAny !== undefined) {
    return sample(oneOrAny[0], depth + 1);
  }

  switch (resolveType(schema)) {
    case "object":
      return sampleObject(schema, depth);
    case "array":
      return sampleArray(schema, depth);
    case "string":
      return sampleString(schema);
    case "integer":
      return sampleNumber(schema, true);
    case "number":
      return sampleNumber(schema, false);
    case "boolean":
      return true;
    case "null":
      return null;
    default:
      // Empty/unknown schema: Prism treats `{}` as "anything", so a plain
      // string is the safest deterministic sample that always validates.
      return "sample";
  }
}

/** Pick an effective type: explicit `type` (first entry of a type array), else infer from structural keywords. */
function resolveType(schema: Record<string, unknown>): string | undefined {
  const t = schema.type;
  if (typeof t === "string") return t;
  if (Array.isArray(t)) {
    const first = (t as unknown[])[0];
    if (typeof first === "string") return first;
  }
  if ("properties" in schema || "required" in schema || "additionalProperties" in schema) return "object";
  if ("items" in schema) return "array";
  return undefined;
}

/** Sample each allOf branch and shallow-merge the object results. */
function sampleAllOf(branches: unknown[], depth: number): unknown {
  const parts = branches.map((branch) => sample(branch, depth + 1));
  const merged: Record<string, unknown> = {};
  let sawObject = false;
  for (const part of parts) {
    if (isPlainRecord(part)) {
      sawObject = true;
      Object.assign(merged, part);
    }
  }
  if (sawObject) return merged;
  return parts.length > 0 ? parts[0] : "sample";
}

/** Sample only the required properties of an object schema. */
function sampleObject(schema: Record<string, unknown>, depth: number): Record<string, unknown> {
  const properties = isPlainRecord(schema.properties) ? schema.properties : {};
  const required = Array.isArray(schema.required)
    ? (schema.required as unknown[]).filter((n): n is string => typeof n === "string")
    : [];
  const out: Record<string, unknown> = {};
  for (const name of required) {
    out[name] = sample(properties[name] ?? {}, depth + 1);
  }
  return out;
}

/**
 * Sample an array schema. The count honors `minItems`/`maxItems` so the result
 * never violates the schema (which would make a spec-validating mock reject the
 * request and blame the client): at least `minItems`, at most `maxItems`,
 * defaulting to 2 elements (enough to surface array-serialization bugs).
 */
function sampleArray(schema: Record<string, unknown>, depth: number): unknown[] {
  const items = isPlainRecord(schema.items) ? schema.items : {};
  const minItems = typeof schema.minItems === "number" ? Math.max(0, Math.ceil(schema.minItems)) : 0;
  const maxItems = typeof schema.maxItems === "number" ? Math.max(0, Math.floor(schema.maxItems)) : undefined;
  let count = Math.max(minItems, 2);
  if (maxItems !== undefined && count > maxItems) count = maxItems;
  return Array.from({ length: count }, () => sample(items, depth + 1));
}

/** Deterministic string sample honoring `format`, `minLength`, and `maxLength`. */
function sampleString(schema: Record<string, unknown>): string {
  const format = typeof schema.format === "string" ? schema.format : undefined;
  let value: string;
  switch (format) {
    case "date-time":
      value = "2024-01-15T10:30:00Z";
      break;
    case "date":
      value = "2024-01-15";
      break;
    case "uuid":
      value = "123e4567-e89b-12d3-a456-426614174000";
      break;
    case "email":
      value = "user@example.com";
      break;
    case "uri":
    case "url":
      value = "https://example.com/x";
      break;
    case "ipv4":
      value = "192.0.2.1";
      break;
    default:
      value = "string";
  }
  const minLength = typeof schema.minLength === "number" ? schema.minLength : 0;
  if (value.length < minLength) value = value.padEnd(minLength, "a");
  const maxLength = typeof schema.maxLength === "number" ? schema.maxLength : undefined;
  // Only shorten plain strings — slicing a formatted value would break the format.
  if (format === undefined && maxLength !== undefined && value.length > maxLength) {
    value = value.slice(0, Math.max(maxLength, 0));
  }
  return value;
}

/** Deterministic numeric sample honoring minimum / maximum / exclusiveMinimum (draft-4 boolean or 2020-12 numeric). */
function sampleNumber(schema: Record<string, unknown>, integer: boolean): number {
  const minimum = typeof schema.minimum === "number" ? schema.minimum : undefined;
  const exclusiveMinimum = schema.exclusiveMinimum;
  let value: number;
  if (typeof exclusiveMinimum === "number") {
    value = exclusiveMinimum + 1;
  } else if (exclusiveMinimum === true && minimum !== undefined) {
    value = minimum + 1;
  } else {
    value = minimum ?? 1;
  }
  const maximum = typeof schema.maximum === "number" ? schema.maximum : undefined;
  if (maximum !== undefined && value > maximum) value = maximum;
  return integer ? Math.floor(value) : value;
}

/**
 * Build the single object argument for a generated client method.
 *
 * Includes every required parameter (path parameters are always included,
 * even if the spec mistakenly marks them optional) sampled from its schema,
 * plus `body` whenever the operation declares a request body (required or
 * not — Prism validates optional bodies too).
 */
export function buildOpArgs(op: OperationIR): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const param of op.params) {
    if (param.required || param.in === "path") {
      args[param.name] = sampleFromSchema(param.schema);
    }
  }
  if (op.requestBody !== undefined) {
    args["body"] = sampleFromSchema(op.requestBody.schema);
  }
  return args;
}
