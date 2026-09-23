/**
 * Unit tests for src/validate/feedback.ts: compile-error and exercise-failure
 * feedback rendering (grouping, IR fragments, caps).
 */

import { describe, expect, it } from "vitest";
import {
  renderCompileFeedback,
  renderExerciseFeedback,
} from "../../src/validate/feedback.js";
import type {
  ClientIR,
  CompileError,
  ExerciseResult,
  OperationIR,
} from "../../src/types.js";

// ---------------------------------------------------------------------------
// renderCompileFeedback
// ---------------------------------------------------------------------------

describe("renderCompileFeedback", () => {
  it("reports success for an empty error list", () => {
    expect(renderCompileFeedback({ ok: true, errors: [] })).toBe(
      "TypeScript compilation succeeded.",
    );
  });

  it("uses singular phrasing for exactly one error", () => {
    const text = renderCompileFeedback({
      ok: false,
      errors: [{ file: "client.ts", line: 3, message: "oops" }],
    });
    expect(text).toContain("TypeScript compilation failed with 1 error:");
    expect(text).toContain("client.ts:3 oops");
  });

  it("groups errors by file in first-seen order, handling file-less errors", () => {
    const text = renderCompileFeedback({
      ok: false,
      errors: [
        { file: "client.ts", line: 10, message: "error A" },
        { file: "schemas.ts", line: 2, message: "error B" },
        { file: "client.ts", line: 20, message: "error C" },
        { message: "global error" },
      ],
    });
    expect(text).toContain("TypeScript compilation failed with 4 errors:");
    const posA = text.indexOf("client.ts:10 error A");
    const posC = text.indexOf("client.ts:20 error C");
    const posB = text.indexOf("schemas.ts:2 error B");
    const posG = text.indexOf("(no file) global error");
    expect(posA).toBeGreaterThanOrEqual(0);
    // client.ts errors stay together even though schemas.ts came in between.
    expect(posC).toBeGreaterThan(posA);
    expect(posB).toBeGreaterThan(posC);
    expect(posG).toBeGreaterThan(posB);
  });

  it("indents continuation lines of multi-line messages", () => {
    const text = renderCompileFeedback({
      ok: false,
      errors: [{ file: "a.ts", line: 1, message: "first line\nsecond line" }],
    });
    expect(text).toContain("a.ts:1 first line\n  second line");
  });

  it("caps at 80 errors and notes the omission", () => {
    const errors: CompileError[] = Array.from({ length: 100 }, (_, i) => ({
      file: "client.ts",
      line: i + 1,
      message: `err-${i + 1}`,
    }));
    const text = renderCompileFeedback({ ok: false, errors });
    expect(text).toContain("TypeScript compilation failed with 100 errors:");
    expect(text).toContain("err-80");
    expect(text).not.toContain("err-81");
    expect(text).toContain("...(truncated, 20 more errors omitted)");
  });

  it("hard-caps the rendered text at ~8000 characters", () => {
    const errors: CompileError[] = Array.from({ length: 30 }, (_, i) => ({
      file: "client.ts",
      line: i + 1,
      message: "x".repeat(500),
    }));
    const text = renderCompileFeedback({ ok: false, errors });
    expect(text.endsWith("\n...(truncated)")).toBe(true);
    expect(text.length).toBeLessThanOrEqual(8000 + "\n...(truncated)".length);
  });
});

// ---------------------------------------------------------------------------
// renderExerciseFeedback
// ---------------------------------------------------------------------------

function makeOp(overrides: Partial<OperationIR> & { operationId: string }): OperationIR {
  return {
    methodName: overrides.operationId,
    method: "get",
    path: `/${overrides.operationId}`,
    tag: "default",
    params: [],
    responses: [],
    requiresAuth: false,
    ...overrides,
  };
}

