import { parse as parseYaml } from "yaml";

export interface EndpointParam {
  name: string;
  in: "path" | "query" | "header";
  required: boolean;
  type: string;
}

export interface Endpoint {
  method: string;
  path: string;
  summary: string;
  params: EndpointParam[];
  hasBody: boolean;
  bodySchema: string;
}

export interface ParsedSpec {
  title: string;
  version?: string;
  baseUrl: string;
  endpoints: Endpoint[];
}

const HTTP_METHODS = ["get", "post", "put", "patch", "delete", "head", "options"] as const;
const MAX_BODY_PROPS = 25;

export function assertHttpUrl(url: string, label: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`${label} is not a valid URL: ${truncate(url, 120)}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${label} uses unsupported protocol "${parsed.protocol}" (only http/https)`);
  }
  return parsed;
}

export async function fetchWithTimeout(
  url: string,
  timeoutMs: number,
  init?: RequestInit,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`request to ${url} timed out after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchAndParseSpec(url: string): Promise<ParsedSpec> {
  assertHttpUrl(url, "spec URL");

  let res: Response;
  try {
    res = await fetchWithTimeout(url, 15_000, {
      headers: {
        Accept: "application/json, application/yaml, text/yaml, text/plain, */*",
        "User-Agent": "SelfHeal/0.1 (self-correcting api agent)",
      },
      redirect: "follow",
    });
  } catch (err) {
    throw new Error(`could not fetch spec: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!res.ok) {
    throw new Error(`spec fetch failed with HTTP ${res.status} ${res.statusText}`);
  }

  const text = await res.text();
  if (!text.trim()) throw new Error("spec is empty");

  let spec: unknown;
  const contentType = res.headers.get("content-type") ?? "";
  try {
    if (contentType.includes("json") || text.trimStart().startsWith("{")) {
      spec = JSON.parse(text);
    } else {
      spec = parseYaml(text) as unknown;
    }
  } catch (err) {
    throw new Error(
      `could not parse spec as JSON or YAML: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return parseSpec(spec);
}

export function parseSpec(spec: unknown): ParsedSpec {
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) {
    throw new Error("spec is not an object");
  }
  const obj = spec as Record<string, unknown>;

  const isOpenApi = typeof obj.openapi === "string" && obj.openapi.startsWith("3");
  const isSwagger2 = typeof obj.swagger === "string" && obj.swagger.startsWith("2");
  if (!isOpenApi && !isSwagger2) {
    throw new Error("unrecognized format — expected an OpenAPI 3.x or Swagger 2.0 spec");
  }

  const info = (obj.info ?? {}) as Record<string, unknown>;
  const title = typeof info.title === "string" ? info.title : "Untitled API";
  const version = typeof info.version === "string" ? info.version : undefined;

  const endpoints = isOpenApi
    ? extractOpenApi3(obj)
    : extractSwagger2(obj);
  if (endpoints.length === 0) {
    throw new Error("no endpoints found in spec");
  }

  return {
    title,
    version,
    baseUrl: isOpenApi ? resolveBaseUrlOpenApi3(obj) : resolveBaseUrlSwagger2(obj),
    endpoints,
  };
}

function resolveBaseUrlOpenApi3(spec: Record<string, unknown>): string {
  const servers = Array.isArray(spec.servers) ? (spec.servers as Array<Record<string, unknown>>) : [];
  if (servers.length === 0) return "";
  const server = servers[0] ?? {};
  let url = typeof server.url === "string" ? server.url : "";
  const variables = (server.variables ?? {}) as Record<string, Record<string, unknown>>;
  url = url.replace(/\{([^}]+)\}/g, (_match, name: string) => {
    const v = variables[name];
    return (v && typeof v.default === "string" ? v.default : "") ?? "";
  });
  return url.replace(/\/+$/, "");
}

function resolveBaseUrlSwagger2(spec: Record<string, unknown>): string {
  const schemes = Array.isArray(spec.schemes) ? (spec.schemes as string[]) : [];
  const scheme = schemes[0] ?? "https";
  const host = typeof spec.host === "string" ? spec.host : "";
  const basePath = typeof spec.basePath === "string" ? spec.basePath.replace(/\/+$/, "") : "";
  if (host) {
    return `${scheme}://${host}${basePath}`;
  }
  return basePath;
}

function resolveRef(value: unknown, spec: Record<string, unknown>): unknown {
  let current = value;
  let depth = 0;
  while (current && typeof current === "object" && !Array.isArray(current)) {
    const ref = (current as Record<string, unknown>).$ref;
    if (typeof ref !== "string") break;
    if (!ref.startsWith("#/")) break;
    const parts = ref.slice(2).split("/");
    const root = parts[0] === "components" ? (spec.components as Record<string, unknown> | undefined) : spec;
    let cursor: unknown = root;
    for (const part of parts.slice(1)) {
      if (!cursor || typeof cursor !== "object") {
        cursor = undefined;
        break;
      }
      cursor = (cursor as Record<string, unknown>)[part];
    }
    if (cursor === undefined) return undefined;
    current = cursor;
    if (++depth > 8) break;
  }
  return current;
}

