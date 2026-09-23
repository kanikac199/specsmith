/**
 * The crown jewel: drive generateClient end-to-end with a scripted
 * FakeProvider (no LLM, no network beyond the local Prism mock that
 * generateClient itself boots):
 *
 *   call 1 -> a correct schemas.ts
 *   call 2 -> a client.ts with a deliberate compile error
 *   call 3 -> a repaired, fully contract-conformant client.ts
 *
 * Expected loop shape: iteration 0 ("initial") fails typecheck, iteration 1
 * ("compile-repair") compiles and is exercised against the Prism mock of
 * tinyspec with every operation passing, then the loop stops as succeeded.
 */

import { rm } from "node:fs/promises";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { generateClient } from "../../src/agent/generate.js";
import { loadSpec } from "../../src/ir/load.js";
import type { ClientIR } from "../../src/types.js";
import { FakeProvider, fileBlock } from "./fake-provider.js";
import { INDEX_SOURCE, readFixture, scratchDir, TINYSPEC_PATH } from "./helpers.js";

describe("generateClient repair loop", () => {
  let ir: ClientIR;
  let workDir: string | undefined;

  beforeAll(async () => {
    ir = await loadSpec(TINYSPEC_PATH);
  });

  afterEach(async () => {
    if (workDir !== undefined) {
      await rm(workDir, { recursive: true, force: true });
      workDir = undefined;
    }
  });

  it("repairs a compile-broken client and exercises the fix to all-ok", async () => {
    const correctSchemas = readFixture("correct-schemas.ts");
    const brokenClient = readFixture("broken-client.ts");
    const correctClient = readFixture("correct-client.ts");

    const fake = new FakeProvider([
      { text: fileBlock("schemas.ts", correctSchemas), usage: { inputTokens: 11, outputTokens: 101 } },
      { text: fileBlock("client.ts", brokenClient), usage: { inputTokens: 13, outputTokens: 103 } },
      { text: fileBlock("client.ts", correctClient), usage: { inputTokens: 17, outputTokens: 107 } },
    ]);

    workDir = scratchDir("repair");
    const result = await generateClient(ir, TINYSPEC_PATH, {
      provider: fake,
      maxIterations: 2,
      workDir,
    });

    // ----- provider interaction: exactly 3 calls, in the scripted order -----
    expect(fake.calls).toHaveLength(3);
    expect(fake.remaining).toBe(0);
    // call 1: schemas prompt carries the named component schemas
    expect(fake.calls[0]!.user).toContain("Named component schemas");
    expect(fake.calls[0]!.user).toContain('"Widget"');
    // call 2: client prompt embeds the generated schemas.ts and the operations
    expect(fake.calls[1]!.user).toContain("NewWidgetSchema");
    expect(fake.calls[1]!.user).toContain("listWidgets");
    // call 3: repair prompt carries the compile feedback and the broken file
    expect(fake.calls[2]!.user).toContain("TypeScript compilation failed");
    expect(fake.calls[2]!.user).toContain("this client does not compile");

    // ----- iterations: [initial (compile fail), compile-repair (ok + exercised)] -----
    expect(result.iterations).toHaveLength(2);
    const initial = result.iterations[0]!;
    const repair = result.iterations[1]!;

    expect(initial.index).toBe(0);
    expect(initial.kind).toBe("initial");
    expect(initial.compile.ok).toBe(false);
    expect(initial.compile.errors.length).toBeGreaterThan(0);
    expect(initial.compile.errors[0]!.file).toBe("client.ts");
    expect(initial.compile.errors.some((e) => /not assignable/.test(e.message))).toBe(true);
    expect(initial.exercise).toBeUndefined();
    expect(initial.usage).toEqual({ inputTokens: 24, outputTokens: 204 });
    expect(initial.wallTimeMs).toBeGreaterThanOrEqual(0);

    expect(repair.index).toBe(1);
    expect(repair.kind).toBe("compile-repair");
    expect(repair.compile.ok).toBe(true);
    expect(repair.compile.errors).toEqual([]);
    expect(repair.usage).toEqual({ inputTokens: 17, outputTokens: 107 });
    expect(repair.wallTimeMs).toBeGreaterThanOrEqual(0);

    // ----- final exercise: every operation fully green -----
    const exercise = repair.exercise;
    expect(exercise).toBeDefined();
    expect(exercise!.total).toBe(ir.operations.length);
    expect(exercise!.total).toBe(3);
    for (const op of exercise!.ops) {
      expect(op.methodFound, `${op.operationId} methodFound (${op.failure ?? ""})`).toBe(true);
      expect(op.requestOk, `${op.operationId} requestOk (${op.failure ?? ""})`).toBe(true);
      expect(op.responseOk, `${op.operationId} responseOk (${op.failure ?? ""})`).toBe(true);
    }
    expect(exercise!.methodsFound).toBe(3);
    expect(exercise!.requestsOk).toBe(3);
    expect(exercise!.responsesOk).toBe(3);

    // ----- final files: the repaired client won, index.ts is deterministic -----
    expect(Object.keys(result.files).sort()).toEqual(["client.ts", "index.ts", "schemas.ts"]);
    expect(result.files["schemas.ts"]).toBe(correctSchemas);
    expect(result.files["client.ts"]).toBe(correctClient);
    expect(result.files["client.ts"]).not.toContain("this client does not compile");
    expect(result.files["index.ts"]).toBe(INDEX_SOURCE);

    // ----- usage aggregated across all three provider calls -----
    expect(result.usage).toEqual({ inputTokens: 41, outputTokens: 311 });
    expect(result.wallTimeMs).toBeGreaterThan(0);
  });
});
