/**
 * Unit tests for src/agent/prompts.ts: the tolerant ===FILE=== block parser
 * (parseFiles) and the three prompt builders.
 */

import { describe, expect, it } from "vitest";
import {
  CLIENT_CONTRACT,
  buildClientPrompt,
  buildRepairPrompt,
  buildSchemasPrompt,
  parseFiles,
} from "../../src/agent/prompts.js";
import type { ClientIR } from "../../src/types.js";

const FENCE = "```";

function block(name: string, body: string, lang = "typescript"): string {
  return [`===FILE: ${name}===`, `${FENCE}${lang}`, body, FENCE, "===END==="].join("\n");
}

describe("parseFiles", () => {
  it("parses a single well-formed block", () => {
    const text = block("schemas.ts", "export const A = 1;");
    expect(parseFiles(text)).toEqual({ "schemas.ts": "export const A = 1;\n" });
  });

  it("normalizes trailing whitespace to a single newline", () => {
    const text = block("schemas.ts", "export const A = 1;\n\n   ");
    expect(parseFiles(text)).toEqual({ "schemas.ts": "export const A = 1;\n" });
  });

  it("recovers a block missing ===END=== via the fallback pass", () => {
    const text = [
      "===FILE: client.ts===",
      `${FENCE}typescript`,
      "const x = 1;",
      FENCE,
    ].join("\n");
    expect(parseFiles(text)).toEqual({ "client.ts": "const x = 1;\n" });
  });

  it("recovers truncated output (no closing fence, no END)", () => {
    const text = ["===FILE: client.ts===", `${FENCE}typescript`, "const x ="].join("\n");
    expect(parseFiles(text)).toEqual({ "client.ts": "const x =\n" });
  });

  it("parses multiple files, including a 'ts' fence tag", () => {
    const text = [
      block("schemas.ts", "// schemas"),
      block("client.ts", "// client", "ts"),
    ].join("\n\n");
    expect(parseFiles(text)).toEqual({
      "schemas.ts": "// schemas\n",
      "client.ts": "// client\n",
    });
  });

  it("last occurrence of the same filename wins", () => {
    const text = [block("client.ts", "// v1"), block("client.ts", "// v2")].join("\n\n");
    expect(parseFiles(text)).toEqual({ "client.ts": "// v2\n" });
  });

  it("a well-formed block beats a later malformed capture of the same file", () => {
    const text = [
      block("client.ts", "// good"),
      "===FILE: client.ts===",
      `${FENCE}typescript`,
      "// broken trailing garbage",
    ].join("\n");
    expect(parseFiles(text)).toEqual({ "client.ts": "// good\n" });
  });

  it("ignores prose around blocks", () => {
    const text = [
      "Sure! Here are the generated files:",
      "",
      block("schemas.ts", "export {};"),
      "",
      "Let me know if you need anything else.",
      "",
      block("client.ts", "export class ApiClient {}"),
      "",
      "Hope this helps!",
    ].join("\n");
    expect(parseFiles(text)).toEqual({
      "schemas.ts": "export {};\n",
      "client.ts": "export class ApiClient {}\n",
    });
  });

  it("returns {} when nothing matches", () => {
    expect(parseFiles("no file blocks here, sorry")).toEqual({});
    expect(parseFiles("")).toEqual({});
  });

  it("returns {} for a block whose body is blank", () => {
    expect(parseFiles(block("schemas.ts", "   "))).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// Prompt builders
// ---------------------------------------------------------------------------

const thingSchema = {
  type: "object",
  required: ["id"],
  properties: { id: { type: "string" } },
};

const ir: ClientIR = {
  title: "Demo API",
  version: "1.2.3",
  baseUrl: "http://127.0.0.1:9999",
  auth: [{ kind: "apiKey", name: "X-Key", in: "header", schemeName: "keyAuth" }],
  operations: [
    {
      operationId: "getThing",
      methodName: "getThing",
      method: "get",
      path: "/things/{id}",
      tag: "default",
      params: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
      responses: [
        {
          status: "200",
          contentType: "application/json",
          // Deep-equal to the named component so the prompt maps it to ThingSchema.
          schema: structuredClone(thingSchema),
        },
      ],
      requiresAuth: true,
    },
  ],
  schemas: { Thing: thingSchema },
};

describe("buildSchemasPrompt", () => {
  it("returns non-empty system and user, demanding the named exports", () => {
    const req = buildSchemasPrompt(ir);
    expect(req.system.length).toBeGreaterThan(0);
    expect(req.user.length).toBeGreaterThan(0);
    expect(req.user).toContain("Demo API");
    expect(req.user).toContain("export const ThingSchema");
    expect(req.user).toContain("export type Thing = z.infer<typeof ThingSchema>");
    expect(req.system).toContain("===FILE:");
  });

  it("handles an IR with no named schemas", () => {
    const empty: ClientIR = { ...ir, schemas: {} };
    const req = buildSchemasPrompt(empty);
    expect(req.system.length).toBeGreaterThan(0);
    expect(req.user).toContain("export {};");
  });
});

describe("buildClientPrompt", () => {
  const schemasSource = "export const ThingSchema = z.object({ id: z.string() });";
  const req = buildClientPrompt(ir, schemasSource);

  it("returns non-empty system and user", () => {
    expect(req.system.length).toBeGreaterThan(0);
    expect(req.user.length).toBeGreaterThan(0);
  });

  it("embeds the generated schemas source verbatim", () => {
    expect(req.user).toContain(schemasSource);
  });

  it("system carries the client contract markers", () => {
    for (const marker of ["ApiError", "ResponseValidationError", "ClientConfig", "ApiClient"]) {
      expect(req.system).toContain(marker);
    }
  });

  it("user lists operations by methodName and maps responses to zod validators", () => {
    expect(req.user).toContain('"methodName": "getThing"');
    expect(req.user).toContain('"validate": "ThingSchema"');
    expect(req.user).toContain('"dataType": "Thing"');
  });
});

describe("buildRepairPrompt", () => {
  const files = {
    "client.ts": "// BROKEN CLIENT SOURCE",
    "schemas.ts": "// SCHEMAS SOURCE",
  };
  const req = buildRepairPrompt(ir, files, "FEEDBACK-MARKER-XYZ");

  it("returns non-empty system and user with the contract", () => {
    expect(req.system.length).toBeGreaterThan(0);
    expect(req.user.length).toBeGreaterThan(0);
    expect(req.system).toContain("ApiError");
    expect(req.system).toContain(CLIENT_CONTRACT);
  });

  it("embeds the current files (schemas.ts before client.ts) and the feedback", () => {
    expect(req.user).toContain("// BROKEN CLIENT SOURCE");
    expect(req.user).toContain("// SCHEMAS SOURCE");
    expect(req.user.indexOf("--- schemas.ts ---")).toBeLessThan(
      req.user.indexOf("--- client.ts ---"),
    );
    expect(req.user).toContain("FEEDBACK-MARKER-XYZ");
  });
});

describe("CLIENT_CONTRACT", () => {
  it("is non-empty and names the mandatory exports", () => {
    expect(CLIENT_CONTRACT.length).toBeGreaterThan(0);
    expect(CLIENT_CONTRACT).toContain("ApiError");
    expect(CLIENT_CONTRACT).toContain("ResponseValidationError");
    expect(CLIENT_CONTRACT).toContain("ClientConfig");
  });
});

describe("prompt determinism", () => {
  it("the same IR produces byte-identical prompts", () => {
    const a = buildClientPrompt(ir, "src");
    const b = buildClientPrompt(structuredClone(ir), "src");
    expect(a).toEqual(b);
  });
});
