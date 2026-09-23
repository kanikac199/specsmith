/**
 * Unit tests for src/util/sample.ts: deterministic JSON Schema sampling
 * (sampleFromSchema) and client-method argument building (buildOpArgs).
 */

import { describe, expect, it } from "vitest";
import { buildOpArgs, sampleFromSchema } from "../../src/util/sample.js";
import type { OperationIR } from "../../src/types.js";

describe("sampleFromSchema: const / enum / default precedence", () => {
  it("const wins over enum and default", () => {
    expect(sampleFromSchema({ const: "c", enum: ["e"], default: "d" })).toBe("c");
  });

  it("enum (first value) wins over default", () => {
    expect(sampleFromSchema({ enum: ["first", "second"], default: "d" })).toBe("first");
  });

  it("uses default before falling back to the type", () => {
    expect(sampleFromSchema({ type: "integer", default: 42 })).toBe(42);
  });

  it("ignores an explicitly undefined default", () => {
    expect(sampleFromSchema({ type: "string", default: undefined })).toBe("string");
  });

  it("non-string enums return the first member as-is", () => {
    expect(sampleFromSchema({ enum: [3, 5] })).toBe(3);
  });
});

describe("sampleFromSchema: string formats and length constraints", () => {
  it.each([
    ["date-time", "2024-01-15T10:30:00Z"],
    ["date", "2024-01-15"],
    ["uuid", "123e4567-e89b-12d3-a456-426614174000"],
    ["email", "user@example.com"],
    ["uri", "https://example.com/x"],
    ["url", "https://example.com/x"],
    ["ipv4", "192.0.2.1"],
  ])("format %s", (format, expected) => {
    expect(sampleFromSchema({ type: "string", format })).toBe(expected);
  });

  it("unknown format falls back to the plain sample", () => {
    expect(sampleFromSchema({ type: "string", format: "hostname" })).toBe("string");
  });

  it("pads plain strings to minLength", () => {
    expect(sampleFromSchema({ type: "string", minLength: 10 })).toBe("stringaaaa");
  });

  it("truncates plain strings to maxLength", () => {
    expect(sampleFromSchema({ type: "string", maxLength: 3 })).toBe("str");
  });

  it("never truncates a formatted value to maxLength", () => {
    expect(sampleFromSchema({ type: "string", format: "email", maxLength: 3 })).toBe(
      "user@example.com",
    );
  });
});

describe("sampleFromSchema: numbers", () => {
  it("defaults to 1 without constraints", () => {
    expect(sampleFromSchema({ type: "integer" })).toBe(1);
    expect(sampleFromSchema({ type: "number" })).toBe(1);
  });

  it("honors minimum", () => {
    expect(sampleFromSchema({ type: "integer", minimum: 5 })).toBe(5);
    expect(sampleFromSchema({ type: "number", minimum: 2.5 })).toBe(2.5);
  });

  it("honors numeric exclusiveMinimum (2020-12 form)", () => {
    expect(sampleFromSchema({ type: "number", exclusiveMinimum: 5 })).toBe(6);
  });

  it("honors boolean exclusiveMinimum with minimum (draft-4 form)", () => {
    expect(
      sampleFromSchema({ type: "integer", minimum: 3, exclusiveMinimum: true }),
    ).toBe(4);
  });

  it("clamps to maximum", () => {
    expect(sampleFromSchema({ type: "integer", maximum: 0 })).toBe(0);
    expect(sampleFromSchema({ type: "integer", minimum: 10, maximum: 7 })).toBe(7);
  });

  it("integers are floored", () => {
    expect(sampleFromSchema({ type: "integer", minimum: 2.5 })).toBe(2);
  });
});

describe("sampleFromSchema: combinators", () => {
  it("allOf merges object branches (later branches override)", () => {
    const schema = {
      allOf: [
        {
          type: "object",
          required: ["a", "shared"],
          properties: { a: { type: "string" }, shared: { const: "first" } },
        },
        {
          type: "object",
          required: ["b", "shared"],
          properties: { b: { type: "integer" }, shared: { const: "second" } },
        },
      ],
    };
    expect(sampleFromSchema(schema)).toEqual({ a: "string", b: 1, shared: "second" });
  });

  it("allOf of non-objects returns the first branch's sample", () => {
    expect(sampleFromSchema({ allOf: [{ type: "string" }, { type: "integer" }] })).toBe(
      "string",
    );
  });

  it("oneOf samples the first branch", () => {
    expect(
      sampleFromSchema({ oneOf: [{ type: "integer", minimum: 7 }, { type: "string" }] }),
    ).toBe(7);
  });

  it("anyOf samples the first branch", () => {
    expect(sampleFromSchema({ anyOf: [{ const: "x" }, { type: "integer" }] })).toBe("x");
  });
});