const ir: ClientIR = {
  title: "Feedback Demo",
  version: "1.0.0",
  auth: [],
  operations: [
    makeOp({
      operationId: "alphaOp",
      method: "get",
      path: "/alpha/{id}",
      params: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
      requestBody: {
        required: true,
        contentType: "application/json",
        schema: { type: "object", required: ["name"] },
      },
      responses: [
        { status: "200", schema: { type: "object", required: ["ok"] } },
        { status: "404", schema: { type: "object", required: ["code"] } },
      ],
    }),
    makeOp({
      operationId: "betaOp",
      method: "post",
      path: "/beta",
      responses: [{ status: "default", schema: { type: "object", required: ["err"] } }],
    }),
    makeOp({ operationId: "gammaOp", method: "get", path: "/gamma" }),
    makeOp({
      operationId: "deltaOp",
      method: "put",
      path: "/delta",
      params: [{ name: "limit", in: "query", required: true, schema: { type: "integer" } }],
      responses: [{ status: "200", schema: { type: "object" } }],
    }),
  ],
  schemas: {},
};

describe("renderExerciseFeedback", () => {
  const result: ExerciseResult = {
    total: 4,
    methodsFound: 4,
    requestsOk: 3,
    responsesOk: 1,
    ops: [
      // Response-validation failure with an exact 2xx schema.
      {
        operationId: "alphaOp",
        methodFound: true,
        requestOk: true,
        responseOk: false,
        failure: "zod issues: ok missing",
      },
      // Response-validation failure whose only schema lives on "default".
      {
        operationId: "betaOp",
        methodFound: true,
        requestOk: true,
        responseOk: false,
        failure: "zod issues: err missing",
      },
      // Mock 5xx note: counted OK, must NOT be rendered as a failure.
      {
        operationId: "gammaOp",
        methodFound: true,
        requestOk: true,
        responseOk: true,
        failure: "mock returned 501 (mock gap, not a client fault)",
      },
      // Request rejected by the mock (4xx).
      {
        operationId: "deltaOp",
        methodFound: true,
        requestOk: false,
        responseOk: false,
        failure: "Prism 422: limit must be integer",
      },
    ],
  };
  const text = renderExerciseFeedback(result, ir);

  it("summarizes accepted requests and validated responses", () => {
    expect(text).toContain("3/4 requests accepted, 1/4 responses validated.");
  });

  it("renders a failing op block with method, path, detail, params, and body schema", () => {
    expect(text).toContain("- alphaOp (GET /alpha/{id}): zod issues: ok missing");
    expect(text).toContain(
      'expected params: [{"name":"id","in":"path","required":true}]',
    );
    expect(text).toContain(
      'request body schema: {"type":"object","required":["name"]}',
    );
  });

  it("includes the success-response schema fragment on validation failures", () => {
    // alphaOp: exact 2xx wins over 404.
    expect(text).toContain('response schema (200): {"type":"object","required":["ok"]}');
    // betaOp: falls back to "default".
    expect(text).toContain(
      'response schema (default): {"type":"object","required":["err"]}',
    );
  });

  it("does not attach a response schema when the request itself failed", () => {
    const deltaBlock = text.slice(text.indexOf("- deltaOp"));
    expect(deltaBlock).toContain("Prism 422: limit must be integer");
    expect(deltaBlock).toContain("expected params:");
    expect(deltaBlock).not.toContain("response schema");
  });

  it("does not render 5xx-note ops (all-OK with a failure note) as failures", () => {
    expect(text).not.toContain("gammaOp");
    expect(text).not.toContain("mock gap");
  });

  it("renders a bare line for an operationId missing from the IR", () => {
    const orphan = renderExerciseFeedback(
      {
        total: 1,
        methodsFound: 0,
        requestsOk: 0,
        responsesOk: 0,
        ops: [
          {
            operationId: "ghostOp",
            methodFound: false,
            requestOk: false,
            responseOk: false,
            failure: "method not found",
          },
        ],
      },
      ir,
    );
    expect(orphan).toContain("- ghostOp: method not found");
  });

  it("caps output at ~9000 characters and notes truncation", () => {
    const many: ExerciseResult = {
      total: 8,
      methodsFound: 8,
      requestsOk: 0,
      responsesOk: 0,
      ops: Array.from({ length: 8 }, (_, i) => ({
        operationId: `bigOp${i}`,
        methodFound: true,
        requestOk: false,
        responseOk: false,
        failure: `F${i}-` + "x".repeat(2000),
      })),
    };
    const capped = renderExerciseFeedback(many, ir);
    expect(capped).toContain("...(truncated)");
    expect(capped.length).toBeLessThanOrEqual(9000 + "\n...(truncated)".length);
    // The last op's block never fit.
    expect(capped).not.toContain("bigOp7");
  });
});
