/**
 * Native transport — uses a Rust addon (reqwest + rustls) for HTTP requests.
 *
 * TLS fingerprint matches the real Codex Desktop (codex-rs binary) exactly:
 * reqwest 0.12.28 + hyper-rustls 0.27.7 + rustls 0.23.36.
 *
 * This avoids the Chrome TLS / Codex Desktop UA mismatch that
 * curl-impersonate introduced.
 */

import { resolve } from "path";
import { existsSync } from "fs";
import type { TlsTransport, TlsTransportResponse } from "./transport.js";
import { getProxyUrl } from "./curl-binary.js";

interface NativeGetResponse {
  status: number;
  body: string;
  setCookieHeaders: string[];
}

interface NativePostResponse {
  status: number;
  body: string;
}

interface NativeStreamMeta {
  status: number;
  headers: Record<string, string>;
  setCookieHeaders: string[];
}

interface NativeBindings {
  httpGet(
    url: string,
    headers: Record<string, string>,
    timeoutSec?: number | null,
    proxyUrl?: string | null,
  ): Promise<NativeGetResponse>;
  httpPost(
    url: string,
    headers: Record<string, string>,
    body: string,
    timeoutSec?: number | null,
    proxyUrl?: string | null,
  ): Promise<NativePostResponse>;
  httpPostStream(
    url: string,
    headers: Record<string, string>,
    body: string,
    onChunk: (chunk: Buffer | null) => void,
    proxyUrl?: string | null,
  ): Promise<NativeStreamMeta>;
}

/** Resolve the effective proxy URL for a request. */
function resolveProxy(proxyUrl: string | null | undefined): string | null {
  if (proxyUrl === null) return null; // explicit direct
  if (proxyUrl !== undefined) return proxyUrl; // explicit proxy
  return getProxyUrl(); // global default
}

export class NativeTransport implements TlsTransport {
  private bindings: NativeBindings;

  constructor(bindings: NativeBindings) {
    this.bindings = bindings;
  }

  isImpersonate(): boolean {
    return false; // rustls, not Chrome
  }

  async post(
    url: string,
    headers: Record<string, string>,
    body: string,
    signal?: AbortSignal,
    _timeoutSec?: number,
    proxyUrl?: string | null,
  ): Promise<TlsTransportResponse> {
    if (signal?.aborted) {
      throw new Error("Request aborted");
    }

    const proxy = resolveProxy(proxyUrl);

    // Set up a ReadableStream that receives chunks from the Rust callback
    let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;
    const readable = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
      },
      cancel() {
        streamController = null;
      },
    });

    const onChunk = (chunk: Buffer | null): void => {
      if (!streamController) return;
      if (chunk === null) {
        // End of stream
        try { streamController.close(); } catch { /* already closed */ }
        streamController = null;
      } else {
        try { streamController.enqueue(new Uint8Array(chunk)); } catch { /* closed */ }
      }
    };

    const meta = await this.bindings.httpPostStream(
      url,
      headers,
      body,
      onChunk,
      proxy,
    );

    // Handle abort signal
    if (signal) {
      const onAbort = (): void => {
        if (streamController) {
          try { streamController.close(); } catch { /* already closed */ }
          streamController = null;
        }
      };
      signal.addEventListener("abort", onAbort, { once: true });
    }

    // Convert flat headers to Web Headers object
    const responseHeaders = new Headers();
    for (const [key, value] of Object.entries(meta.headers)) {
      // Skip set-cookie from main headers (handled separately)
      if (key.toLowerCase() === "set-cookie") continue;
      responseHeaders.append(key, value);
    }

    return {
      status: meta.status,
      headers: responseHeaders,
      body: readable,
      setCookieHeaders: meta.setCookieHeaders,
    };
  }

  async get(
    url: string,
    headers: Record<string, string>,
    timeoutSec?: number,
    proxyUrl?: string | null,
  ): Promise<{ status: number; body: string }> {
    const proxy = resolveProxy(proxyUrl);
    const result = await this.bindings.httpGet(url, headers, timeoutSec, proxy);
    return { status: result.status, body: result.body };
  }

  async getWithCookies(
    url: string,
    headers: Record<string, string>,
    timeoutSec?: number,
    proxyUrl?: string | null,
  ): Promise<{ status: number; body: string; setCookieHeaders: string[] }> {
    const proxy = resolveProxy(proxyUrl);
    return this.bindings.httpGet(url, headers, timeoutSec, proxy);
  }

  async simplePost(
    url: string,
    headers: Record<string, string>,
    body: string,
    timeoutSec?: number,
    proxyUrl?: string | null,
  ): Promise<{ status: number; body: string }> {
    const proxy = resolveProxy(proxyUrl);
    return this.bindings.httpPost(url, headers, body, timeoutSec, proxy);
  }
}

/** Check if the native addon is available for the current platform. */
export function isNativeAvailable(): boolean {
  const nativeDir = resolve(import.meta.dirname ?? __dirname, "../../native");
  // napi-rs generated loader checks for platform-specific .node files
  const loaderPath = resolve(nativeDir, "index.js");
  return existsSync(loaderPath);
}

/** Create a NativeTransport instance. Throws if the addon is not available. */
export async function createNativeTransport(): Promise<NativeTransport> {
  const nativeDir = resolve(import.meta.dirname ?? __dirname, "../../native");
  const loaderPath = resolve(nativeDir, "index.js");

  if (!existsSync(loaderPath)) {
    throw new Error(`Native addon not found at ${loaderPath}. Run 'cd native && npm run build' first.`);
  }

  // Dynamic import of the CJS loader generated by napi-rs
  const { createRequire } = await import("module");
  const require = createRequire(import.meta.url);
  const bindings = require(loaderPath) as NativeBindings;

  if (!bindings.httpGet || !bindings.httpPost || !bindings.httpPostStream) {
    throw new Error("Native addon loaded but missing expected exports (httpGet, httpPost, httpPostStream)");
  }

  return new NativeTransport(bindings);
}
