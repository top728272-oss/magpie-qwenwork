import {
  ACCOUNT_CONTEXT_INCLUDE,
  ACCOUNT_CONTEXT_PATH,
  BALANCE_PATH,
  QUOTA_USAGE_PATH,
  USAGE_TIMEOUT_MS,
  WEB_ORIGIN,
  WALLETS_V1_PATH,
  WALLETS_V2_PATH,
} from "./constants.mjs";
import { desktopHeaders, fetchJson } from "./http.mjs";
import { t } from "./i18n.mjs";
import { formatDuration, parseTimestamp, toNumber } from "./util.mjs";

const BUCKET_KEYS = {
  daily: ["daily_quota", "dailyQuota", "daily_credits", "dailyCredits"],
  monthly: ["monthly_quota", "monthlyQuota", "subscription_quota", "subscriptionQuota"],
  other: ["other_quota", "otherQuota", "other_credits", "otherCredits"],
};
const REFRESH_AMOUNT_KEYS = ["daily_refresh_amount", "dailyRefreshAmount"];
const DAY_SPAN_SECONDS = 86_400;
const MONTH_SPAN_SECONDS = 2_592_000;

export function formatCredits(remaining, unknownLabel) {
  if (remaining === null || remaining === undefined) return unknownLabel;
  const value = toNumber(remaining, Number.NaN);
  if (!Number.isFinite(value)) return unknownLabel;
  return String(Math.round(value * 100) / 100);
}

export function parseEpoch(value) {
  const n = toNumber(value, 0);
  if (n <= 0) return null;
  return n < 1e12 ? n * 1000 : n;
}

export function pickBucket(payload, keys) {
  for (const key of keys) {
    const raw = payload?.[key];
    if (raw && typeof raw === "object" && raw.remaining !== null && raw.remaining !== undefined) {
      return {
        total: toNumber(raw.total, 0),
        used: toNumber(raw.used, 0),
        remaining: toNumber(raw.remaining, 0),
        percentage: toNumber(raw.percentage, 0),
        unit: String(raw.unit ?? "credits").trim() || "credits",
      };
    }
  }
  return null;
}

export function parseCreditBreakdown(payload) {
  if (!payload || typeof payload !== "object") return null;
  const daily = pickBucket(payload, BUCKET_KEYS.daily);
  const monthly = pickBucket(payload, BUCKET_KEYS.monthly);
  const other = pickBucket(payload, BUCKET_KEYS.other);
  let dailyRefreshAmount = 0;
  for (const key of REFRESH_AMOUNT_KEYS) {
    const n = toNumber(payload?.[key], 0);
    if (n > 0) {
      dailyRefreshAmount = n;
      break;
    }
  }
  if (!dailyRefreshAmount && daily)
    dailyRefreshAmount = toNumber(payload?.daily_quota?.refresh_amount, 0);
  const breakdown = {
    daily,
    monthly,
    other,
    dailyRefreshAmount: dailyRefreshAmount > 0 ? dailyRefreshAmount : null,
    expiresAt: parseEpoch(payload?.expires_at),
  };
  return breakdown.daily || breakdown.monthly || breakdown.other ? breakdown : null;
}

export function normalizeBalance(payload) {
  const data = payload?.data && typeof payload.data === "object" ? payload.data : {};
  return {
    balance: Number.isFinite(Number(data.balance)) ? Number(data.balance) : null,
    freezeCredit: toNumber(data.freeze_credit, 0),
  };
}

export function parseWalletItems(payload) {
  const items = payload?.data?.items;
  if (!Array.isArray(items)) return [];
  return items
    .map((raw) => {
      const balance = toNumber(raw?.balance, Number.NaN);
      if (!Number.isFinite(balance)) return null;
      return {
        creditName: String(raw?.credit_name ?? "").trim(),
        periodType: String(raw?.period_type ?? "").trim(),
        source: String(raw?.source ?? "").trim(),
        balance,
        validFrom: parseTimestamp(raw?.valid_from),
        validTo: parseTimestamp(raw?.valid_to),
      };
    })
    .filter(Boolean);
}

function bucketKey(periodType) {
  if (periodType === "daily_credits") return "daily";
  if (periodType === "monthly_credits") return "monthly";
  if (periodType === "longterm_credits" || periodType === "other_credits")
    return "longterm";
  return "";
}

