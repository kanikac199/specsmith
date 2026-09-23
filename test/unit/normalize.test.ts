/**
 * Unit tests for src/ir/normalize.ts (normalizeDocument, synthesizeOperationId)
 * over inline minimal OpenAPI docs, plus loadSpec over the real eval specs
 * taskhub.json and polyform.json (local files, fully offline).
 */

import { beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { normalizeDocument, synthesizeOperationId } from "../../src/ir/normalize.js";
import { loadSpec } from "../../src/ir/load.js";
import type { ClientIR, OperationIR } from "../../src/types.js";

/** Minimal valid-enough inline document with overridable fields. */
function makeDoc(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    openapi: "3.0.3",
    info: { title: "Inline", version: "1.0.0" },
    paths: {},
    ...overrides,
  };
}

function opById(ir: ClientIR, operationId: string): OperationIR {
  const found = ir.operations.find((o) => o.operationId === operationId);
  if (found === undefined) {
    throw new Error(`operation ${operationId} not found in IR`);
  }
  return found;
}

// ---------------------------------------------------------------------------
// synthesizeOperationId
// ---------------------------------------------------------------------------

describe("synthesizeOperationId", () => {
  it("turns method + path template into a camelCase id", () => {
    expect(synthesizeOperationId("get", "/pets/{petId}")).toBe("getPetsPetId");
  });

  it("lowercases the method and handles multi-segment paths", () => {
    expect(synthesizeOperationId("POST", "/stores/{storeId}/orders")).toBe(
      "postStoresStoreIdOrders",
    );
  });

  it("splits non-alphanumeric segment characters into words", () => {
    expect(synthesizeOperationId("get", "/user-profiles/{user_id}")).toBe(
      "getUserProfilesUserId",
    );
  });

  it("handles the root path", () => {
    expect(synthesizeOperationId("get", "/")).toBe("get");
  });
});

// ---------------------------------------------------------------------------
// normalizeDocument — inline docs
// ---------------------------------------------------------------------------

describe("normalizeDocument: operationId synthesis & methodName", () => {
  it("synthesizes operationId from method+path when missing", () => {
    const ir = normalizeDocument(
      makeDoc({
        paths: {
          "/pets/{petId}": { get: { responses: { "200": { description: "ok" } } } },
        },
      }),
    );
    expect(ir.operations).toHaveLength(1);
    expect(ir.operations[0]?.operationId).toBe("getPetsPetId");
    expect(ir.operations[0]?.methodName).toBe("getPetsPetId");
  });

  it("treats a blank operationId as missing", () => {
    const ir = normalizeDocument(
      makeDoc({
        paths: { "/x": { get: { operationId: "   ", responses: {} } } },
      }),
    );
    expect(ir.operations[0]?.operationId).toBe("getX");
  });

  it("sanitizes operationId into a camelCase identifier, preserving the raw id", () => {
    const ir = normalizeDocument(
      makeDoc({
        paths: { "/a": { get: { operationId: "list-all_items!", responses: {} } } },
      }),
    );
    expect(ir.operations[0]?.operationId).toBe("list-all_items!");
    expect(ir.operations[0]?.methodName).toBe("listAllItems");
  });

  it("prefixes a leading digit with 'op'", () => {
    const ir = normalizeDocument(
      makeDoc({
        paths: { "/a": { get: { operationId: "2fastLookup", responses: {} } } },
      }),
    );
    expect(ir.operations[0]?.methodName).toBe("op2fastLookup");
  });

  it("falls back to 'op' for an id with no word characters", () => {
    const ir = normalizeDocument(
      makeDoc({
        paths: { "/a": { get: { operationId: "!!!", responses: {} } } },
      }),
    );
    expect(ir.operations[0]?.methodName).toBe("op");
  });

  it("dedupes colliding method names with numeric suffixes", () => {
    const ir = normalizeDocument(
      makeDoc({
        paths: {
          "/a": { get: { operationId: "do-it", responses: {} } },
          "/b": { get: { operationId: "doIt", responses: {} } },
          "/c": { get: { operationId: "do it", responses: {} } },
        },
      }),
    );
    expect(ir.operations.map((o) => o.methodName)).toEqual(["doIt", "doIt2", "doIt3"]);
  });
});