function resolveParam(p: unknown, spec: Record<string, unknown>): EndpointParam | null {
  const resolved = resolveRef(p, spec);
  if (!resolved || typeof resolved !== "object" || Array.isArray(resolved)) return null;
  const param = resolved as Record<string, unknown>;
  const inLoc = param.in;
  if (inLoc !== "path" && inLoc !== "query" && inLoc !== "header") return null;
  const schema = resolveRef(param.schema, spec) as Record<string, unknown> | undefined;
  return {
    name: typeof param.name === "string" ? param.name : "?",
    in: inLoc,
    required: Boolean(param.required),
    type: (schema?.type ?? param.type ?? "any") as string,
  };
}

function extractOpenApi3(spec: Record<string, unknown>): Endpoint[] {
  const endpoints: Endpoint[] = [];
  const paths = (spec.paths ?? {}) as Record<string, unknown>;
  for (const [path, pathItemValue] of Object.entries(paths)) {
    if (!pathItemValue || typeof pathItemValue !== "object" || Array.isArray(pathItemValue)) continue;
    const pathItem = pathItemValue as Record<string, unknown>;
    const sharedParams = Array.isArray(pathItem.parameters)
      ? (pathItem.parameters as unknown[])
          .map((p) => resolveParam(p, spec))
          .filter((p): p is EndpointParam => p !== null)
      : [];

    for (const method of HTTP_METHODS) {
      const op = pathItem[method];
      if (!op || typeof op !== "object" || Array.isArray(op)) continue;
      const operation = op as Record<string, unknown>;
      const opParams = Array.isArray(operation.parameters)
        ? (operation.parameters as unknown[])
            .map((p) => resolveParam(p, spec))
            .filter((p): p is EndpointParam => p !== null)
        : [];
      const params = [...sharedParams, ...opParams];

      let hasBody = false;
      let bodySchema = "";
      const requestBody = resolveRef(operation.requestBody, spec) as Record<string, unknown> | undefined;
      if (requestBody && typeof requestBody === "object") {
        hasBody = true;
        const content = (requestBody.content ?? {}) as Record<string, unknown>;
        const jsonContent = content["application/json"] ?? content[Object.keys(content)[0] ?? ""];
        const schema =
          jsonContent && typeof jsonContent === "object"
            ? (jsonContent as Record<string, unknown>).schema
            : undefined;
        if (schema) bodySchema = compactSchema(schema, spec);
      }

      endpoints.push({
        method: method.toUpperCase(),
        path,
        summary: truncate(
          (typeof operation.summary === "string" ? operation.summary : "") ||
            (typeof operation.description === "string" ? operation.description : ""),
          160,
        ),
        params,
        hasBody,
        bodySchema,
      });
    }
  }
  return endpoints;
}

function extractSwagger2(spec: Record<string, unknown>): Endpoint[] {
  const endpoints: Endpoint[] = [];
  const paths = (spec.paths ?? {}) as Record<string, unknown>;
  for (const [path, pathItemValue] of Object.entries(paths)) {
    if (!pathItemValue || typeof pathItemValue !== "object" || Array.isArray(pathItemValue)) continue;
    const pathItem = pathItemValue as Record<string, unknown>;
    for (const method of HTTP_METHODS) {
      const op = pathItem[method];
      if (!op || typeof op !== "object" || Array.isArray(op)) continue;
      const operation = op as Record<string, unknown>;
      const rawParams = Array.isArray(operation.parameters)
        ? (operation.parameters as unknown[]).map((p) => resolveRef(p, spec))
        : [];

      const params: EndpointParam[] = [];
      let hasBody = false;
      let bodySchema = "";
      for (const raw of rawParams) {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
        const param = raw as Record<string, unknown>;
        const inLoc = param.in;
        if (inLoc === "body") {
          hasBody = true;
          const schema = param.schema;
          if (schema) bodySchema = compactSchema(schema, spec);
          continue;
        }
        if (inLoc !== "path" && inLoc !== "query" && inLoc !== "header") continue;
        params.push({
          name: typeof param.name === "string" ? param.name : "?",
          in: inLoc,
          required: Boolean(param.required),
          type: (param.type ?? "any") as string,
        });
      }

      endpoints.push({
        method: method.toUpperCase(),
        path,
        summary: truncate(
          (typeof operation.summary === "string" ? operation.summary : "") ||
            (typeof operation.description === "string" ? operation.description : ""),
          160,
        ),
        params,
        hasBody,
        bodySchema,
      });
    }
  }
  return endpoints;
}

