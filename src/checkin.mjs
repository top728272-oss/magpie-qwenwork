import { CLAIM_PATH } from "./constants.mjs";
import { HttpError, desktopHeaders, fetchJson } from "./http.mjs";
import { t } from "./i18n.mjs";
import { toNumber } from "./util.mjs";

export function claimPath(origin) {
  return `${String(origin ?? "").trim().replace(/\/+$/, "")}${CLAIM_PATH}`;
}

export async function claimDailyCredit(
  origin,
  token,
  { fetchImpl = globalThis.fetch, timeoutMs = 10_000 } = {},
) {
  try {
    const payload = await fetchJson(claimPath(origin), {
      method: "POST",
      headers: desktopHeaders(token),
      fetchImpl,
      timeoutMs,
    });
    return { ok: true, status: 200, payload };
  } catch (err) {
    if (err instanceof HttpError) return { ok: false, status: err.status, error: err.message };
    return { ok: false, status: 0, error: String(err?.message ?? err) };
  }
}

export function checkinOutcome(result, { lang = "zh" } = {}) {
  if (result?.ok) {
    const payload = result.payload && typeof result.payload === "object" ? result.payload : {};
    const credits = toNumber(payload.credits, 0);
    if (payload.should_show === true && credits > 0) {
      return {
        outcome: "claimed",
        message: t(lang, "checkinClaimed", {
          credits: Math.round(credits * 100) / 100,
        }),
      };
    }
    return { outcome: "ineligible", message: t(lang, "checkinNone") };
  }
  const status = toNumber(result?.status, 0);
  if (status === 404 || status === 403) {
    return {
      outcome: "ineligible",
      message: t(lang, "checkinUnavailable"),
      unavailable: true,
    };
  }
  if (status === 401) return { outcome: "failed", message: t(lang, "errSignInExpired") };
  if (status >= 500) return { outcome: "failed", message: t(lang, "errUpstream", { status }) };
  return {
    outcome: "failed",
    message: String(result?.error ?? "").trim() || t(lang, "errTimeout"),
  };
}
