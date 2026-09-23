/**
 * exerciseClient against a real Prism mock of the tinyspec fixture, using the
 * hand-written "generated" client fixtures (no LLM involved):
 *
 * - a fully correct client -> every op methodFound/requestOk/responseOk;
 * - a client whose zod response validation demands a field Prism never
 *   returns -> requestOk=true, responseOk=false with failure detail;
 * - a client that requests an undeclared path (/widgetz) -> requestOk=false.
 */

import { rm } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadSpec } from "../../src/ir/load.js";
import type { ClientIR, ExerciseResult, GeneratedFiles, OpExerciseResult } from "../../src/types.js";
import { transpile } from "../../src/validate/compile.js";
import { exerciseClient } from "../../src/validate/exercise.js";
import { startMock, type MockServer } from "../../src/validate/mock-server.js";
import { INDEX_SOURCE, readFixture, scratchDir, TINYSPEC_PATH } from "./helpers.js";

const OP_IDS = ["createWidget", "getWidget", "listWidgets"];

function opById(result: ExerciseResult, operationId: string): OpExerciseResult {
  const op = result.ops.find((o) => o.operationId === operationId);
  expect(op, `expected an exercise result for ${operationId}`).toBeDefined();
  return op as OpExerciseResult;
}

describe("exerciseClient against a Prism mock of tinyspec", () => {
  let mock: MockServer | undefined;
  let ir: ClientIR;
  let workDir: string;
  let schemas: string;
  let correctClient: string;

  beforeAll(async () => {
    workDir = scratchDir("exercise");
    schemas = readFixture("correct-schemas.ts");
    correctClient = readFixture("correct-client.ts");
    ir = await loadSpec(TINYSPEC_PATH);
    mock = await startMock(TINYSPEC_PATH); // startMock allocates its own free port
  });

  afterAll(async () => {
    try {
      await mock?.stop();
    } catch {
      // already gone
    }
    mock = undefined;
    await rm(workDir, { recursive: true, force: true });
  });

  function filesWith(client: string): GeneratedFiles {
    return { "schemas.ts": schemas, "client.ts": client, "index.ts": INDEX_SOURCE };
  }

  async function run(client: string, label: string): Promise<ExerciseResult> {
    const bundle = await transpile(filesWith(client), join(workDir, label));
    if (mock === undefined) throw new Error("mock not started");
    return exerciseClient(bundle, ir, mock.url);
  }

  it("loads tinyspec into the expected IR (fixture sanity)", () => {
    expect(ir.title).toBe("Tiny Widget API");
    expect(ir.baseUrl).toBe("http://localhost:4010");
    expect(ir.auth).toEqual([]);
    expect([...ir.operations.map((op) => op.operationId)].sort()).toEqual(OP_IDS);
    expect(Object.keys(ir.schemas).sort()).toEqual(["NewWidget", "Widget"]);
  });

  it("classifies a fully correct client as all-ok", async () => {
    const result = await run(correctClient, "correct");

    expect(result.total).toBe(3);
    for (const op of result.ops) {
      expect(op.methodFound, `${op.operationId} methodFound (${op.failure ?? ""})`).toBe(true);
      expect(op.requestOk, `${op.operationId} requestOk (${op.failure ?? ""})`).toBe(true);
      expect(op.responseOk, `${op.operationId} responseOk (${op.failure ?? ""})`).toBe(true);
    }
    expect(result.methodsFound).toBe(3);
    expect(result.requestsOk).toBe(3);
    expect(result.responsesOk).toBe(3);
  });

  it("flags a zod response-validation failure as responseOk=false with failure detail", async () => {
    // listWidgets now validates with a schema requiring a field Prism never returns.
    const badClient = correctClient.replace(
      "this.validateBody(z.array(WidgetSchema), raw)",
      "this.validateBody(z.object({ nope: z.string() }), raw)"
    );
    expect(badClient, "fixture drift: validation call site not found").not.toBe(correctClient);

    const result = await run(badClient, "bad-validation");

    const list = opById(result, "listWidgets");
    expect(list.methodFound).toBe(true);
    expect(list.requestOk).toBe(true);
    expect(list.responseOk).toBe(false);
    expect(list.failure).toBeDefined();
    expect(list.failure).toMatch(/zod validation/);

    // The other two operations are untouched and stay green.
    expect(opById(result, "getWidget").responseOk).toBe(true);
    expect(opById(result, "createWidget").responseOk).toBe(true);
    expect(result.methodsFound).toBe(3);
    expect(result.requestsOk).toBe(3);
    expect(result.responsesOk).toBe(2);
  });

  it("flags a request to an undeclared path (/widgetz) as requestOk=false", async () => {
    const wrongPathClient = correctClient.replace(
      'this.request("GET", "/widgets")',
      'this.request("GET", "/widgetz")'
    );
    expect(wrongPathClient, "fixture drift: request call site not found").not.toBe(correctClient);

    const result = await run(wrongPathClient, "wrong-path");

    const list = opById(result, "listWidgets");
    expect(list.methodFound).toBe(true);
    expect(list.requestOk).toBe(false);
    expect(list.responseOk).toBe(false);
    expect(list.failure).toBeDefined();
    expect(list.failure).toMatch(/HTTP 404/);

    expect(opById(result, "getWidget").requestOk).toBe(true);
    expect(opById(result, "createWidget").requestOk).toBe(true);
    expect(result.requestsOk).toBe(2);
    expect(result.responsesOk).toBe(2);
  });
});
