import { z } from "zod";
import {
  TaskListSchema,
  type TaskList,
  TaskSchema,
  type Task,
  ErrorSchema,
  type Error as ApiErrorBody,
  LabelListSchema,
  type LabelList,
} from "./schemas.js";

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
    super(message ?? `API request failed with status ${status}`);
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

    if (this.config.apiKey !== undefined) {
      headers["X-Api-Key"] = this.config.apiKey;
    }
    if (this.config.basicAuth !== undefined) {
      const credentials = btoa(
        this.config.basicAuth.username + ":" + this.config.basicAuth.password
      );
      headers["Authorization"] = "Basic " + credentials;
    }
    if (this.config.bearerToken !== undefined) {
      headers["Authorization"] = "Bearer " + this.config.bearerToken;
    }
    if (this.config.headers !== undefined) {
      for (const [key, value] of Object.entries(this.config.headers)) {
        headers[key] = value;
      }
    }
    if (extra !== undefined) {
      for (const [key, value] of Object.entries(extra)) {
        headers[key] = value;
      }
    }
    return headers;
  }

  private buildUrl(path: string, query?: Record<string, unknown>): string {
    const base = this.config.baseUrl.replace(/\/+$/, "");
    const joinedPath = path.startsWith("/") ? path : "/" + path;
    let url = base + joinedPath;

    if (query !== undefined) {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(query)) {
        if (value === undefined) {
          continue;
        }
        if (Array.isArray(value)) {
          for (const item of value) {
            params.append(key, String(item));
          }
        } else {
          params.append(key, String(value));
        }
      }
      const qs = params.toString();
      if (qs.length > 0) {
        url += "?" + qs;
      }
    }
    return url;
  }

  async listTasks(args?: {
    status?: "todo" | "in_progress" | "done";
  }): Promise<{ status: number; data: TaskList }> {
    const url = this.buildUrl("/tasks", { status: args?.status });
    const headers = this.buildHeaders();
    const doFetch = this.config.fetch ?? fetch;
    const response = await doFetch(url, {
      method: "GET",
      headers,
    });

    const status = response.status;
    if (status < 200 || status >= 300) {
      const body = await this.parseBody(response);
      throw new ApiError(status, body);
    }
    const json = await response.json();
    const parsed = TaskListSchema.safeParse(json);
    if (!parsed.success) {
      throw new ResponseValidationError(parsed.error.issues);
    }
    return { status, data: parsed.data };
  }

  async createTask(args: {
    body: {
      title: string;
      description?: string;
      priority?: "low" | "medium" | "high";
      labels?: string[];
      dueAt?: string;
    };
  }): Promise<{ status: number; data: Task }> {
    const url = this.buildUrl("/tasks");
    const headers = this.buildHeaders({ "Content-Type": "application/json" });
    const doFetch = this.config.fetch ?? fetch;
    const response = await doFetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(args.body),
    });

    const status = response.status;
    if (status < 200 || status >= 300) {
      const body = await this.parseBody(response);
      throw new ApiError(status, body);
    }
    const json = await response.json();
    const parsed = TaskSchema.safeParse(json);
    if (!parsed.success) {
      throw new ResponseValidationError(parsed.error.issues);
    }
    return { status, data: parsed.data };
  }

  async getTask(args: {
    taskId: number;
  }): Promise<{ status: number; data: Task }> {
    const url = this.buildUrl(
      "/tasks/" + encodeURIComponent(String(args.taskId))
    );
    const headers = this.buildHeaders();
    const doFetch = this.config.fetch ?? fetch;
    const response = await doFetch(url, {
      method: "GET",
      headers,
    });

    const status = response.status;
    if (status < 200 || status >= 300) {
      const body = await this.parseBody(response);
      throw new ApiError(status, body);
    }
    const json = await response.json();
    const parsed = TaskSchema.safeParse(json);
    if (!parsed.success) {
      throw new ResponseValidationError(parsed.error.issues);
    }
    return { status, data: parsed.data };
  }

  async deleteTask(args: {
    taskId: number;
  }): Promise<{ status: number; data: undefined }> {
    const url = this.buildUrl(
      "/tasks/" + encodeURIComponent(String(args.taskId))
    );
    const headers = this.buildHeaders();
    const doFetch = this.config.fetch ?? fetch;
    const response = await doFetch(url, {
      method: "DELETE",
      headers,
    });

    const status = response.status;
    if (status < 200 || status >= 300) {
      const body = await this.parseBody(response);
      throw new ApiError(status, body);
    }
    return { status, data: undefined };
  }

  async updateTask(args: {
    taskId: number;
    body: {
      title?: string;
      description?: string;
      status?: "todo" | "in_progress" | "done";
      priority?: "low" | "medium" | "high";
      labels?: string[];
      dueAt?: string;
    };
  }): Promise<{ status: number; data: Task }> {
    const url = this.buildUrl(
      "/tasks/" + encodeURIComponent(String(args.taskId))
    );
    const headers = this.buildHeaders({ "Content-Type": "application/json" });
    const doFetch = this.config.fetch ?? fetch;
    const response = await doFetch(url, {
      method: "PATCH",
      headers,
      body: JSON.stringify(args.body),
    });

    const status = response.status;
    if (status < 200 || status >= 300) {
      const body = await this.parseBody(response);
      throw new ApiError(status, body);
    }
    const json = await response.json();
    const parsed = TaskSchema.safeParse(json);
    if (!parsed.success) {
      throw new ResponseValidationError(parsed.error.issues);
    }
    return { status, data: parsed.data };
  }

  async completeTask(args: {
    taskId: number;
  }): Promise<{ status: number; data: Task }> {
    const url = this.buildUrl(
      "/tasks/" + encodeURIComponent(String(args.taskId)) + "/complete"
    );
    const headers = this.buildHeaders();
    const doFetch = this.config.fetch ?? fetch;
    const response = await doFetch(url, {
      method: "POST",
      headers,
    });

    const status = response.status;
    if (status < 200 || status >= 300) {
      const body = await this.parseBody(response);
      throw new ApiError(status, body);
    }
    const json = await response.json();
    const parsed = TaskSchema.safeParse(json);
    if (!parsed.success) {
      throw new ResponseValidationError(parsed.error.issues);
    }
    return { status, data: parsed.data };
  }

  async listLabels(): Promise<{ status: number; data: LabelList }> {
    const url = this.buildUrl("/labels");
    const headers = this.buildHeaders();
    const doFetch = this.config.fetch ?? fetch;
    const response = await doFetch(url, {
      method: "GET",
      headers,
    });

    const status = response.status;
    if (status < 200 || status >= 300) {
      const body = await this.parseBody(response);
      throw new ApiError(status, body);
    }
    const json = await response.json();
    const parsed = LabelListSchema.safeParse(json);
    if (!parsed.success) {
      throw new ResponseValidationError(parsed.error.issues);
    }
    return { status, data: parsed.data };
  }

  private async parseBody(response: Response): Promise<unknown> {
    const text = await response.text();
    if (text.length === 0) {
      return undefined;
    }
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
}
