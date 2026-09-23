import { z } from "zod";
import { WidgetSchema, type NewWidget, type Widget } from "./schemas.js";

export interface ClientConfig {
  baseUrl: string;
  apiKey?: string;
  bearerToken?: string;
  basicAuth?: { username: string; password: string };
  headers?: Record<string, string>;
  fetch?: typeof fetch;
}

export class ApiError extends Error {
  name = "ApiError";
  status: number;
  body: unknown;
  constructor(status: number, body: unknown) {
    super(`Request failed with HTTP ${status}`);
    this.status = status;
    this.body = body;
  }
}

export class ResponseValidationError extends Error {
  name = "ResponseValidationError";
  issues: unknown;
  constructor(issues: unknown) {
    super("Response body failed schema validation");
    this.issues = issues;
  }
}

interface RawResponse {
  status: number;
  text: string;
}

export class ApiClient {
  private readonly config: ClientConfig;

  constructor(config: ClientConfig) {
    this.config = config;
  }

  private buildUrl(path: string, query?: Record<string, unknown>): string {
    const base = this.config.baseUrl.replace(/\/+$/, "");
    let url = base + path;
    if (query !== undefined) {
      const parts: string[] = [];
      for (const [key, value] of Object.entries(query)) {
        if (value === undefined) continue;
        const values = Array.isArray(value) ? value : [value];
        for (const item of values) {
          parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(item))}`);
        }
      }
      if (parts.length > 0) url += `?${parts.join("&")}`;
    }
    return url;
  }

  private buildHeaders(contentType?: string): Record<string, string> {
    const headers: Record<string, string> = { ...this.config.headers };
    if (contentType !== undefined) headers["Content-Type"] = contentType;
    if (this.config.bearerToken !== undefined) {
      headers["Authorization"] = `Bearer ${this.config.bearerToken}`;
    }
    if (this.config.basicAuth !== undefined) {
      const credentials = btoa(`${this.config.basicAuth.username}:${this.config.basicAuth.password}`);
      headers["Authorization"] = `Basic ${credentials}`;
    }
    return headers;
  }

  private async request(
    method: string,
    path: string,
    query?: Record<string, unknown>,
    body?: unknown,
    contentType?: string,
  ): Promise<RawResponse> {
    const doFetch = this.config.fetch ?? fetch;
    const init: RequestInit = {
      method,
      headers: this.buildHeaders(body !== undefined ? contentType : undefined),
    };
    if (body !== undefined) init.body = JSON.stringify(body);
    const response = await doFetch(this.buildUrl(path, query), init);
    const text = await response.text();
    if (response.status < 200 || response.status >= 300) {
      let parsed: unknown = text;
      try {
        parsed = JSON.parse(text);
      } catch {
        // Non-JSON error body: keep the raw text.
      }
      throw new ApiError(response.status, parsed);
    }
    return { status: response.status, text };
  }

  private validateBody<T>(schema: z.ZodType<T>, raw: RawResponse): { status: number; data: T } {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.text);
    } catch (err) {
      throw new ResponseValidationError(err instanceof Error ? err.message : String(err));
    }
    const result = schema.safeParse(parsed);
    if (!result.success) throw new ResponseValidationError(result.error.issues);
    return { status: raw.status, data: result.data };
  }

  async listWidgets(): Promise<{ status: number; data: Widget[] }> {
    const raw = await this.request("GET", "/widgets");
    return this.validateBody(z.array(WidgetSchema), raw);
  }

  async createWidget(args: { body: NewWidget }): Promise<{ status: number; data: Widget }> {
    const raw = await this.request("POST", "/widgets", undefined, args.body, "application/json");
    return this.validateBody(WidgetSchema, raw);
  }

  async getWidget(args: { id: number }): Promise<{ status: number; data: Widget }> {
    const raw = await this.request("GET", `/widgets/${encodeURIComponent(String(args.id))}`);
    return this.validateBody(WidgetSchema, raw);
  }
}
