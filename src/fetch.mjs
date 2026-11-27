import { DEFAULT_MAAS_ORIGIN, HEADER_SIGN_IN } from "./constants.mjs";
import { desktopHeaders } from "./http.mjs";
import { resolveAccountSettings } from "./modes.mjs";
import { createSessionStore } from "./session.mjs";
import { trimSlash } from "./util.mjs";

const CHAT_SUFFIX = "/chat/completions";
const RESPONSES_SUFFIX = "/responses";
const MESSAGES_SUFFIX = "/messages";
const COUNT_TOKENS_SUFFIX = "/messages/count_tokens";

export function maasBase(baseUrl) {
  return `${trimSlash(baseUrl || DEFAULT_MAAS_ORIGIN)}/v1`;
}

export function normalizeIncomingUrl(
  input,
  base = maasBase(DEFAULT_MAAS_ORIGIN),
) {
  const raw =
    typeof input === "string" ? input : (input?.url ?? String(input ?? ""));
  let pathname = "";
  let search = "";
  try {
    const url = new URL(raw);
    pathname = url.pathname;
    search = url.search;
  } catch {
    pathname = raw;
  }

  let suffix = CHAT_SUFFIX;
  if (/\/messages\/count_tokens\/?$/i.test(pathname))
    suffix = COUNT_TOKENS_SUFFIX;
  else if (/\/messages\/?$/i.test(pathname)) suffix = MESSAGES_SUFFIX;
  else if (/\/responses\/?$/i.test(pathname)) suffix = RESPONSES_SUFFIX;
  else if (/\/chat\/completions\/?$/i.test(pathname)) suffix = CHAT_SUFFIX;

  return `${trimSlash(base)}${suffix}${search}`;
}

export function modelIdFromBody(body) {
  if (typeof body !== "string" || body.length === 0) return "";
  try {
    const parsed = JSON.parse(body);
    return String(parsed?.model ?? "").trim();
  } catch {
    return "";
  }
}

export async function guardResponse(res) {
  if (res.status !== 401) return res;
  const body = await res.text();
  const headers = new Headers(res.headers);
  headers.delete("content-length");
  headers.delete("content-encoding");
  headers.delete("transfer-encoding");
  headers.set(HEADER_SIGN_IN, "expired");
  return new Response(body, {
    status: res.status,
    statusText: res.statusText || "",
    headers,
  });
}

export function sessionHeaders() {
  return {};
}

export function createLoader(getAuth, options = {}, deps = {}) {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const sessions = deps.sessions ?? createSessionStore({ options, deps });

  async function send(target, init, accessKey) {
    const headers = new Headers(init?.headers ?? {});
    for (const [name, value] of Object.entries(desktopHeaders(accessKey)))
      headers.set(name, value);
    headers.delete("x-api-key");
    headers.delete("api-key");
    headers.set("Authorization", `Bearer ${accessKey}`);
    return fetchImpl(target, { ...init, headers, redirect: "error" });
  }

  return {
    baseURL: maasBase(DEFAULT_MAAS_ORIGIN),
    headers: desktopHeaders(""),
    async fetch(input, init = {}) {
      const auth = await getAuth();
      const settings = resolveAccountSettings(auth, options);

      let minted = await sessions.ensureFreshAccessKey(settings);
      let target = normalizeIncomingUrl(input, maasBase(minted.baseUrl));
      let res = await send(target, init, minted.accessKey);

      if (res.status === 401) {
        minted = await sessions
          .ensureFreshAccessKey(settings, { force: true })
          .catch(() => null);
        if (minted) {
          target = normalizeIncomingUrl(input, maasBase(minted.baseUrl));
          res = await send(target, init, minted.accessKey);
        }
      }

      return guardResponse(res);
    },
  };
}