export function normalizeWalletBuckets(items) {
  const buckets = { daily: null, monthly: null, longterm: null };
  for (const item of items) {
    const key = bucketKey(item.periodType);
    if (!key) continue;
    const current = buckets[key];
    if (!current) {
      buckets[key] = {
        balance: item.balance,
        validTo: item.validTo,
        count: 1,
      };
      continue;
    }
    current.balance += item.balance;
    current.count += 1;
    if (current.validTo && item.validTo) current.validTo = Math.min(current.validTo, item.validTo);
    else current.validTo = current.validTo || item.validTo;
  }
  const any = buckets.daily || buckets.monthly || buckets.longterm;
  return any ? buckets : null;
}

export function normalizeWalletTotals(payload) {
  if (!payload?.data || typeof payload.data !== "object") return null;
  const total = (raw) => {
    if (!raw || typeof raw !== "object") return null;
    const n = toNumber(raw.total_balance, Number.NaN);
    return Number.isFinite(n) && n > 0 ? { balance: n, validTo: null } : null;
  };
  const buckets = {
    daily: total(payload.data.daily_credits),
    monthly: total(payload.data.monthly_credits),
    longterm: total(payload.data.longterm_credits),
  };
  return buckets.daily || buckets.monthly || buckets.longterm ? buckets : null;
}

