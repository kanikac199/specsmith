/**
 * Spec loading: parse, validate, and dereference an OpenAPI 3.x document with
 * `@apidevtools/swagger-parser`, then normalize it into the compact `ClientIR`.
 *
 * Swagger 2.0 documents are rejected up front with a clear error; circular
 * `$ref`s are left in place by the dereferencer and scrubbed to `{}` during
 * normalization.
 */

import SwaggerParser from "@apidevtools/swagger-parser";
import type { ClientIR } from "../types.js";
import { normalizeDocument } from "./normalize.js";

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Load an OpenAPI 3.x spec from `path` (JSON or YAML), validate it, fully
 * dereference its `$ref`s (ignoring circular ones), and return the normalized
 * `ClientIR`.
 *
 * @param path File path (or URL) of the spec.
 * @throws Error with a descriptive message when the file cannot be parsed,
 *   is a Swagger 2.0 document, is not OpenAPI 3.x, or fails validation.
 */
export async function loadSpec(path: string): Promise<ClientIR> {
  // Pre-flight parse of the raw document so version problems surface as
  // clear errors instead of generic validator output.
  let rawDoc: Record<string, unknown>;
  try {
    // The parser types the result as OpenAPI.Document; we only inspect
    // top-level version keys here, so a structural view is sufficient.
    rawDoc = (await SwaggerParser.parse(path)) as unknown as Record<string, unknown>;
  } catch (err) {
    throw new Error(`Failed to parse spec "${path}": ${messageOf(err)}`);
  }

  const swaggerVersion = rawDoc["swagger"];
  if (swaggerVersion !== undefined) {
    throw new Error(
      `Spec "${path}" is a Swagger ${String(swaggerVersion)} document; ` +
        `only OpenAPI 3.x is supported. Convert it to OpenAPI 3 first ` +
        `(e.g. with swagger2openapi).`,
    );
  }
  const openapiVersion = rawDoc["openapi"];
  if (typeof openapiVersion !== "string") {
    throw new Error(
      `Spec "${path}" has no "openapi" version field; only OpenAPI 3.x is supported.`,
    );
  }
  if (!/^3(\.|$)/.test(openapiVersion.trim())) {
    throw new Error(
      `Spec "${path}" declares OpenAPI ${openapiVersion}; only OpenAPI 3.x is supported.`,
    );
  }

  try {
    await SwaggerParser.validate(path);
  } catch (err) {
    throw new Error(`OpenAPI validation failed for "${path}": ${messageOf(err)}`);
  }

  let doc: unknown;
  try {
    doc = await SwaggerParser.dereference(path, {
      dereference: { circular: "ignore" },
    });
  } catch (err) {
    throw new Error(`Failed to dereference $refs in "${path}": ${messageOf(err)}`);
  }

  return normalizeDocument(doc as unknown as Record<string, unknown>);
}