describe("normalizeDocument: content-type preference", () => {
  it("prefers application/json even with charset parameters and when not first", () => {
    const ir = normalizeDocument(
      makeDoc({
        paths: {
          "/a": {
            post: {
              requestBody: {
                required: true,
                content: {
                  "text/plain": { schema: { type: "string" } },
                  "application/json; charset=utf-8": { schema: { type: "object" } },
                },
              },
              responses: {},
            },
          },
        },
      }),
    );
    expect(ir.operations[0]?.requestBody?.contentType).toBe(
      "application/json; charset=utf-8",
    );
    expect(ir.operations[0]?.requestBody?.schema).toEqual({ type: "object" });
  });

  it("falls back to the first +json content type when no application/json exists", () => {
    const ir = normalizeDocument(
      makeDoc({
        paths: {
          "/a": {
            get: {
              responses: {
                "200": {
                  description: "ok",
                  content: {
                    "text/html": {},
                    "application/vnd.api+json": { schema: { type: "string" } },
                  },
                },
              },
            },
          },
        },
      }),
    );
    const res = ir.operations[0]?.responses[0];
    expect(res?.contentType).toBe("application/vnd.api+json");
    expect(res?.schema).toEqual({ type: "string" });
  });

  it("falls back to the first declared content type when nothing is JSON-ish", () => {
    const ir = normalizeDocument(
      makeDoc({
        paths: {
          "/a": {
            post: {
              requestBody: {
                content: {
                  "text/csv": { schema: { type: "string" } },
                  "text/plain": { schema: { type: "string" } },
                },
              },
              responses: {},
            },
          },
        },
      }),
    );
    expect(ir.operations[0]?.requestBody?.contentType).toBe("text/csv");
  });
});

describe("normalizeDocument: parameters", () => {
  it("merges path-level params into operations, with op-level overriding by name+location", () => {
    const ir = normalizeDocument(
      makeDoc({
        paths: {
          "/pets/{petId}": {
            parameters: [
              { name: "petId", in: "path", schema: { type: "string" } },
              { name: "verbose", in: "query", schema: { type: "boolean" } },
            ],
            get: { responses: {} },
            put: {
              parameters: [
                { name: "verbose", in: "query", required: true, schema: { type: "string" } },
              ],
              responses: {},
            },
          },
        },
      }),
    );
    const get = opById(ir, "getPetsPetId");
    expect(get.params.map((p) => p.name)).toEqual(["petId", "verbose"]);
    expect(get.params[1]).toMatchObject({
      in: "query",
      required: false,
      schema: { type: "boolean" },
    });

    const put = opById(ir, "putPetsPetId");
    const verbose = put.params.find((p) => p.name === "verbose");
    // The op-level declaration replaced the path-level one.
    expect(verbose).toMatchObject({
      in: "query",
      required: true,
      schema: { type: "string" },
    });
    // The path-level petId is still merged in.
    expect(put.params.some((p) => p.name === "petId" && p.in === "path")).toBe(true);
  });

  it("forces path params to required even when the spec marks them optional", () => {
    const ir = normalizeDocument(
      makeDoc({
        paths: {
          "/pets/{petId}": {
            get: {
              parameters: [
                { name: "petId", in: "path", required: false, schema: { type: "string" } },
                { name: "limit", in: "query", schema: { type: "integer" } },
              ],
              responses: {},
            },
          },
        },
      }),
    );
    const op = ir.operations[0];
    expect(op?.params.find((p) => p.name === "petId")?.required).toBe(true);
    // Non-path params without required: true stay optional.
    expect(op?.params.find((p) => p.name === "limit")?.required).toBe(false);
  });

  it("drops unusable params (missing name or bad location)", () => {
    const ir = normalizeDocument(
      makeDoc({
        paths: {
          "/a": {
            get: {
              parameters: [
                { in: "query", schema: {} },
                { name: "x", in: "body", schema: {} },
                { name: "ok", in: "query", schema: {} },
              ],
              responses: {},
            },
          },
        },
      }),
    );
    expect(ir.operations[0]?.params.map((p) => p.name)).toEqual(["ok"]);
  });
});

describe("normalizeDocument: requiresAuth", () => {
  const paths = {
    "/inherit": { get: { responses: {} } },
    "/none": { get: { security: [], responses: {} } },
    "/explicit": { get: { security: [{ other: [] }], responses: {} } },
  };

  it("op security non-empty -> true; explicit [] -> false; absent -> root fallback (true)", () => {
    const ir = normalizeDocument(makeDoc({ security: [{ key: [] }], paths }));
    expect(opById(ir, "getInherit").requiresAuth).toBe(true);
    expect(opById(ir, "getNone").requiresAuth).toBe(false);
    expect(opById(ir, "getExplicit").requiresAuth).toBe(true);
  });

  it("absent op security with no root security -> false", () => {
    const ir = normalizeDocument(makeDoc({ paths }));
    expect(opById(ir, "getInherit").requiresAuth).toBe(false);
    expect(opById(ir, "getNone").requiresAuth).toBe(false);
    expect(opById(ir, "getExplicit").requiresAuth).toBe(true);
  });

  it("empty root security array does not require auth", () => {
    const ir = normalizeDocument(makeDoc({ security: [], paths }));
    expect(opById(ir, "getInherit").requiresAuth).toBe(false);
  });
});

