export interface LlmRequest {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: unknown;
}

export interface Attempt {
  attemptNumber: number;
  request?: LlmRequest;
  status: "succeeded" | "failed";
  statusCode?: number;
  error?: string;
  responseBody?: unknown;
}

export type AgentEvent =
  | { type: "log"; message: string; level?: "info" | "success" | "warn" | "error" }
  | { type: "spec_loaded"; specTitle: string; endpointCount: number; baseUrl: string }
  | { type: "llm_thinking"; attemptNumber: number }
  | { type: "attempt"; attemptNumber: number; request: LlmRequest }
  | {
      type: "attempt_result";
      attemptNumber: number;
      success: boolean;
      statusCode?: number;
      error?: string;
    }
  | { type: "final"; success: boolean; response?: unknown; allAttempts: Attempt[] };