export async function fetchUserWallets(
  token,
  {
    fetchImpl = globalThis.fetch,
    timeoutMs = USAGE_TIMEOUT_MS,
    origin = WEB_ORIGIN,
  } = {},
) {
  const base = String(origin ?? WEB_ORIGIN).trim().replace(/\/+$/, "");
  try {
    const payload = await fetchJson(`${base}${WALLETS_V2_PATH}?lifecycle=active`, {
      headers: desktopHeaders(token),
      fetchImpl,
      timeoutMs,
    });
    const buckets = normalizeWalletBuckets(parseWalletItems(payload));
    if (buckets) return { ok: true, buckets, via: "v2" };
  } catch (err) {
    const status = toNumber(err?.status, 0);
    if (status !== 0 && status < 500) {
      return { ok: false, permanent: status === 404 };
    }
  }
  try {
    const payload = await fetchJson(`${base}${WALLETS_V1_PATH}`, {
      headers: desktopHeaders(token),
      fetchImpl,
      timeoutMs,
    });
    const buckets = normalizeWalletTotals(payload);
    if (buckets) return { ok: true, buckets, via: "v1" };
    return { ok: false, permanent: true };
  } catch (err) {
    const status = toNumber(err?.status, 0);
    if (status === 404 || status === 403) return { ok: false, permanent: true };
    return { ok: false, permanent: false, error: String(err?.message ?? err) };
  }
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

function bucketWindow({ name, amount, resetsAt, span, lang, aside = false }) {
  const window = {
    name,
    unit: "credits",
    display: t(lang, "usageBucketDisplay", {
      amount: formatCredits(amount, t(lang, "usageUnknown")),
    }),
  };
  if (resetsAt) window.resetsAt = resetsAt;
  if (span) window.span = span;
  if (aside) window.aside = true;
  return window;
}

export function isoOrNull(ms) {
  const at = toNumber(ms, 0);
  return at > 0 ? new Date(at).toISOString() : null;
}

export function buildUsage({
  balance = null,
  breakdown = null,
  wallets = null,
  context = null,
  mint = null,
  lang = "zh",
  now = Date.now(),
}) {
  const unknownLabel = t(lang, "usageUnknown");
  const usage = { windows: [] };
  if (context?.plan) usage.plan = context.plan;
  if (context?.email) usage.user = context.email;
  const pool = balance ?? context?.remaining ?? null;
  if (Number.isFinite(pool)) usage.balance = pool;

  const nextRefreshAt = context?.nextRefreshDate || "";
  const planExpiresAt = breakdown?.expiresAt
    ? new Date(breakdown.expiresAt).toISOString()
    : "";

  if (breakdown?.daily) {
    const daily = breakdown.daily;
    usage.windows.push({
      name: t(lang, "usageDailyName"),
      unit: "credits",
      used: daily.used,
      display: t(lang, "usageDailyDisplay", {
        remaining: formatCredits(daily.remaining, unknownLabel),
        total: formatCredits(daily.total, unknownLabel),
        amount: formatCredits(breakdown.dailyRefreshAmount, unknownLabel),
      }),
      resetsAt: nextRefreshAt || undefined,
      span: DAY_SPAN_SECONDS,
    });
  } else if (wallets?.daily) {
    usage.windows.push(
      bucketWindow({
        name: t(lang, "usageDailyName"),
        amount: wallets.daily.balance,
        resetsAt: isoOrNull(wallets.daily.validTo) || nextRefreshAt,
        span: DAY_SPAN_SECONDS,
        lang,
      }),
    );
  }

  if (breakdown?.monthly) {
    const monthly = breakdown.monthly;
    usage.windows.push({
      name: t(lang, "usagePlanName"),
      unit: "credits",
      used: monthly.used,
      display: t(lang, "usagePlanDisplay", {
        remaining: formatCredits(monthly.remaining, unknownLabel),
        total: formatCredits(monthly.total, unknownLabel),
      }),
      resetsAt: planExpiresAt || undefined,
      span: MONTH_SPAN_SECONDS,
    });
  } else if (wallets?.monthly) {
    usage.windows.push(
      bucketWindow({
        name: t(lang, "usagePlanName"),
        amount: wallets.monthly.balance,
        resetsAt: isoOrNull(wallets.monthly.validTo) || planExpiresAt,
        span: MONTH_SPAN_SECONDS,
        lang,
      }),
    );
  }

  if (breakdown?.other) {
    usage.windows.push({
      name: t(lang, "usageAddOnName"),
      unit: "credits",
      used: breakdown.other.used,
      display: t(lang, "usageAddOnDisplay", {
        remaining: formatCredits(breakdown.other.remaining, unknownLabel),
      }),
      aside: true,
    });
  } else if (wallets?.longterm) {
    usage.windows.push(
      bucketWindow({
        name: t(lang, "usageAddOnName"),
        amount: wallets.longterm.balance,
        resetsAt: isoOrNull(wallets.longterm.validTo),
        lang,
        aside: true,
      }),
    );
  }

  usage.windows.push({
    name: t(lang, "usageCreditsName"),
    unit: "credits",
    display: t(lang, "usageCreditsDisplay", {
      remaining: formatCredits(pool, unknownLabel),
    }),
    aside: true,
  });

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

export function fetchAccountContext(
  origin,
  token,
  { fetchImpl = globalThis.fetch, timeoutMs = USAGE_TIMEOUT_MS } = {},
) {
  return fetchJson(
    `${String(origin ?? "").trim().replace(/\/+$/, "")}${ACCOUNT_CONTEXT_PATH}?include=${ACCOUNT_CONTEXT_INCLUDE}`,
    { headers: desktopHeaders(token), fetchImpl, timeoutMs },
  );
}

export function normalizeAccountContext(payload) {
  const data = payload?.data && typeof payload.data === "object" ? payload.data : {};
  const rawRemaining = data?.quota?.remaining;
  const remaining =
    rawRemaining === null || rawRemaining === undefined
      ? null
      : Number(rawRemaining);
  return {
    email: String(data?.user?.email ?? "").trim(),
    plan: String(data?.plan?.name ?? "").trim(),
    remaining: Number.isFinite(remaining) ? remaining : null,
    quotaExceeded: Boolean(data?.quota?.exceeded),
    nextRefreshDate: String(data?.plan?.next_refresh_date ?? "").trim(),
  };
}

export function fetchBalance(
  origin,
  token,
  { fetchImpl = globalThis.fetch, timeoutMs = USAGE_TIMEOUT_MS } = {},
) {
  return fetchJson(`${String(origin ?? "").trim().replace(/\/+$/, "")}${BALANCE_PATH}`, {
    headers: desktopHeaders(token),
    fetchImpl,
    timeoutMs,
  });
}

export function fetchQuotaUsage(
  origin,
  token,
  { fetchImpl = globalThis.fetch, timeoutMs = USAGE_TIMEOUT_MS } = {},
) {
  return fetchJson(`${String(origin ?? "").trim().replace(/\/+$/, "")}${QUOTA_USAGE_PATH}`, {
    headers: desktopHeaders(token),
    fetchImpl,
    timeoutMs,
  });
}