describe("sampleFromSchema: arrays", () => {
  it("produces two items by default", () => {
    expect(sampleFromSchema({ type: "array", items: { type: "integer", minimum: 2 } })).toEqual([2, 2]);
  });

  it("honors minItems above the default", () => {
    expect(
      sampleFromSchema({ type: "array", items: { type: "string" }, minItems: 4 }),
    ).toEqual(["string", "string", "string", "string"]);
  });

  it("honors maxItems (never exceeds it)", () => {
    expect(
      sampleFromSchema({ type: "array", items: { type: "boolean" }, maxItems: 1 }),
    ).toEqual([true]);
  });

  it("honors minItems even when it exceeds the default of 2", () => {
    expect(
      sampleFromSchema({ type: "array", items: { type: "boolean" }, minItems: 5 }),
    ).toEqual([true, true, true, true, true]);
  });
});

describe("sampleFromSchema: objects", () => {
  it("includes only required properties", () => {
    const schema = {
      type: "object",
      required: ["a", "c"],
      properties: {
        a: { type: "string" },
        b: { type: "integer" },
        c: { type: "boolean" },
      },
    };
    expect(sampleFromSchema(schema)).toEqual({ a: "string", c: true });
  });

  it("samples required properties missing a declaration as the empty schema", () => {
    expect(sampleFromSchema({ type: "object", required: ["ghost"] })).toEqual({
      ghost: "sample",
    });
  });

  it("infers object/array types from structural keywords", () => {
    expect(sampleFromSchema({ properties: { x: { type: "string" } } })).toEqual({});
    expect(sampleFromSchema({ required: ["x"] })).toEqual({ x: "sample" });
    expect(sampleFromSchema({ items: { type: "string" } })).toEqual(["string", "string"]);
  });
});

describe("sampleFromSchema: primitives and edge cases", () => {
  it("boolean -> true", () => {
    expect(sampleFromSchema({ type: "boolean" })).toBe(true);
  });

  it("null type -> null", () => {
    expect(sampleFromSchema({ type: "null" })).toBeNull();
  });

  it("type arrays use the first entry", () => {
    expect(sampleFromSchema({ type: ["null", "string"] })).toBeNull();
    expect(sampleFromSchema({ type: ["integer", "null"], minimum: 9 })).toBe(9);
  });

  it("empty schema -> the fallback string", () => {
    expect(sampleFromSchema({})).toBe("sample");
  });

  it("terminates on circular-ish input via the depth guard", () => {
    const node: Record<string, unknown> = { type: "object", required: ["next"] };
    node["properties"] = { next: node };

    const result = sampleFromSchema(node);
    let cursor: unknown = result;
    let levels = 0;
    while (typeof cursor === "object" && cursor !== null) {
      cursor = (cursor as Record<string, unknown>)["next"];
      levels += 1;
      if (levels > 100) throw new Error("sampler did not terminate nesting");
    }
    // MAX_DEPTH = 16: object levels at depths 0..16, then the fallback string.
    expect(cursor).toBe("sample");
    expect(levels).toBe(17);
  });

  it("is deterministic: identical schemas always yield identical values", () => {
    const schema = {
      type: "object",
      required: ["id", "tags", "kind", "when"],
      properties: {
        id: { type: "string", format: "uuid" },
        tags: { type: "array", items: { type: "string" }, minItems: 2 },
        kind: { enum: ["x", "y"] },
        when: { type: "string", format: "date-time" },
      },
    };
    const a = sampleFromSchema(schema);
    const b = sampleFromSchema(structuredClone(schema));
    expect(a).toEqual(b);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe("buildOpArgs", () => {
  function makeOp(overrides: Partial<OperationIR>): OperationIR {
    return {
      operationId: "demo",
      methodName: "demo",
      method: "post",
      path: "/widgets/{id}",
      tag: "default",
      params: [],
      responses: [],
      requiresAuth: false,
      ...overrides,
    };
  }

  it("includes path params always (even if marked optional), required params, and the body", () => {
    const op = makeOp({
      params: [
        { name: "id", in: "path", required: false, schema: { type: "string", format: "uuid" } },
        { name: "limit", in: "query", required: true, schema: { type: "integer", minimum: 1 } },
        { name: "verbose", in: "query", required: false, schema: { type: "boolean" } },
        { name: "X-Trace", in: "header", required: false, schema: { type: "string" } },
      ],
      requestBody: {
        required: false, // optional bodies are still sent
        contentType: "application/json",
        schema: {
          type: "object",
          required: ["name"],
          properties: { name: { type: "string" }, note: { type: "string" } },
        },
      },
    });

    expect(buildOpArgs(op)).toEqual({
      id: "123e4567-e89b-12d3-a456-426614174000",
      limit: 1,
      body: { name: "string" },
    });
  });

  it("omits the body key when the operation declares no request body", () => {
    const op = makeOp({
      params: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }],
    });
    const args = buildOpArgs(op);
    expect(args).toEqual({ id: 1 });
    expect("body" in args).toBe(false);
  });

  it("returns an empty object for an op with no required inputs", () => {
    const op = makeOp({
      params: [{ name: "q", in: "query", required: false, schema: { type: "string" } }],
    });
    expect(buildOpArgs(op)).toEqual({});
  });
});
