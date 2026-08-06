import {
  fetchAndParseSpec,
  summarizeForLlm,
  selectEndpointsForLlm,
  assertHttpUrl,
  truncate,
  type ParsedSpec,
} from "@/lib/openapi";
import { generateJsonResponse, hasGroqKey, currentModel, GroqError } from "@/lib/groq";
import type { AgentEvent, Attempt, LlmRequest } from "@/lib/types";

const MAX_ATTEMPTS = 3;
const MAX_ENDPOINTS_FOR_LLM = 15;
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS ?? 20_000);

const ALLOWED_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

const SYSTEM_PROMPT = `You are SelfHeal, an autonomous API agent. You turn a plain-English goal into ONE exact HTTP request against a public REST API described by an OpenAPI spec.

Rules:
- Output ONLY a single valid JSON object. No markdown, no code fences, no prose, no explanation.
- The JSON must have exactly this shape:
  {"method":"GET","url":"https://...","headers":{},"body":null}
- "method" is one of: GET, POST, PUT, PATCH, DELETE.
- "url" must be an absolute http(s) URL. Replace every path parameter with a concrete value derived from the goal. Add query parameters when the goal implies filtering, searching, or pagination.
- "headers" may be omitted or {}. Set "Content-Type":"application/json" only when you send a "body". Never invent API keys or auth headers — the API is public.
- "body" may be null, or an object matching the endpoint's request schema, using values implied by the goal.
- Use ONLY endpoints listed in the spec. Never invent paths or methods.
- Pick the endpoint whose path and parameters best satisfy the goal.`;

interface RunAttemptOptions {
  attemptNumber: number;
  goal: string;
  specSummary: string;
  previousAttempts: Attempt[];
  emit: (event: AgentEvent) => void;
}

export async function runAgent(
  specUrl: string,
  goal: string,
  emit: (event: AgentEvent) => void,
): Promise<void> {
  const attempts: Attempt[] = [];
  emit({ type: "log", message: "SELFHEAL agent started", level: "info" });
  emit({ type: "log", message: `  spec: ${specUrl}`, level: "info" });
  emit({ type: "log", message: `  goal: ${goal}`, level: "info" });

  if (!hasGroqKey()) {
    emit({
      type: "log",
      message: `GROQ_API_KEY is not set. Copy .env.example to .env.local and add your key from https://console.groq.com/keys`,
      level: "error",
    });
    emit({ type: "final", success: false, allAttempts: attempts });
    return;
  }

  emit({ type: "log", message: `model: ${currentModel()}`, level: "info" });
  emit({ type: "log", message: "fetching & parsing OpenAPI spec …", level: "info" });

  let parsed: ParsedSpec;
  try {
    parsed = await fetchAndParseSpec(specUrl);
  } catch (err) {
    emit({ type: "log", message: `spec error: ${err instanceof Error ? err.message : String(err)}`, level: "error" });
    emit({ type: "final", success: false, allAttempts: attempts });
    return;
  }

  emit({ type: "spec_loaded", specTitle: parsed.title, endpointCount: parsed.endpoints.length, baseUrl: parsed.baseUrl });

  const totalEndpoints = parsed.endpoints.length;
  const relevantEndpoints = selectEndpointsForLlm(parsed, goal, MAX_ENDPOINTS_FOR_LLM);
  if (relevantEndpoints.length < totalEndpoints) {
    emit({
      type: "log",
      message: `spec filtered: ${totalEndpoints} endpoints → keeping top ${relevantEndpoints.length} most relevant to the goal (keyword match)`,
      level: "info",
    });
  }
  const specSummary = summarizeForLlm(
    { ...parsed, endpoints: relevantEndpoints },
    { total: totalEndpoints },
  );

  for (let i = 1; i <= MAX_ATTEMPTS; i++) {
    const attempt = await runAttempt({
      attemptNumber: i,
      goal,
      specSummary,
      previousAttempts: attempts,
      emit,
    });
    attempts.push(attempt);

    if (attempt.status === "succeeded") {
      emit({ type: "final", success: true, response: attempt.responseBody, allAttempts: attempts });
      return;
    }
  }

  emit({ type: "log", message: `gave up after ${MAX_ATTEMPTS} failed attempts`, level: "error" });
  emit({ type: "final", success: false, allAttempts: attempts });
}

