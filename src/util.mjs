import { createHash } from "node:crypto";

import { t } from "./i18n.mjs";

export function trimSlash(value) {
  return String(value ?? "")
    .trim()
    .replace(/\/+$/, "");
}

export function toNumber(value, fallback = 0) {
  if (typeof value === "number")
    return Number.isFinite(value) ? value : fallback;
  if (typeof value !== "string") return fallback;
  const n = Number(value.trim());
  return Number.isFinite(n) ? n : fallback;
}

export function sha256Hex(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex");
}

export function maskToken(value) {
  const raw = String(value ?? "");
  if (!raw) return "<absent>";
  return `sha256:${sha256Hex(raw).slice(0, 10)} len=${raw.length}`;
}

export function decodeJwt(token) {
  const parts = String(token ?? "").split(".");
  if (parts.length < 2) return null;
  try {
    const payload = JSON.parse(
      Buffer.from(parts[1], "base64url").toString("utf8"),
    );
    return payload && typeof payload === "object" ? payload : null;
  } catch {
    return null;
  }
}

export function tokenClaims(token) {
  const payload = decodeJwt(token);
  if (!payload) return null;
  return {
    subject: String(payload.sub ?? "").trim(),
    email: String(payload.email ?? "").trim(),
    type: String(payload.type ?? "").trim(),
    expiresAt: toNumber(payload.exp, 0) * 1000,
    issuedAt: toNumber(payload.iat, 0) * 1000,
    issuer: String(payload.iss ?? "").trim(),
  };
}

export function isFresh(expiresAt, marginMs, now = Date.now()) {
  const at = toNumber(expiresAt, 0);
  if (!at) return true;
  return at - now > marginMs;
}

export function parseTimestamp(value) {
  if (typeof value === "number") return toNumber(value, 0);
  const raw = String(value ?? "").trim();
  if (!raw) return 0;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : 0;
}

export function formatDuration(ms, lang = "zh") {
  const total = Math.max(0, Math.floor(toNumber(ms, 0) / 1000));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (lang === "en") {
    if (days > 0) return `${days}d ${hours}h`;
    if (hours > 0) return `${hours}h ${minutes}m`;
    return `${Math.max(1, minutes)}m`;
  }
  if (days > 0) return `${days} 天 ${hours} 小时`;
  if (hours > 0) return `${hours} 小时 ${minutes} 分`;
  return `${Math.max(1, minutes)} 分钟`;
}

export function describeError(err, { lang = "zh" } = {}) {
  const status = toNumber(err?.status, 0);
  const code = String(err?.code ?? err?.upstream?.code ?? "").trim();
  const raw = String(err?.message ?? err ?? "");
  const upstream = String(err?.upstream?.message ?? "").trim();
  const vendor = upstream && !upstream.startsWith("<") ? upstream : "";

  if (code === "DESKTOP_MAAS_UNSUPPORTED") return t(lang, "errMintUnsupported");
  if (code === "IDENTITY_UNSUPPORTED")
    return t(lang, "errIdentityVersion", {
      version: toNumber(err?.identityVersion, 0),
    });
  if (code === "ACCESS_TOKEN_EXPIRED" || code === "ACCESS_TOKEN_INVALID")
    return t(lang, "errSignInExpired");
  if (status === 401) return t(lang, "errSignInExpired");
  if (status === 403) return vendor || t(lang, "errForbidden");
  if (status === 429) return vendor || t(lang, "errRateLimited");
  if (status === 503) return t(lang, "errMintUnsupported");
  if (status >= 500) return vendor || t(lang, "errUpstream", { status });
  if (/timeout|timed out|AbortError/i.test(raw)) return t(lang, "errTimeout");
  if (/redirect/i.test(raw)) return t(lang, "errRedirect");
  if (/unsupported-platform/i.test(raw))
    return t(lang, "errUnsupportedPlatform");
  return raw || t(lang, "errSignInExpired");
}

export function parseErrorBody(body) {
  const text = String(body ?? "");
  try {
    const data = JSON.parse(text);
    if (typeof data?.error === "string") {
      return { message: data.error, code: String(data.code ?? "") };
    }
    if (data?.error && typeof data.error === "object") {
      return {
        message: String(data.error.message ?? data.error.code ?? ""),
        code: String(data.error.code ?? data.code ?? ""),
      };
    }
    if (typeof data?.message === "string")
      return { message: data.message, code: String(data.code ?? "") };
  } catch {
    return { message: text.slice(0, 300).trim(), code: "" };
  }
  return { message: text.slice(0, 300).trim(), code: "" };
}