describe("normalizeDocument: circular $ref scrubbing", () => {
  it("replaces any node still containing $ref with {}", () => {
    const ir = normalizeDocument(
      makeDoc({
        components: {
          schemas: {
            Node: {
              type: "object",
              properties: {
                value: { type: "string" },
                next: { $ref: "#/components/schemas/Node" },
              },
            },
          },
        },
      }),
    );
    expect(ir.schemas["Node"]).toEqual({
      type: "object",
      properties: { value: { type: "string" }, next: {} },
    });
  });

  it("terminates on a true object-graph cycle (shared instances after dereference)", () => {
    const node: Record<string, unknown> = { type: "object" };
    node["properties"] = { self: node };
    const ir = normalizeDocument(
      makeDoc({ components: { schemas: { Node: node } } }),
    );
    expect(ir.schemas["Node"]).toEqual({ type: "object", properties: { self: {} } });
  });

  it("normalizes a non-object schema value to {}", () => {
    const ir = normalizeDocument(
      makeDoc({ components: { schemas: { Weird: true } } }),
    );
    expect(ir.schemas["Weird"]).toEqual({});
  });
});

describe("normalizeDocument: document-level fields & auth schemes", () => {
  it("defaults title/version and omits baseUrl when servers are absent", () => {
    const ir = normalizeDocument({ openapi: "3.0.3", paths: {} });
    expect(ir.title).toBe("Untitled API");
    expect(ir.version).toBe("0.0.0");
    expect(ir.baseUrl).toBeUndefined();
    expect(ir.operations).toEqual([]);
    expect(ir.schemas).toEqual({});
  });

  it("maps securitySchemes to AuthScheme[], skipping unknown types", () => {
    const ir = normalizeDocument(
      makeDoc({
        components: {
          securitySchemes: {
            key: { type: "apiKey", in: "query", name: "api_key" },
            badIn: { type: "apiKey", in: "weird", name: "k" },
            basic: { type: "http", scheme: "Basic" },
            oauth: { type: "oauth2", flows: {} },
            oidc: { type: "openIdConnect", openIdConnectUrl: "https://example.com" },
            bogus: { type: "mutualTLS" },
          },
        },
      }),
    );
    expect(ir.auth).toEqual([
      { kind: "apiKey", name: "api_key", in: "query", schemeName: "key" },
      { kind: "apiKey", name: "k", in: "header", schemeName: "badIn" },
      { kind: "http", scheme: "basic", schemeName: "basic" },
      { kind: "oauth2", schemeName: "oauth" },
      { kind: "openIdConnect", schemeName: "oidc" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// loadSpec over real eval specs (offline: local files, internal $refs only)
// ---------------------------------------------------------------------------

const taskhubPath = fileURLToPath(
  new URL("../../evals/specs/taskhub.json", import.meta.url),
);
const polyformPath = fileURLToPath(
  new URL("../../evals/specs/polyform.json", import.meta.url),
);

describe("loadSpec: taskhub.json", () => {
  let ir: ClientIR;
  beforeAll(async () => {
    ir = await loadSpec(taskhubPath);
  });

  it("captures document metadata", () => {
    expect(ir.title).toBe("TaskHub");
    expect(ir.version).toBe("1.0.0");
    expect(ir.baseUrl).toBe("http://localhost:4010");
  });

  it("maps the apiKey security scheme", () => {
    expect(ir.auth).toEqual([
      { kind: "apiKey", name: "X-Api-Key", in: "header", schemeName: "apiKeyAuth" },
    ]);
  });

  it("normalizes all 7 operations with their declared operationIds", () => {
    expect(ir.operations).toHaveLength(7);
    expect(ir.operations.map((o) => o.methodName).sort()).toEqual([
      "completeTask",
      "createTask",
      "deleteTask",
      "getTask",
      "listLabels",
      "listTasks",
      "updateTask",
    ]);
  });

  it("every operation requires auth via the root security fallback", () => {
    expect(ir.operations.every((o) => o.requiresAuth)).toBe(true);
  });

  it("dereferences param schemas (listTasks status enum)", () => {
    const status = opById(ir, "listTasks").params.find((p) => p.name === "status");
    expect(status).toBeDefined();
    expect(status?.required).toBe(false);
    expect(status?.schema["enum"]).toEqual(["todo", "in_progress", "done"]);
    expect(status?.schema["type"]).toBe("string");
  });

  it("normalizes path params and the JSON request body (updateTask)", () => {
    const update = opById(ir, "updateTask");
    expect(update.method).toBe("patch");
    expect(update.path).toBe("/tasks/{taskId}");
    expect(update.tag).toBe("tasks");
    expect(update.params).toEqual([
      {
        name: "taskId",
        in: "path",
        required: true,
        description: "Numeric id of the task.",
        schema: { type: "integer", minimum: 1 },
      },
    ]);
    expect(update.requestBody?.required).toBe(true);
    expect(update.requestBody?.contentType).toBe("application/json");
    // TaskUpdate dereferenced: status property carries the enum inline.
    const props = update.requestBody?.schema["properties"] as Record<
      string,
      Record<string, unknown>
    >;
    expect(props["status"]?.["enum"]).toEqual(["todo", "in_progress", "done"]);
  });

  it("keeps the schemaless 204 response on deleteTask", () => {
    const del = opById(ir, "deleteTask");
    const statuses = del.responses.map((r) => r.status).sort();
    expect(statuses).toEqual(["204", "404"]);
    const noContent = del.responses.find((r) => r.status === "204");
    expect(noContent?.schema).toBeUndefined();
    expect(noContent?.contentType).toBeUndefined();
  });

  it("collects all named component schemas, dereferenced and $ref-free", () => {
    expect(Object.keys(ir.schemas).sort()).toEqual([
      "Error",
      "Label",
      "LabelList",
      "Task",
      "TaskCreate",
      "TaskList",
      "TaskPriority",
      "TaskStatus",
      "TaskUpdate",
    ]);
    const task = ir.schemas["Task"] as { properties: Record<string, unknown> };
    expect(task.properties["status"]).toEqual(ir.schemas["TaskStatus"]);
    expect(JSON.stringify(ir.schemas)).not.toContain('"$ref"');
  });
});

describe("loadSpec: polyform.json", () => {
  let ir: ClientIR;
  beforeAll(async () => {
    ir = await loadSpec(polyformPath);
  });

  it("normalizes all 14 operations and both security schemes", () => {
    expect(ir.operations).toHaveLength(14);
    expect(ir.auth).toEqual([
      { kind: "apiKey", name: "X-Api-Key", in: "header", schemeName: "apiKeyAuth" },
      { kind: "http", scheme: "bearer", schemeName: "bearerAuth" },
    ]);
  });

  it("applies per-operation security rules", () => {
    // Explicit security: [] -> public.
    expect(opById(ir, "getAuthor").requiresAuth).toBe(false);
    // Op-level non-empty security -> required.
    expect(opById(ir, "listDocuments").requiresAuth).toBe(true);
    expect(opById(ir, "createCollection").requiresAuth).toBe(true);
    // No op security -> root fallback (root security is non-empty).
    expect(opById(ir, "createDocument").requiresAuth).toBe(true);
  });

  it("keeps the 'default' response with its schema", () => {
    const list = opById(ir, "listDocuments");
    const def = list.responses.find((r) => r.status === "default");
    expect(def).toBeDefined();
    expect(def?.contentType).toBe("application/json");
    expect(def?.schema?.["required"]).toEqual(["code", "message"]);
  });

  it("dereferences oneOf/allOf composition without leaving $refs", () => {
    expect(Object.keys(ir.schemas)).toHaveLength(16);
    const block = ir.schemas["Block"] as { oneOf: unknown[] };
    expect(block.oneOf).toHaveLength(3);
    const textBlock = ir.schemas["TextBlock"] as { allOf: unknown[] };
    expect(textBlock.allOf[0]).toEqual(ir.schemas["BlockBase"]);
    expect(JSON.stringify(ir.schemas)).not.toContain('"$ref"');
    expect(JSON.stringify(ir.operations)).not.toContain('"$ref"');
  });

  it("preserves nullable and format annotations", () => {
    const doc = ir.schemas["Document"] as { properties: Record<string, Record<string, unknown>> };
    expect(doc.properties["publishedAt"]).toMatchObject({
      type: "string",
      format: "date-time",
      nullable: true,
    });
    const author = ir.schemas["Author"] as { properties: Record<string, Record<string, unknown>> };
    expect(author.properties["email"]).toMatchObject({ type: "string", format: "email" });
  });
});
