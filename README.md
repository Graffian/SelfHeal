# SelfHeal — A Self-Correcting API Agent

SelfHeal is a single-page Next.js (App Router, TypeScript) app that turns a
**plain-English goal** into a **real HTTP request** against any public, no-auth
API described by an **OpenAPI / Swagger spec** — and if the request fails, it
**feeds the error back to an LLM and retries**, up to 3 times, streaming every
attempt live to a terminal-style UI.

It never guesses blindly. It reads the actual spec, picks the best matching
endpoint, executes the request for real, and *heals itself* when it gets it
wrong.

---

## What it looks like

```
❯ SELFHEAL — self-correcting api agent

  OPENAPI SPEC URL  [https://raw.githubusercontent.com/PokeAPI/pokeapi/master/openapi.yml]
  GOAL              [get pokemon named pikachu]

  [PokeAPI] [JSONPlaceholder]      [RUN AGENT]

  ┌─ agent.log ────────────────────────────────────────────┐
  │  ✔ spec loaded: "PokéAPI" — 100 endpoints (https://pokeapi.co)
  │  ● [attempt 1] llm: planning request …
  │  → [attempt 1] GET https://pokeapi.co/api/v2/pokemon/pikachu
  │  ✔ [attempt 1] ok — HTTP 200
  │  ✔ done — request succeeded
  └─────────────────────────────────────────────────────────┘
```

## How it works

```
  User goal + spec URL
        │
        ▼
  Fetch & parse OpenAPI spec ──── JSON or YAML, OpenAPI 3.x / Swagger 2.0
        │
        ▼
  LLM plans a request   ──────── "pick the best endpoint, output ONLY JSON"
        │                                { method, url, headers, body }
        ▼
  Execute the real HTTP request  ──────── fixed fetch() call, nothing else
        │
        ├── 2xx  ────────────────►  stream { final, success: true, response }
        │
        └── 4xx / 5xx / network error
                 │
                 ▼
        Feed the failure back to the LLM:
        "Your previous attempt: {request}. It failed with: {error}.
         Fix the request and output corrected JSON only."
                 │
                 ▼
        Retry  ─────►  hard cap at 3 total attempts, then give up
```

### Key design decisions

- **The LLM never executes code.** It can only emit a structured JSON object
  (`method` / `url` / `headers` / `body`). Your server-side `fetch()` is the only
  thing that ever touches the network, and the URL is validated to be http(s)
  before execution. No `eval`, no `exec`, no arbitrary code path.
- **Spec is summarized, not dumped.** Every endpoint is reduced to a compact line
  (`GET /api/v2/pokemon/{id}` + path/query params + request body schema), keeping
  the prompt small even for 100+ endpoint APIs.
- **Self-correction is the point.** The corrective prompt includes the exact
  request that was tried, the exact error (status code + response body), and the
  endpoint list — so the model can diagnose and repair its own mistake.
- **Everything streams.** The API route returns an NDJSON stream (`/api/agent`);
  the UI renders each event the moment it happens. No "wait and dump".

### Streaming event shape (`POST /api/agent` → `application/x-ndjson`)

```jsonc
{ "type": "log",            "message": "...", "level": "info" }
{ "type": "spec_loaded",    "specTitle": "PokéAPI", "endpointCount": 100, "baseUrl": "https://pokeapi.co" }
{ "type": "llm_thinking",   "attemptNumber": 1 }
{ "type": "attempt",        "attemptNumber": 1, "request": { "method": "GET", "url": "…", "headers": {} } }
{ "type": "attempt_result", "attemptNumber": 1, "success": false, "statusCode": 404, "error": "HTTP 404 — …" }
{ "type": "final",          "success": true, "response": { … } }
// or
{ "type": "final",          "success": false, "allAttempts": [ … ] }
```

---

## Tech stack

- **Next.js 16 (App Router) + TypeScript**
- **Tailwind CSS v4** — dark, terminal/monospace dev-tool aesthetic
- **`groq-sdk`** — Groq's official TypeScript SDK, model
  `llama-3.3-70b-versatile` (configurable)
- **`yaml`** — so the spec fetcher accepts both JSON and YAML OpenAPI files
- No database — everything is in-memory for a single request lifecycle

## Getting started

```bash
# 1. clone & install
npm install

# 2. add your Groq key (free at https://console.groq.com/keys)
cp .env.example .env.local
#    edit .env.local and set GROQ_API_KEY=your_key

# 3. run
npm run dev
# open http://localhost:3000
```

### Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `GROQ_API_KEY` | — | **Required.** Groq API key. |
| `GROQ_MODEL` | `llama-3.3-70b-versatile` | Override the LLM. |
| `GROQ_BASE_URL` | `https://api.groq.com/openai/v1` | Override the API base URL (testing/proxies). |
| `REQUEST_TIMEOUT_MS` | `20000` | Timeout for the real API call. |

> **Note on the default model:** Groq deprecated `llama-3.3-70b-versatile`
> (shutdown 2026-08-16) and recommends `openai/gpt-oss-120b` or
> `openai/gpt-oss-20b`. Set `GROQ_MODEL` to your preferred current model.

## Trying it out

Pick an example button, or paste any public no-auth OpenAPI spec URL:

- **PokeAPI** — `https://raw.githubusercontent.com/PokeAPI/pokeapi/master/openapi.yml`
  → *"get pokemon named pikachu"*
- **JSONPlaceholder** — `https://raw.githubusercontent.com/sebastienlevert/jsonplaceholder-api/main/openapi.yaml`
  → *"create a new post with title 'hello selfheal'"*

A good way to *watch* the self-correction loop is to ask for something
deliberately fiddly (a wrong-but-plausible ID, a param the spec spells
differently) and watch the agent miss, read the error, and fix itself.

## Project structure

```
app/
  page.tsx                  # single page (server component)
  layout.tsx, globals.css   # dark terminal theme
  api/agent/route.ts        # POST → streams NDJSON attempt updates
components/
  SelfHealConsole.tsx       # client UI: inputs, log panel, result panel
lib/
  types.ts                  # shared event / attempt types
  openapi.ts                # fetch, parse (JSON+YAML), summarize specs
  groq.ts                   # Groq client wrapper
  agent.ts                  # the self-correcting loop (plan → execute → retry ×3)
scripts/
  e2e-test.ts               # mock-spec + mock-Groq test proving the loop
```

## Running the tests

The mock-based end-to-end test spins up a fake spec server, a fake API (that
404s the "wrong" request and 200s the corrected one) and a fake Groq server,
then proves both the **self-correction** path and the **give-up-after-3** path:

```bash
GROQ_API_KEY=test GROQ_BASE_URL=http://127.0.0.1:4568/v1 npx tsx scripts/e2e-test.ts
```

## Roadmap / possible extensions

- Pluggable executors (Postman-style saved collections, Webhooks, GraphQL)
- Persistent attempt history / session replay
- Refactor the LLM planner into an OpenAI-tool-calling / strict-JSON-schema call
  so malformed outputs are structurally impossible
