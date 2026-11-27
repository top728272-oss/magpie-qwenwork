import test from "node:test";
import assert from "node:assert/strict";

import {
  buildUsage,
  buildUsageError,
  fetchAccountContext,
  fetchBalance,
  fetchQuotaUsage,
  fetchUserWallets,
  formatCredits,
  mintWindow,
  normalizeAccountContext,
  normalizeBalance,
  normalizeWalletBuckets,
  normalizeWalletTotals,
  parseCreditBreakdown,
  parseWalletItems,
} from "../src/usage.mjs";
import { fakeFetch } from "./helpers.mjs";

const NOW = 1_800_000_000_000;
const GATEWAY = "https://gateway.qwenwork.ai";

test("normalizeAccountContext maps user, plan, quota and next refresh", () => {
  const context = normalizeAccountContext({
    code: "ok",
    data: {
      user: { email: "user@example.com" },
      plan: { name: "Free", sessions: 10, next_refresh_date: null },
      quota: { total: null, used: null, remaining: 700, exceeded: false },
    },
  });
  assert.equal(context.email, "user@example.com");
  assert.equal(context.plan, "Free");
  assert.equal(context.remaining, 700);
  assert.equal(context.nextRefreshDate, "");

  const refreshing = normalizeAccountContext({
    data: {
      plan: { name: "Pro", next_refresh_date: "2026-11-28T00:00:00Z" },
      quota: { remaining: 42.5 },
    },
  });
  assert.equal(refreshing.nextRefreshDate, "2026-11-28T00:00:00Z");
  assert.equal(refreshing.remaining, 42.5);
});

test("normalizeBalance reads the precise pool", () => {
  const balance = normalizeBalance({
    code: "ok",
    data: {
      admission: { bypass_balance_check: true },
      balance: 699.9663,
      freeze_credit: 2,
    },
  });
  assert.equal(balance.balance, 699.9663);
  assert.equal(balance.freezeCredit, 2);
  assert.equal(normalizeBalance({ data: {} }).balance, null);
});

test("parseCreditBreakdown picks the first key with a remaining per bucket", () => {
  const breakdown = parseCreditBreakdown({
    daily_quota: {
      total: 100,
      used: 40,
      remaining: 60,
      percentage: 40,
      unit: "credits",
    },
    dailyQuota: { total: 1, used: 0, remaining: 1 },
    monthly_quota: null,
    subscriptionQuota: {
      total: 500,
      used: 100,
      remaining: 400,
      percentage: 20,
      unit: "credits",
    },
    otherCredits: { total: 10, used: 3, remaining: 7 },
    daily_refresh_amount: 5,
    expires_at: 0,
  });
  assert.deepEqual(breakdown.daily, {
    total: 100,
    used: 40,
    remaining: 60,
    percentage: 40,
    unit: "credits",
  });
  assert.equal(breakdown.monthly.total, 500);
  assert.equal(breakdown.other.remaining, 7);
  assert.equal(breakdown.dailyRefreshAmount, 5);
  assert.equal(breakdown.expiresAt, null);
});

test("parseCreditBreakdown reads the nested refresh amount and ms/second expiry", () => {
  const nested = parseCreditBreakdown({
    daily_quota: { total: 100, used: 40, remaining: 60, refresh_amount: 12 },
  });
  assert.equal(nested.dailyRefreshAmount, 12);

  const seconds = parseCreditBreakdown({
    subscription_quota: { remaining: 1 },
    expires_at: 1795805297,
  });
  assert.equal(seconds.expiresAt, 1795805297000);

  const millis = parseCreditBreakdown({
    subscription_quota: { remaining: 1 },
    expires_at: 1795805297000,
  });
  assert.equal(millis.expiresAt, 1795805297000);
});

test("parseCreditBreakdown returns null when every bucket is absent", () => {
  assert.equal(
    parseCreditBreakdown({
      user_quota: null,
      add_on_quota: null,
      expires_at: 0,
    }),
    null,
  );
  assert.equal(parseCreditBreakdown({}), null);
  assert.equal(parseCreditBreakdown(null), null);
});

