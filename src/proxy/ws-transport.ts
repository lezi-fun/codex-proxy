/**
 * WebSocket transport for the Codex Responses API.
 *
 * Opens a WebSocket to the backend, sends a `response.create` message,
 * and wraps incoming JSON messages into an SSE-formatted ReadableStream.
 * This lets parseStream() and all downstream consumers work identically
 * regardless of whether HTTP SSE or WebSocket was used.
 *
 * Used when `previous_response_id` is present — HTTP SSE does not support it.
 */

import WebSocket from "ws";
import { HttpsProxyAgent } from "https-proxy-agent";
import type { CodexInputItem } from "./codex-api.js";

/** Flat WebSocket message format expected by the Codex backend. */
export interface WsCreateRequest {
  type: "response.create";
  model: string;
  instructions: string;
  input: CodexInputItem[];
  previous_response_id?: string;
  reasoning?: { effort?: string; summary?: string };
  tools?: unknown[];
  tool_choice?: string | { type: string; name: string };
  text?: {
    format: {
      type: "text" | "json_object" | "json_schema";
      name?: string;
      schema?: Record<string, unknown>;
      strict?: boolean;
    };
  };
  // NOTE: `store` and `stream` are intentionally omitted.
  // The backend defaults to storing via WebSocket and always streams.
}

/**
 * Open a WebSocket to the Codex backend, send `response.create`,
 * and return a Response whose body is an SSE-formatted ReadableStream.
 *
 * The SSE format matches what parseStream() expects:
 *   event: <type>\ndata: <json>\n\n
 */
export function createWebSocketResponse(
  wsUrl: string,
  headers: Record<string, string>,
  request: WsCreateRequest,
  signal?: AbortSignal,
  proxyUrl?: string | null,
): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Aborted before WebSocket connect"));
      return;
    }

    const wsOpts: WebSocket.ClientOptions = { headers };
    if (proxyUrl) {
      wsOpts.agent = new HttpsProxyAgent(proxyUrl);
    }
    const ws = new WebSocket(wsUrl, wsOpts);
    const encoder = new TextEncoder();
    let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
    let streamClosed = false;
    let connected = false;

    function closeStream() {
      if (!streamClosed && controller) {
        streamClosed = true;
        try { controller.close(); } catch { /* already closed */ }
      }
    }

    function errorStream(err: Error) {
      if (!streamClosed && controller) {
        streamClosed = true;
        try { controller.error(err); } catch { /* already closed */ }
      }
    }

    // Abort signal handling
    const onAbort = () => {
      ws.close(1000, "aborted");
      if (!connected) {
        reject(new Error("Aborted during WebSocket connect"));
      }
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
      },
      cancel() {
        ws.close(1000, "stream cancelled");
      },
    });

    ws.on("open", () => {
      connected = true;
      ws.send(JSON.stringify(request));

      // Return the Response immediately — events will flow into the stream
      const responseHeaders = new Headers({ "content-type": "text/event-stream" });
      resolve(new Response(stream, { status: 200, headers: responseHeaders }));
    });

    ws.on("message", (data: Buffer | string) => {
      if (streamClosed) return;
      const raw = typeof data === "string" ? data : data.toString("utf-8");

      try {
        const msg = JSON.parse(raw) as Record<string, unknown>;
        const type = (msg.type as string) ?? "unknown";

        // Re-encode as SSE: event: <type>\ndata: <full json>\n\n
        const sse = `event: ${type}\ndata: ${raw}\n\n`;
        controller!.enqueue(encoder.encode(sse));

        // Close stream after response.completed, response.failed, or error
        if (type === "response.completed" || type === "response.failed" || type === "error") {
          // Let the SSE chunk flush, then close
          queueMicrotask(() => {
            closeStream();
            ws.close(1000);
          });
        }
      } catch {
        // Non-JSON message — emit as raw data
        const sse = `data: ${raw}\n\n`;
        controller!.enqueue(encoder.encode(sse));
      }
    });

    ws.on("error", (err: Error) => {
      signal?.removeEventListener("abort", onAbort);
      if (!connected) {
        reject(err);
      } else {
        errorStream(err);
      }
    });

    ws.on("close", (_code: number, _reason: Buffer) => {
      signal?.removeEventListener("abort", onAbort);
      closeStream();
    });
  });
}
