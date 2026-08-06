import { runAgent } from "@/lib/agent";
import type { AgentEvent } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 300;

const encoder = new TextEncoder();

export async function POST(request: Request): Promise<Response> {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return jsonError("invalid JSON body", 400);
  }

  const { specUrl, goal } = (payload ?? {}) as { specUrl?: unknown; goal?: unknown };
  if (typeof specUrl !== "string" || specUrl.trim() === "") {
    return jsonError("specUrl is required", 400);
  }
  if (typeof goal !== "string" || goal.trim() === "") {
    return jsonError("goal is required", 400);
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (event: AgentEvent): void => {
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        } catch {
          // client disconnected — ignore
        }
      };

      try {
        await runAgent(specUrl.trim(), goal.trim(), emit);
      } catch (err) {
        emit({
          type: "log",
          message: `fatal error: ${err instanceof Error ? err.message : String(err)}`,
          level: "error",
        });
        emit({ type: "final", success: false, allAttempts: [] });
      } finally {
        try {
          controller.close();
        } catch {
          // already closed
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}

function jsonError(message: string, status: number): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
