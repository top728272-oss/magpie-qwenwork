import { MINT_TIMEOUT_MS } from "./constants.mjs";
import { desktopHeaders, fetchJson } from "./http.mjs";
import { accountIdFor } from "./modes.mjs";
import { fetchAccountContext, normalizeAccountContext } from "./usage.mjs";
import { describeError, trimSlash } from "./util.mjs";

export function successResult({ token, email = "", plan = "", mode = "" }) {
  return {
    type: "success",
    key: token,
    accountId: accountIdFor({ email, token }),
    metadata: {
      mode,
      email: String(email ?? "").trim(),
      plan: String(plan ?? "").trim(),
    },
  };
}

export function mintAccessToken(origin, token, { fetchImpl, timeoutMs } = {}) {
  return fetchJson(`${trimSlash(origin)}/api/desktop-sessions`, {
    method: "POST",
    headers: {
      ...desktopHeaders(token),
      "Content-Type": "application/json",
    },
    body: {},
    fetchImpl,
    timeoutMs: timeoutMs ?? MINT_TIMEOUT_MS,
  });
}

export async function verifySessionToken(
  origin,
  token,
  { fetchImpl = globalThis.fetch, lang = "zh" } = {},
) {
  let mint = null;
  try {
    mint = await mintAccessToken(origin, token, { fetchImpl });
  } catch (err) {
    if (err?.name === "HttpError" || err?.status) {
      if (err.status === 401 || err.status === 403)
        return { ok: false, status: err.status, error: describeError(err, { lang }) };
      if (err.status === 503)
        return { ok: false, status: 503, error: describeError(err, { lang }) };
      return {
        ok: true,
        transient: true,
        status: err.status,
        error: describeError(err, { lang }),
      };
    }
    return { ok: true, transient: true, error: String(err?.message ?? err) };
  }

  const context = { email: "", plan: "" };
  try {
    const payload = await fetchAccountContext(origin, token, { fetchImpl });
    const normalized = normalizeAccountContext(payload);
    context.email = normalized.email;
    context.plan = normalized.plan;
  } catch {
    void 0;
  }
  return { ok: true, baseUrl: trimSlash(mint?.base_url ?? ""), context };
}
