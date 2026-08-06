"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentEvent, Attempt, LlmRequest } from "@/lib/types";

type LogLevel = "info" | "success" | "warn" | "error" | "request";

interface LogLine {
  id: number;
  level: LogLevel;
  text: string;
}

interface ResultState {
  success: boolean;
  response?: unknown;
  allAttempts: Attempt[];
  fatalError?: string;
}

const EXAMPLES = [
  {
    name: "PokeAPI",
    specUrl: "https://raw.githubusercontent.com/PokeAPI/pokeapi/master/openapi.yml",
    goal: "get pokemon named pikachu",
  },
  {
    name: "JSONPlaceholder",
    specUrl: "https://raw.githubusercontent.com/sebastienlevert/jsonplaceholder-api/main/openapi.yaml",
    goal: "create a new post with title 'hello selfheal' and body 'it works'",
  },
];

const LEVEL_COLORS: Record<LogLevel, string> = {
  info: "text-term-muted",
  success: "text-term-green",
  warn: "text-term-yellow",
  error: "text-term-red",
  request: "text-term-accent",
};

const LEVEL_TAG: Record<LogLevel, string> = {
  info: "·",
  success: "✔",
  warn: "●",
  error: "✘",
  request: "→",
};

function prettyRequest(request: LlmRequest): string {
  let line = `${request.method} ${request.url}`;
  if (request.headers && Object.keys(request.headers).length > 0) {
    const h = Object.entries(request.headers)
      .map(([k, v]) => `${k}: ${v}`)
      .join(" · ");
    line += `  [${h}]`;
  }
  return line;
}

