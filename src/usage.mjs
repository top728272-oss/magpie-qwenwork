import { t } from "./i18n.mjs";
import { formatDuration, toNumber } from "./util.mjs";

export function formatCredits(remaining, unknownLabel) {
  if (remaining === null || remaining === undefined) return unknownLabel;
  const value = toNumber(remaining, Number.NaN);
  if (!Number.isFinite(value)) return unknownLabel;
  return String(Math.round(value * 100) / 100);
}

export function creditsWindow({ context, lang, unknownLabel }) {
  return {
    name: t(lang, "usageCreditsName"),
    unit: "credits",
    display: t(lang, "usageCreditsDisplay", {
      remaining: formatCredits(context?.remaining, unknownLabel),
    }),
    aside: true,
  };
}

export function mintWindow({ mint, lang, now = Date.now() }) {
  const at = toNumber(mint?.expiresAtMs, 0);
  if (!at) return null;
  const left = at - now;
  return {
    name: t(lang, "usageKeyName"),
    aside: true,
    display:
      left > 0
        ? t(lang, "usageKeyLeft", { time: formatDuration(left, lang) })
        : t(lang, "usageKeyExpired"),
    resetsAt: new Date(at).toISOString(),
  };
}

export function buildUsage({ context, mint = null, lang = "zh", now = Date.now() }) {
  const unknownLabel = t(lang, "usageUnknown");
  const usage = { windows: [] };
  if (context?.plan) usage.plan = context.plan;
  if (context?.email) usage.user = context.email;
  if (Number.isFinite(context?.remaining)) usage.balance = context.remaining;
  usage.windows.push(creditsWindow({ context, lang, unknownLabel }));
  const mintMeter = mintWindow({ mint, lang, now });
  if (mintMeter) usage.windows.push(mintMeter);
  return usage;
}

export function buildUsageError(message, lang = "zh") {
  return {
    error: String(message ?? "").trim() || t(lang, "errNoToken"),
    windows: [],
  };
}
