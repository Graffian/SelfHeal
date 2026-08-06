import http from "node:http";
import { runAgent } from "../lib/agent";
import type { AgentEvent } from "../lib/types";

const MOCK_API = 4567;
const MOCK_GROQ = 4568;

const spec = {
  openapi: "3.0.0",
  info: { title: "Mock API", version: "1.0.0" },
  servers: [{ url: `http://127.0.0.1:${MOCK_API}` }],
  paths: {
    "/things/{id}": {
      get: {
        summary: "Get a thing by id",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: { "200": { description: "ok" } },
      },
    },
  },
};

let llmCalls = 0;
let failAll = false;

const groqServer = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    llmCalls++;
    const parsed = JSON.parse(body);
    const userContent: string =
      parsed.messages?.[parsed.messages.length - 1]?.content ?? "";
    const isRetry = userContent.includes("FAILED");
    const url =
      failAll || !isRetry
        ? `http://127.0.0.1:${MOCK_API}/things/wrong`
        : `http://127.0.0.1:${MOCK_API}/things/magic`;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        id: "cmpl-mock",
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: "mock",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: JSON.stringify({ method: "GET", url, headers: {} }) },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    );
  });
});

const apiServer = http.createServer((req, res) => {
  if (req.url === "/spec.json") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(spec));
    return;
  }
  const m = req.url?.match(/^\/things\/([^/?]+)/);
  if (m && m[1] === "magic") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ id: "magic", name: "the magic thing" }));
    return;
  }
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "not found" }));
});

async function main() {
  await new Promise<void>((r) => apiServer.listen(MOCK_API, "127.0.0.1", r));
  await new Promise<void>((r) => groqServer.listen(MOCK_GROQ, "127.0.0.1", r));

  const events: AgentEvent[] = [];
  await runAgent(
    `http://127.0.0.1:${MOCK_API}/spec.json`,
    "get the magic thing",
    (e) => events.push(e),
  );

  const summarize = () =>
    events.map((e) => e.type).join(" -> ");
  console.log("EVENT SEQUENCE:", summarize());

  const attemptEvents = events.filter((e) => e.type === "attempt");
  const results = events.filter((e) => e.type === "attempt_result");
  const final = events.find((e) => e.type === "final");
  console.log("llm calls:", llmCalls);
  console.log(
    "attempt 1:",
    results[0] && JSON.stringify({ success: results[0].success, statusCode: results[0].statusCode }),
  );
  console.log(
    "attempt 2:",
    results[1] && JSON.stringify({ success: results[1].success, statusCode: results[1].statusCode }),
  );
  console.log("final success:", final?.success === true);
  console.log("final response:", JSON.stringify((final as any)?.response));

  const ok =
    llmCalls === 2 &&
    attemptEvents.length === 2 &&
    results.length === 2 &&
    results[0]?.success === false &&
    results[0]?.statusCode === 404 &&
    results[1]?.success === true &&
    results[1]?.statusCode === 200 &&
    final?.success === true;
  console.log(ok ? "\nSCENARIO 1 PASS — self-correction loop works" : "\nSCENARIO 1 FAIL");

  events.length = 0;
  llmCalls = 0;
  failAll = true;

  await runAgent(
    `http://127.0.0.1:${MOCK_API}/spec.json`,
    "get the magic thing",
    (e) => events.push(e),
  );

  const results2 = events.filter((e) => e.type === "attempt_result");
  const final2 = events.find((e) => e.type === "final");
  const failedAttempts = (final2 as any)?.allAttempts;
  console.log("SCENARIO 2 — give up after 3");
  console.log("attempt_results:", results2.map((r) => r.statusCode ?? "?").join(", "));
  console.log("llm calls:", llmCalls);
  console.log("final success:", final2?.success === false);
  console.log("allAttempts in final:", failedAttempts?.length);

  const ok2 =
    llmCalls === 3 &&
    results2.length === 3 &&
    results2.every((r) => r.success === false) &&
    final2?.success === false &&
    failedAttempts?.length === 3;
  console.log(ok2 ? "SCENARIO 2 PASS — capped at 3 retries, history included" : "SCENARIO 2 FAIL");

  process.exit(ok && ok2 ? 0 : 1);
}

main().catch((err) => {
  console.error("TEST ERROR:", err);
  process.exit(1);
});