test("parseWalletItems maps the v2 wallet entries", () => {
  const items = parseWalletItems({
    data: {
      items: [
        {
          credit_name: "trial_credits",
          period_type: "daily_credits",
          source: "daily_refresh",
          balance: "199.952",
          valid_from: "2026-11-27T16:00:00Z",
          valid_to: "2026-11-28T16:00:00Z",
        },
        {
          credit_name: "trial_credits",
          period_type: "longterm_credits",
          source: "user_registration",
          balance: "500",
          valid_from: "2026-11-25T11:20:29.82Z",
          valid_to: "2027-02-25T11:20:29.82Z",
        },
        {
          period_type: "daily_credits",
          balance: "0.05",
          valid_to: "2026-11-28T16:00:00Z",
        },
        { period_type: "daily_credits", balance: "broken" },
      ],
    },
  });
  assert.equal(items.length, 3);
  assert.equal(items[0].balance, 199.952);
  assert.equal(items[0].validTo, Date.parse("2026-11-28T16:00:00Z"));
  assert.equal(items[2].creditName, "");
  assert.deepEqual(parseWalletItems({ data: {} }), []);
});

test("normalizeWalletBuckets sums balances and keeps the soonest expiry", () => {
  const buckets = normalizeWalletBuckets(
    parseWalletItems({
      data: {
        items: [
          {
            period_type: "daily_credits",
            balance: "100",
            valid_to: "2026-11-29T00:00:00Z",
          },
          {
            period_type: "daily_credits",
            balance: "99.952",
            valid_to: "2026-11-28T16:00:00Z",
          },
          {
            period_type: "monthly_credits",
            balance: "42",
            valid_to: "2027-01-01T00:00:00Z",
          },
          {
            period_type: "longterm_credits",
            balance: "500",
            valid_to: "2027-02-25T11:20:29.82Z",
          },
          {
            period_type: "mystery_credits",
            balance: "7",
            valid_to: "2027-03-01T00:00:00Z",
          },
        ],
      },
    }),
  );
  assert.equal(buckets.daily.balance, 199.952);
  assert.equal(buckets.daily.validTo, Date.parse("2026-11-28T16:00:00Z"));
  assert.equal(buckets.daily.count, 2);
  assert.equal(buckets.monthly.balance, 42);
  assert.equal(buckets.longterm.balance, 500);
  assert.equal(normalizeWalletBuckets([]), null);
});

test("normalizeWalletTotals reads the v1 bucket totals", () => {
  const wallets = normalizeWalletTotals({
    code: "ok",
    data: {
      daily_credits: { total_balance: 199.952 },
      monthly_credits: { total_balance: 0 },
      longterm_credits: { total_balance: 500 },
    },
  });
  assert.equal(wallets.daily.balance, 199.952);
  assert.equal(wallets.monthly, null);
  assert.equal(wallets.longterm.balance, 500);
  assert.equal(normalizeWalletTotals({ data: {} }), null);
  assert.equal(normalizeWalletTotals(null), null);
});