export default function SelfHealConsole(): React.ReactElement {
  const [specUrl, setSpecUrl] = useState("");
  const [goal, setGoal] = useState("");
  const [running, setRunning] = useState(false);
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [result, setResult] = useState<ResultState | null>(null);
  const [specCount, setSpecCount] = useState<number | null>(null);

  const idRef = useRef(0);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [logs]);

  const appendLog = useCallback((level: LogLevel, text: string) => {
    setLogs((prev) => [...prev, { id: ++idRef.current, level, text }]);
  }, []);

  const handleEvent = useCallback(
    (evt: AgentEvent, onFinal: (r: ResultState) => void) => {
      switch (evt.type) {
        case "log":
          appendLog(evt.level ?? "info", evt.message);
          break;
        case "spec_loaded":
          setSpecCount(evt.endpointCount);
          appendLog("success", `spec loaded: "${evt.specTitle}" — ${evt.endpointCount} endpoints (base ${evt.baseUrl || "unknown"})`);
          break;
        case "llm_thinking":
          appendLog("warn", `[attempt ${evt.attemptNumber}] llm: planning request …`);
          break;
        case "attempt":
          appendLog("request", `[attempt ${evt.attemptNumber}] ${prettyRequest(evt.request)}`);
          if (evt.request.body !== undefined && evt.request.body !== null) {
            appendLog("request", `  body: ${JSON.stringify(evt.request.body)}`);
          }
          break;
        case "attempt_result":
          if (evt.success) {
            appendLog("success", `[attempt ${evt.attemptNumber}] ok — HTTP ${evt.statusCode ?? "?"}`);
          } else {
            appendLog("error", `[attempt ${evt.attemptNumber}] failed${evt.statusCode ? ` — HTTP ${evt.statusCode}` : ""}: ${evt.error ?? "unknown error"}`);
          }
          break;
        case "final":
          if (evt.success) {
            appendLog("success", "done — request succeeded");
            onFinal({ success: true, response: evt.response, allAttempts: evt.allAttempts });
          } else {
            appendLog("error", `done — gave up after ${evt.allAttempts.length} attempt${evt.allAttempts.length === 1 ? "" : "s"}`);
            onFinal({ success: false, allAttempts: evt.allAttempts });
          }
          break;
      }
    },
    [appendLog],
  );

  const run = async () => {
    if (running) return;
    const trimmedSpec = specUrl.trim();
    const trimmedGoal = goal.trim();
    if (!trimmedSpec || !trimmedGoal) {
      appendLog("error", "both a spec URL and a goal are required");
      return;
    }

    setRunning(true);
    setResult(null);
    setSpecCount(null);
    setLogs([]);
    idRef.current = 0;

    let sawFinal = false;
    const onFinal = (r: ResultState) => {
      sawFinal = true;
      setResult(r);
    };

    appendLog("info", "> connecting to /api/agent …");

    try {
      const res = await fetch("/api/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ specUrl: trimmedSpec, goal: trimmedGoal }),
      });

      if (!res.ok || !res.body) {
        let detail = `HTTP ${res.status}`;
        try {
          const data = (await res.json()) as { error?: string };
          if (data.error) detail += ` — ${data.error}`;
        } catch {
          // ignore
        }
        appendLog("error", `request to /api/agent failed: ${detail}`);
        setResult({ success: false, allAttempts: [], fatalError: detail });
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          let evt: AgentEvent;
          try {
            evt = JSON.parse(trimmed) as AgentEvent;
          } catch {
            continue;
          }
          handleEvent(evt, onFinal);
        }
      }
    } catch (err) {
      appendLog("error", `stream error: ${err instanceof Error ? err.message : String(err)}`);
      if (!sawFinal) setResult({ success: false, allAttempts: [] });
    } finally {
      setRunning(false);
    }
  };

  const fillExample = (index: number) => {
    if (running) return;
    const ex = EXAMPLES[index];
    setSpecUrl(ex.specUrl);
    setGoal(ex.goal);
  };

  return (
    <div className="flex min-h-screen flex-col">
      <header className="flex items-center justify-between border-b border-term-border px-6 py-4">
        <div className="flex items-baseline gap-3">
          <span className="text-lg text-term-green">&gt;_</span>
          <h1 className="text-lg font-bold tracking-[0.2em] text-term-text">SELFHEAL</h1>
          <span className="hidden text-sm text-term-muted sm:inline">self-correcting api agent</span>
        </div>
        <div className="text-xs text-term-muted">
          groq · openapi · public no-auth apis
        </div>
      </header>

      <main className="mx-auto w-full max-w-5xl flex-1 space-y-6 px-6 py-6">
        <section className="space-y-4">
          <div className="space-y-1">
            <label htmlFor="specUrl" className="block text-xs tracking-widest text-term-muted">
              OPENAPI SPEC URL
            </label>
            <input
              id="specUrl"
              type="url"
              value={specUrl}
              onChange={(e) => setSpecUrl(e.target.value)}
              placeholder="https://…/openapi.json"
              spellCheck={false}
              className="w-full rounded border border-term-border bg-term-panel px-3 py-2 text-sm text-term-text placeholder-term-muted outline-none transition-colors focus:border-term-accent"
            />
          </div>

          <div className="space-y-1">
            <label htmlFor="goal" className="block text-xs tracking-widest text-term-muted">
              GOAL
            </label>
            <input
              id="goal"
              type="text"
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              placeholder="e.g. get pokemon named pikachu"
              spellCheck={false}
              className="w-full rounded border border-term-border bg-term-panel px-3 py-2 text-sm text-term-text placeholder-term-muted outline-none transition-colors focus:border-term-accent"
            />
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <span className="text-xs tracking-widest text-term-muted">EXAMPLES</span>
            {EXAMPLES.map((ex, i) => (
              <button
                key={ex.name}
                type="button"
                onClick={() => fillExample(i)}
                disabled={running}
                className="rounded border border-term-border bg-term-panel px-3 py-1.5 text-xs text-term-accent transition-colors hover:border-term-accent hover:bg-term-panel disabled:cursor-not-allowed disabled:opacity-50"
              >
                {ex.name}
              </button>
            ))}
            <button
              type="button"
              onClick={() => run()}
              disabled={running}
              className="rounded bg-term-green px-5 py-1.5 text-xs font-bold tracking-widest text-term-bg transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {running ? "RUNNING…" : "RUN AGENT"}
            </button>
            {running && <span className="selfheal-cursor" aria-hidden="true" />}
          </div>
        </section>

        <section className="overflow-hidden rounded border border-term-border">
          <div className="flex items-center gap-2 border-b border-term-border bg-term-panel px-4 py-2">
            <span className="h-2.5 w-2.5 rounded-full bg-term-red/80" />
            <span className="h-2.5 w-2.5 rounded-full bg-term-yellow/80" />
            <span className="h-2.5 w-2.5 rounded-full bg-term-green/80" />
            <span className="ml-3 text-xs tracking-widest text-term-muted">agent.log</span>
            <span className="ml-auto text-xs text-term-muted">
              {specCount !== null ? `${specCount} endpoints · ` : ""}live stream
            </span>
          </div>
          <div
            ref={logRef}
            className="h-96 overflow-y-auto bg-term-panel/50 p-4 text-[13px] leading-relaxed"
          >
            {logs.length === 0 ? (
              <div className="text-term-muted">
                <span className="text-term-green"># </span>
                ready. pick an example or paste a spec URL + goal, then hit RUN AGENT.
              </div>
            ) : (
              logs.map((line) => (
                <div key={line.id} className={`whitespace-pre-wrap break-all ${LEVEL_COLORS[line.level]}`}>
                  <span className="mr-2 inline-block w-3 text-term-muted">{LEVEL_TAG[line.level]}</span>
                  {line.text}
                </div>
              ))
            )}
          </div>
        </section>

        <section className="overflow-hidden rounded border border-term-border">
          <div className="flex items-center gap-2 border-b border-term-border bg-term-panel px-4 py-2">
            <span className="text-xs tracking-widest text-term-muted">RESULT</span>
            <span className="ml-auto text-xs text-term-muted">response</span>
          </div>
          <div className="max-h-96 overflow-y-auto bg-term-panel/50 p-4">
            {result === null ? (
              <div className="text-term-muted">no run yet — press RUN AGENT to see the response here.</div>
            ) : result.success ? (
              <div>
                <div className="mb-3 text-xs font-bold tracking-widest text-term-green">
                  SUCCESS — the agent&apos;s request went through
                </div>
                <pre className="whitespace-pre-wrap break-all text-[13px] leading-relaxed text-term-text">
                  {JSON.stringify(result.response, null, 2)}
                </pre>
              </div>
            ) : (
              <div>
                <div className="mb-3 text-xs font-bold tracking-widest text-term-red">
                  FAILED AFTER {result.allAttempts.length} ATTEMPT{result.allAttempts.length === 1 ? "" : "S"}
                  {result.fatalError ? ` — ${result.fatalError}` : ""}
                </div>
                {result.allAttempts.length === 0 ? (
                  <div className="text-term-muted">no attempts were made (see agent.log).</div>
                ) : (
                  <div className="space-y-3">
                    {result.allAttempts.map((a) => (
                      <div key={a.attemptNumber} className="rounded border border-term-border p-3">
                        <div className="mb-1 text-xs font-bold text-term-yellow">attempt {a.attemptNumber}</div>
                        {a.request && (
                          <div className="text-[13px] text-term-accent">{prettyRequest(a.request)}</div>
                        )}
                        {a.request?.body !== undefined && a.request.body !== null && (
                          <div className="text-[13px] text-term-muted">
                            body: {JSON.stringify(a.request.body)}
                          </div>
                        )}
                        <div className="mt-1 text-[13px] text-term-red">
                          {a.statusCode ? `HTTP ${a.statusCode} — ` : ""}
                          {a.error ?? "failed"}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </section>
      </main>

      <footer className="border-t border-term-border px-6 py-4 text-center text-xs text-term-muted">
        selfheal — llm plans · executes · self-corrects (max 3 retries)
      </footer>
    </div>
  );
}