async function runAttempt(opts: RunAttemptOptions): Promise<Attempt> {
  const { attemptNumber, goal, specSummary, previousAttempts, emit } = opts;
  const previous = previousAttempts[previousAttempts.length - 1];

  emit({ type: "llm_thinking", attemptNumber });

  let request: LlmRequest;
  try {
    const raw = await generateJsonResponse(SYSTEM_PROMPT, buildUserPrompt({ goal, specSummary, previous, attemptNumber }));
    request = parseLlmJson(raw);
    validateLlmRequest(request);
  } catch (err) {
    if (err instanceof GroqError) {
      throw err;
    }
    const errorText = err instanceof Error ? err.message : String(err);
    emit({ type: "attempt_result", attemptNumber, success: false, error: errorText });
    return { attemptNumber, status: "failed", error: errorText };
  }

  emit({ type: "attempt", attemptNumber, request });

  const outcome = await executeRequest(request);
  if (outcome.ok) {
    emit({ type: "attempt_result", attemptNumber, success: true, statusCode: outcome.statusCode });
    return {
      attemptNumber,
      request,
      status: "succeeded",
      statusCode: outcome.statusCode,
      responseBody: outcome.body,
    };
  }

  const errorText = outcome.error ?? "unknown error";
  emit({ type: "attempt_result", attemptNumber, success: false, statusCode: outcome.statusCode, error: errorText });
  return { attemptNumber, request, status: "failed", statusCode: outcome.statusCode, error: errorText };
}

function buildUserPrompt(input: {
  goal: string;
  specSummary: string;
  previous?: Attempt;
  attemptNumber: number;
}): string {
  const lines: string[] = [];
  lines.push(input.specSummary);
  lines.push("");
  lines.push(`USER GOAL: ${input.goal}`);

  if (input.previous) {
    lines.push("");
    lines.push(`YOUR PREVIOUS ATTEMPT (attempt ${input.previous.attemptNumber}) FAILED.`);
    lines.push(
      `Previous request: ${input.previous.request ? JSON.stringify(input.previous.request) : "(no valid request was produced — fix your output format)"}`,
    );
    if (input.previous.error) lines.push(`Failure reason: ${truncate(input.previous.error, 500)}`);
    lines.push("Diagnose why it failed and produce a corrected request.");
  } else {
    lines.push("Pick the single best endpoint and produce the exact request.");
  }

  lines.push("");
  lines.push('Respond with ONLY a JSON object: {"method":"...","url":"...","headers":{},"body":null}');
  return lines.join("\n");
}

function parseLlmJson(raw: string): LlmRequest {
  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/, "")
    .trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(`LLM response contained no JSON object. Raw response: ${truncate(raw, 300)}`);
  }
  const jsonText = cleaned.slice(start, end + 1);

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (err) {
    throw new Error(`LLM returned invalid JSON: ${err instanceof Error ? err.message : String(err)}. Raw: ${truncate(raw, 300)}`);
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("LLM response is not a JSON object");
  }
  const obj = parsed as Record<string, unknown>;

  const method = typeof obj.method === "string" ? obj.method.trim().toUpperCase() : "";
  const url = typeof obj.url === "string" ? obj.url.trim() : "";
  const headers = obj.headers;
  if (headers !== undefined && headers !== null) {
    if (typeof headers !== "object" || Array.isArray(headers)) {
      throw new Error("LLM returned an invalid \"headers\" value (must be an object)");
    }
    for (const [k, v] of Object.entries(headers)) {
      if (typeof v !== "string" && typeof v !== "number" && typeof v !== "boolean") {
        throw new Error("LLM returned a non-string value in \"headers\"");
      }
    }
  }
  const body = obj.body;

  return {
    method,
    url,
    headers: headers ? (headers as Record<string, string>) : undefined,
    body,
  };
}

function validateLlmRequest(request: LlmRequest): void {
  if (!ALLOWED_METHODS.includes(request.method)) {
    throw new Error(`invalid HTTP method "${request.method}" — allowed: ${ALLOWED_METHODS.join(", ")}`);
  }
  if (!request.url) {
    throw new Error("LLM did not return a url");
  }
  try {
    assertHttpUrl(request.url, "LLM-generated url");
  } catch (err) {
    throw new Error(err instanceof Error ? err.message : String(err));
  }
}

async function executeRequest(request: LlmRequest): Promise<{
  ok: boolean;
  statusCode?: number;
  body?: unknown;
  error?: string;
}> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  const headers: Record<string, string> = { ...(request.headers ?? {}) };
  const init: RequestInit = {
    method: request.method,
    headers,
    signal: controller.signal,
    redirect: "follow",
  };

  const hasBody = request.body !== undefined && request.body !== null;
  if (hasBody) {
    if (!Object.entries(headers).some(([k, v]) => k.toLowerCase() === "content-type")) {
      headers["Content-Type"] = "application/json";
    }
    init.body = typeof request.body === "string" ? request.body : JSON.stringify(request.body);
  }

  try {
    const res = await fetch(request.url, init);
    const text = await res.text();
    let data: unknown = text;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }
    if (res.ok) {
      return { ok: true, statusCode: res.status, body: data };
    }
    const snippet = truncate(text.trim(), 500);
    return {
      ok: false,
      statusCode: res.status,
      error: `HTTP ${res.status} ${res.statusText}${snippet ? ` — ${snippet}` : ""}`,
    };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return { ok: false, error: `request to ${request.url} timed out after ${REQUEST_TIMEOUT_MS}ms` };
    }
    return { ok: false, error: `request failed: ${err instanceof Error ? err.message : String(err)}` };
  } finally {
    clearTimeout(timer);
  }
}
