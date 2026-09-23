import { z } from "zod";
import { dataSetListSchema, type dataSetList } from "./schemas.js";

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
  constructor(status: number, body: unknown, message?: string) {
    super(message ?? `API error: ${status}`);
    this.status = status;
    this.body = body;
  }
}

export class ResponseValidationError extends Error {
  name = "ResponseValidationError";
  issues: unknown;
  constructor(issues: unknown, message?: string) {
    super(message ?? "Response validation failed");
    this.issues = issues;
  }
}

export class ApiClient {
  private config: ClientConfig;

  constructor(config: ClientConfig) {
    this.config = config;
  }

  private buildHeaders(extra?: Record<string, string>): Record<string, string> {
    const headers: Record<string, string> = {};
    headers["Accept"] = "application/json";

    if (this.config.bearerToken !== undefined) {
      headers["Authorization"] = `Bearer ${this.config.bearerToken}`;
    } else if (this.config.basicAuth !== undefined) {
      const credentials = btoa(
        this.config.basicAuth.username + ":" + this.config.basicAuth.password
      );
      headers["Authorization"] = `Basic ${credentials}`;
    }

    if (this.config.headers !== undefined) {
      for (const [k, v] of Object.entries(this.config.headers)) {
        headers[k] = v;
      }
    }

    if (extra !== undefined) {
      for (const [k, v] of Object.entries(extra)) {
        headers[k] = v;
      }
    }

    return headers;
  }

  private joinUrl(path: string): string {
    const base = this.config.baseUrl.endsWith("/")
      ? this.config.baseUrl.slice(0, -1)
      : this.config.baseUrl;
    const p = path.startsWith("/") ? path : "/" + path;
    return base + p;
  }

  async listDataSets(): Promise<{ status: number; data: dataSetList }> {
    const url = this.joinUrl("/");
    const headers = this.buildHeaders();
    const doFetch = this.config.fetch ?? fetch;
    const response = await doFetch(url, {
      method: "GET",
      headers,
    });

    const status = response.status;
    if (status < 200 || status >= 300) {
      const text = await response.text();
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
      throw new ApiError(status, body);
    }

    const json = await response.json();
    const result = dataSetListSchema.safeParse(json);
    if (!result.success) {
      throw new ResponseValidationError(result.error.issues);
    }
    return { status, data: result.data };
  }

  async listSearchableFields(args: {
    dataset: string;
    version: string;
  }): Promise<{ status: number; data: unknown }> {
    let path = "/{dataset}/{version}/fields";
    path = path.replace(
      "{dataset}",
      encodeURIComponent(String(args.dataset))
    );
    path = path.replace(
      "{version}",
      encodeURIComponent(String(args.version))
    );
    const url = this.joinUrl(path);
    const headers = this.buildHeaders();
    const doFetch = this.config.fetch ?? fetch;
    const response = await doFetch(url, {
      method: "GET",
      headers,
    });

    const status = response.status;
    if (status < 200 || status >= 300) {
      const text = await response.text();
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
      throw new ApiError(status, body);
    }

    const json = await response.json();
    const result = z.unknown().safeParse(json);
    if (!result.success) {
      throw new ResponseValidationError(result.error.issues);
    }
    return { status, data: result.data };
  }

  async performSearch(args: {
    version: string;
    dataset: string;
    body?: { criteria: string; start?: number; rows?: number };
  }): Promise<{ status: number; data: unknown }> {
    let path = "/{dataset}/{version}/records";
    path = path.replace(
      "{dataset}",
      encodeURIComponent(String(args.dataset))
    );
    path = path.replace(
      "{version}",
      encodeURIComponent(String(args.version))
    );
    const url = this.joinUrl(path);
    const headers = this.buildHeaders();
    const doFetch = this.config.fetch ?? fetch;

    let requestBody: string | undefined;
    if (args.body !== undefined) {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(args.body)) {
        if (v === undefined) {
          continue;
        }
        if (Array.isArray(v)) {
          for (const item of v) {
            params.append(k, String(item));
          }
        } else {
          params.append(k, String(v));
        }
      }
      requestBody = params.toString();
      headers["Content-Type"] = "application/x-www-form-urlencoded";
    }

    const response = await doFetch(url, {
      method: "POST",
      headers,
      body: requestBody,
    });

    const status = response.status;
    if (status < 200 || status >= 300) {
      throw new ApiError(status, undefined);
    }

    const json = await response.json();
    const result = z.unknown().safeParse(json);
    if (!result.success) {
      throw new ResponseValidationError(result.error.issues);
    }
    return { status, data: result.data };
  }
}
