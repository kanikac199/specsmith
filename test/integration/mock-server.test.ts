/**
 * startMock lifecycle against the tinyspec fixture: the spec validates, the
 * mock boots and serves spec-faithful responses, and stop() really terminates
 * the process (and is idempotent).
 */

import SwaggerParser from "@apidevtools/swagger-parser";
import { afterEach, describe, expect, it } from "vitest";

import { startMock, type MockServer } from "../../src/validate/mock-server.js";
import { TINYSPEC_PATH } from "./helpers.js";

describe("tinyspec fixture", () => {
  it("passes SwaggerParser.validate", async () => {
    const doc = await SwaggerParser.validate(TINYSPEC_PATH);
    expect(doc).toBeDefined();
    expect((doc as { openapi?: string }).openapi).toBe("3.0.3");
  });
});

describe("startMock", () => {
  let mock: MockServer | undefined;

  afterEach(async () => {
    // Always kill the mock, even when an assertion failed mid-test.
    if (mock !== undefined) {
      try {
        await mock.stop();
      } catch {
        // already gone
      }
      mock = undefined;
    }
  });

  it("boots tinyspec and answers GET /widgets with 2xx JSON", async () => {
    mock = await startMock(TINYSPEC_PATH);
    expect(mock.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

    const response = await fetch(`${mock.url}/widgets`);
    expect(response.status).toBeGreaterThanOrEqual(200);
    expect(response.status).toBeLessThan(300);

    const body: unknown = await response.json();
    expect(Array.isArray(body)).toBe(true);
    expect((body as unknown[]).length).toBeGreaterThan(0);
  });

  it("stop() terminates the server (port closed) and is idempotent", async () => {
    mock = await startMock(TINYSPEC_PATH);
    const { url } = mock;

    // Sanity: reachable before stop.
    const before = await fetch(`${url}/widgets`);
    expect(before.status).toBe(200);

    await mock.stop();

    // stop() awaits process exit, so the port must now refuse connections.
    await expect(fetch(`${url}/widgets`)).rejects.toThrow();

    // Idempotent: a second stop() resolves without error.
    await expect(mock.stop()).resolves.toBeUndefined();
    mock = undefined;
  });
});
