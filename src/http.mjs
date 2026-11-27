import { randomUUID } from "node:crypto";

import {
  DESKTOP_ARCH,
  DESKTOP_APP_MODE,
  DESKTOP_BUILD,
  DESKTOP_CHANNEL,
  DESKTOP_PLATFORM,
  DESKTOP_RELEASE,
  DESKTOP_USER_AGENT,
  DESKTOP_VERSION,
  MAX_JSON_BYTES,
} from "./constants.mjs";
import { parseErrorBody } from "./util.mjs";

export class HttpError extends Error {
  constructor({ op, status, body = "", contentType = "" }) {
    const info = parseErrorBody(body);
    super(
      `${op || "request"} -> HTTP ${status}${info.message ? `: ${info.message}` : ""}`,
    );
    this.name = "HttpError";
    this.op = op;
    this.status = status;
    this.body = body;
    this.contentType = contentType;
    this.code = info.code;
    this.upstream = info;
  }
}

export function desktopHeaders(bearer = "") {
  const headers = {
    "User-Agent": DESKTOP_USER_AGENT,
    Accept: "application/json",
    "X-Request-Id": randomUUID(),
    "X-QwenWork-Version": DESKTOP_VERSION,
    "X-QwenWork-Release-Version": DESKTOP_RELEASE,
    "X-QwenWork-Build": DESKTOP_BUILD,
    "X-QwenWork-Platform": DESKTOP_PLATFORM,
    "X-QwenWork-Arch": DESKTOP_ARCH,
    "X-QwenWork-Channel": DESKTOP_CHANNEL,
    "X-QwenWork-App-Mode": DESKTOP_APP_MODE,
  };
  const token = String(bearer ?? "").trim();
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

export async function fetchJson(
  url,
  {
    method = "GET",
    headers = {},
    body,
    fetchImpl = globalThis.fetch,
    timeoutMs = 15_000,
    signal,
  } = {},
) {
  const finalHeaders = { Accept: "application/json", ...headers };
  const init = { method, headers: finalHeaders, redirect: "error" };
  if (body !== undefined) {
    init.body = typeof body === "string" ? body : JSON.stringify(body);
    if (!finalHeaders["Content-Type"])
      finalHeaders["Content-Type"] = "application/json";
  }
  init.signal = signal ?? AbortSignal.timeout(timeoutMs);

  const res = await fetchImpl(url, init);
  const text = await res.text();
  if (!res.ok) {
    throw new HttpError({
      op: `${method} ${url}`,
      status: res.status,
      body: text.slice(0, MAX_JSON_BYTES),
      contentType: res.headers.get("content-type") ?? "",
    });
  }
  if (!text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`invalid JSON from ${url}: ${err?.message ?? err}`);
  }
}