test("fetchUserWallets prefers v2 items and falls back to v1 totals", async () => {
  const v2 = fakeFetch((url) => {
    if (url.includes("/user/v2/wallets"))
      return new Response(
        JSON.stringify({
          code: "ok",
          data: {
            lifecycle: "active",
            items: [
              {
                credit_name: "trial_credits",
                period_type: "daily_credits",
                source: "daily_refresh",
                balance: "199.952",
                valid_from: "2026-11-27T16:00:00Z",
                valid_to: "2026-11-28T16:00:00Z",
              },
              {
                credit_name: "trial_credits",
                period_type: "longterm_credits",
                source: "user_registration",
                balance: "500",
                valid_from: "2026-11-25T11:20:29.82Z",
                valid_to: "2027-02-25T11:20:29.82Z",
              },
            ],
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    return new Response("", { status: 404 });
  });
  const wallets = await fetchUserWallets("sess-token", { fetchImpl: v2 });
  assert.equal(wallets.ok, true);
  assert.equal(wallets.via, "v2");
  assert.equal(wallets.buckets.daily.balance, 199.952);
  assert.equal(
    wallets.buckets.daily.validTo,
    Date.parse("2026-11-28T16:00:00Z"),
  );
  assert.equal(wallets.buckets.longterm.balance, 500);
  const call = v2.calls[0];
  assert.equal(
    call.url,
    "https://qwenwork.ai/user/v2/wallets?lifecycle=active",
  );
  const headers = new Headers(call.init.headers);
  assert.equal(headers.get("authorization"), "Bearer sess-token");

  const v2down = fakeFetch((url) =>
    url.includes("/user/v2/wallets")
      ? new Response("gone", { status: 500 })
      : new Response(
          JSON.stringify({
            code: "ok",
            data: {
              daily_credits: { total_balance: 30 },
              longterm_credits: { total_balance: 7 },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
  );
  const fallback = await fetchUserWallets("t", { fetchImpl: v2down });
  assert.equal(fallback.via, "v1");
  assert.equal(fallback.buckets.daily.balance, 30);
  assert.equal(fallback.buckets.longterm.balance, 7);
  assert.equal(fallback.buckets.monthly, null);

  const bothDown = fakeFetch(() => new Response("", { status: 404 }));
  const dead = await fetchUserWallets("t", { fetchImpl: bothDown });
  assert.deepEqual(dead, { ok: false, permanent: true });
});

test("formatCredits renders numbers and an unknown label", () => {
  assert.equal(formatCredits(700, "unknown"), "700");
  assert.equal(formatCredits(699.9976, "unknown"), "700");
  assert.equal(formatCredits(12.345, "unknown"), "12.35");
  assert.equal(formatCredits(null, "unknown"), "unknown");
});

test("buildUsage builds Daily, Plan, Add-on windows plus the credits pool", () => {
  const usage = buildUsage({
    balance: 699.9663,
    breakdown: {
      daily: { total: 100, used: 40, remaining: 60 },
      monthly: { total: 500, used: 100, remaining: 400 },
      other: { total: 10, used: 3, remaining: 7 },
      dailyRefreshAmount: 5,
      expiresAt: new Date(NOW + 30 * 86400_000).getTime(),
    },
    context: {
      email: "u@x.y",
      plan: "Pro",
      remaining: 470,
      nextRefreshDate: "2026-11-28T00:00:00Z",
    },
    lang: "en",
    now: NOW,
  });
  assert.equal(usage.plan, "Pro");
  assert.equal(usage.user, "u@x.y");
  assert.equal(usage.balance, 699.9663);
  assert.equal(usage.windows.length, 4);

  const [daily, plan, addOn, credits] = usage.windows;
  assert.equal(daily.name, "Daily");
  assert.equal(daily.unit, "credits");
  assert.equal(daily.used, 40);
  assert.equal(daily.display, "60/100 (+5/day)");
  assert.equal(daily.resetsAt, "2026-11-28T00:00:00Z");
  assert.equal(daily.span, 86400);

  assert.equal(plan.name, "Plan");
  assert.equal(plan.display, "400/500");
  assert.equal(plan.span, 2592000);
  assert.equal(plan.resetsAt, new Date(NOW + 30 * 86400_000).toISOString());

  assert.equal(addOn.name, "Add-on");
  assert.equal(addOn.display, "7 left");
  assert.equal(addOn.aside, true);

  assert.equal(credits.name, "Credits");
  assert.equal(credits.display, "699.97 credits remaining");
  assert.equal(credits.aside, true);
});

test("buildUsage degrades to the single-pool card when all breakdown keys are null", () => {
  const usage = buildUsage({
    balance: 699.9663,
    breakdown: null,
    wallets: null,
    context: {
      email: "u@x.y",
      plan: "Free",
      remaining: 700,
      nextRefreshDate: "",
    },
    mint: { expiresAtMs: NOW + 3_600_000 },
    lang: "en",
    now: NOW,
  });
  assert.equal(usage.windows.length, 2);
  assert.equal(usage.windows[0].name, "Credits");
  assert.equal(usage.windows[0].display, "699.97 credits remaining");
  assert.equal(usage.windows[1].name, "MaaS access key");
  assert.equal(usage.windows[1].display, "valid for 1h 0m");
});

test("buildUsage falls back to wallet buckets with their real expiry", () => {
  const usage = buildUsage({
    wallets: {
      daily: { balance: 199.952, validTo: Date.parse("2026-11-28T16:00:00Z") },
      monthly: null,
      longterm: {
        balance: 500,
        validTo: Date.parse("2027-02-25T11:20:29.82Z"),
      },
    },
    context: { email: "", plan: "Free", remaining: 700, nextRefreshDate: "" },
    lang: "en",
    now: NOW,
  });
  assert.equal(usage.windows.length, 3);
  assert.equal(usage.windows[0].name, "Daily");
  assert.equal(usage.windows[0].display, "199.95 credits");
  assert.equal(usage.windows[0].resetsAt, "2026-11-28T16:00:00.000Z");
  assert.equal(usage.windows[0].span, 86400);
  assert.equal(usage.windows[1].name, "Add-on");
  assert.equal(usage.windows[1].display, "500 credits");
  assert.equal(usage.windows[1].resetsAt, "2027-02-25T11:20:29.820Z");
  assert.equal(usage.windows[1].aside, true);
  assert.equal(usage.windows[2].name, "Credits");
  assert.equal(usage.windows[2].display, "700 credits remaining");
});

test("buildUsage reports an expired minted key and unknown credits", () => {
  const usage = buildUsage({
    context: { email: "", plan: "", remaining: null },
    mint: { expiresAtMs: NOW - 1_000 },
    lang: "en",
    now: NOW,
  });
  assert.equal(usage.windows[0].display, "unknown credits remaining");
  assert.equal(usage.windows[1].display, "expired");
  assert.equal(usage.plan, undefined);
});

test("mintWindow handles missing values", () => {
  assert.equal(mintWindow({ mint: null, lang: "en", now: NOW }), null);
  assert.equal(
    mintWindow({ mint: { expiresAtMs: 0 }, lang: "en", now: NOW }),
    null,
  );
});

test("gateway fetchers send desktop headers to the right paths", async () => {
  const fetchImpl = fakeFetch(
    () =>
      new Response(
        JSON.stringify({
          code: "ok",
          data: { balance: 12.5, freeze_credit: 0 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
  );
  const balance = await fetchBalance(`${GATEWAY}/`, "sess-token", {
    fetchImpl,
  });
  const call = fetchImpl.calls[0];
  assert.equal(call.url, `${GATEWAY}/api/v1/adapter/user/balance`);
  assert.equal(
    new Headers(call.init.headers).get("authorization"),
    "Bearer sess-token",
  );
  assert.equal(normalizeBalance(balance).balance, 12.5);

  await fetchQuotaUsage(GATEWAY, "t", { fetchImpl });
  assert.equal(fetchImpl.calls[1].url, `${GATEWAY}/api/v2/quota/usage`);

  await fetchAccountContext(GATEWAY, "t", { fetchImpl });
  assert.equal(
    fetchImpl.calls[2].url,
    `${GATEWAY}/api/v1/adapter/user/account-context?include=user,plan,quota`,
  );
});

test("fetchUserWallets reports a permanent miss when both endpoints 404", async () => {
  const bothDown = fakeFetch(
    (url) =>
      new Response("", {
        status: url.includes("/user/v2/wallets") ? 404 : 404,
      }),
  );
  const dead = await fetchUserWallets("t", { fetchImpl: bothDown });
  assert.equal(dead.ok, false);
  assert.equal(dead.permanent, true);

  const serverError = fakeFetch(
    (url) =>
      new Response("boom", {
        status: url.includes("/user/v2/wallets") ? 503 : 503,
      }),
  );
  const transient = await fetchUserWallets("t", { fetchImpl: serverError });
  assert.equal(transient.ok, false);
  assert.equal(transient.permanent, false);
});

test("buildUsageError keeps the vendor message", () => {
  const usage = buildUsageError("token gone", "en");
  assert.equal(usage.error, "token gone");
  assert.deepEqual(usage.windows, []);
  assert.equal(buildUsageError("", "en").error.length > 0, true);
});