function compactSchema(
  schema: unknown,
  spec: Record<string, unknown>,
  depth = 0,
  seen = new Set<string>(),
): string {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return "any";
  let current = schema as Record<string, unknown>;

  const refKey = typeof current.$ref === "string" ? current.$ref : "";
  if (refKey) {
    if (seen.has(refKey)) return "(circular ref)";
    const resolved = resolveRef(current, spec);
    if (!resolved || typeof resolved !== "object") return `ref:${refKey}`;
    const nextSeen = new Set(seen);
    nextSeen.add(refKey);
    return compactSchema(resolved, spec, depth, nextSeen);
  }
  if (depth > 3) return "…";

  if (current.type === "array") {
    return `array<${compactSchema(current.items, spec, depth + 1, seen)}>`;
  }
  if (current.oneOf || current.anyOf) {
    const options = (current.oneOf ?? current.anyOf) as unknown[];
    return options
      .slice(0, 6)
      .map((o) => compactSchema(o, spec, depth + 1, seen))
      .join(" | ");
  }
  if (current.enum) {
    return `enum[${(current.enum as unknown[]).join(", ")}]`;
  }
  if (current.properties) {
    const props = Object.entries(current.properties as Record<string, unknown>);
    const required = Array.isArray(current.required) ? (current.required as unknown[]) : [];
    const parts = props.slice(0, MAX_BODY_PROPS).map(([k, v]) => {
      const inner = compactSchema(v, spec, depth + 1, seen) || "any";
      return `${k}${required.includes(k) ? "*" : ""}:${inner}`;
    });
    const overflow = props.length > MAX_BODY_PROPS ? ", …" : "";
    return `{ ${parts.join(", ")}${overflow} }`;
  }
  return (current.type ?? "any") as string;
}

const STOPWORDS = new Set([
  "get", "list", "fetch", "show", "find", "search", "query", "create", "make",
  "add", "new", "delete", "update", "remove", "all", "the", "a", "an", "of",
  "for", "and", "to", "in", "on", "at", "with", "from", "by", "me", "my", "i",
  "please", "want", "need", "give", "return", "named", "called", "first", "last",
  "number", "total", "count", "up", "down", "one", "two", "three", "how", "what",
  "which", "that", "this", "is", "are", "be", "do", "does", "using", "use",
  "info", "information", "about", "into", "out",
]);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2 && !/^[0-9]+$/.test(t) && !STOPWORDS.has(t));
}

export function rankEndpointsByRelevance(endpoints: Endpoint[], goal: string): Endpoint[] {
  const keywords = tokenize(goal);
  if (keywords.length === 0) return [...endpoints];
  const keySet = new Set(keywords);

  const scored = endpoints.map((endpoint, index) => {
    const pathSegments = endpoint.path.split("/").filter(Boolean);
    const docText = [endpoint.summary, endpoint.bodySchema, ...endpoint.params.map((p) => p.name)].join(" ");
    const docTokens = tokenize(docText);

    let score = 0;
    for (const keyword of keySet) {
      let bestPathWeight = 0;
      pathSegments.forEach((segment, i) => {
        const segTokens = tokenize(segment);
        if (segTokens.some((t) => t.startsWith(keyword) || keyword.startsWith(t))) {
          bestPathWeight = Math.max(bestPathWeight, 1 / (i + 1));
        }
      });
      if (bestPathWeight > 0) score += 10 * bestPathWeight;
      if (docTokens.some((t) => t.startsWith(keyword) || keyword.startsWith(t))) score += 1;
    }
    return { endpoint, score, index };
  });

  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  return scored.map((s) => s.endpoint);
}

export function selectEndpointsForLlm(parsed: ParsedSpec, goal: string, limit = 15): Endpoint[] {
  if (parsed.endpoints.length <= limit) return parsed.endpoints;
  return rankEndpointsByRelevance(parsed.endpoints, goal).slice(0, limit);
}

export function summarizeForLlm(parsed: ParsedSpec, options?: { total?: number }): string {
  const lines: string[] = [];
  lines.push(`API: ${parsed.title}${parsed.version ? ` (v${parsed.version})` : ""}`);
  lines.push(
    `BASE URL: ${parsed.baseUrl || "not declared in the spec — URLs must be absolute and inferred from common knowledge"}`,
  );
  lines.push("");
  const total = options?.total && options.total > parsed.endpoints.length ? ` of ${options.total}` : "";
  lines.push(`ENDPOINTS (${parsed.endpoints.length}${total} — most relevant to the goal):`);
  parsed.endpoints.forEach((e, i) => {
    lines.push(`${i + 1}. ${e.method} ${e.path}${e.summary ? ` — ${e.summary}` : ""}`);
    const pathParams = e.params.filter((p) => p.in === "path");
    const queryParams = e.params.filter((p) => p.in === "query");
    if (pathParams.length) {
      lines.push(
        `   path params: ${pathParams.map((p) => `${p.name}${p.required ? "*" : "?"}:${p.type}`).join(", ")}`,
      );
    }
    if (queryParams.length) {
      lines.push(
        `   query params: ${queryParams.map((p) => `${p.name}${p.required ? "*" : "?"}:${p.type}`).join(", ")}`,
      );
    }
    if (e.hasBody) {
      lines.push(`   body: ${e.bodySchema || "required JSON body (schema unknown)"}`);
    }
  });
  return lines.join("\n");
}

export function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}
