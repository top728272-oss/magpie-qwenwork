import test from "node:test";
import assert from "node:assert/strict";

import { fetchAccountContext, normalizeAccountContext } from "../src/auth.mjs";
import {
  buildUsage,
  buildUsageError,
  creditsWindow,
  formatCredits,
  mintWindow,
} from "../src/usage.mjs";
import { fakeFetch } from "./helpers.mjs";

const NOW = 1_800_000_000_000;

test("normalizeAccountContext maps user, plan and quota", () => {
  const context = normalizeAccountContext({
    code: "ok",
    data: {
      user: { email: "user@example.com" },
      plan: { name: "Free", sessions: 10 },
      quota: { total: null, used: null, remaining: 700, exceeded: false },
    },
  });
  assert.equal(context.email, "user@example.com");
  assert.equal(context.plan, "Free");
  assert.equal(context.remaining, 700);
  assert.equal(context.quotaExceeded, false);

  const nullQuota = normalizeAccountContext({ data: { quota: { remaining: null } } });
  assert.equal(nullQuota.remaining, null);
  assert.equal(nullQuota.plan, "");
});

test("formatCredits renders numbers and an unknown label", () => {
  assert.equal(formatCredits(700, "unknown"), "700");
  assert.equal(formatCredits(699.9976, "unknown"), "700");
  assert.equal(formatCredits(12.345, "unknown"), "12.35");
  assert.equal(formatCredits(null, "unknown"), "unknown");
  assert.equal(formatCredits(undefined, "unknown"), "unknown");
});

test("buildUsage shows credits, plan, user and the minted key meter", () => {
  const usage = buildUsage({
    context: { email: "u@x.y", plan: "Free", remaining: 699.9976 },
    mint: { expiresAtMs: NOW + 3_600_000, baseUrl: "https://api1.qwenwork.ai" },
    lang: "en",
    now: NOW,
  });
  assert.equal(usage.plan, "Free");
  assert.equal(usage.user, "u@x.y");
  assert.equal(usage.balance, 699.9976);
  assert.equal(usage.windows.length, 2);
  assert.equal(usage.windows[0].name, "Credits");
  assert.equal(usage.windows[0].unit, "credits");
  assert.equal(usage.windows[0].display, "700 remaining");
  assert.equal(usage.windows[0].aside, true);
  assert.equal(usage.windows[1].name, "MaaS access key");
  assert.equal(usage.windows[1].display, "valid for 1h 0m");
  assert.equal(
    usage.windows[1].resetsAt,
    new Date(NOW + 3_600_000).toISOString(),
  );
});

test("buildUsage reports an expired minted key and unknown credits", () => {
  const usage = buildUsage({
    context: { email: "", plan: "", remaining: null },
    mint: { expiresAtMs: NOW - 1_000 },
    lang: "en",
    now: NOW,
  });
  assert.equal(usage.windows[0].display, "unknown remaining");
  assert.equal(usage.windows[1].display, "expired");
  assert.equal(usage.plan, undefined);
  assert.equal(usage.user, undefined);
});

test("creditsWindow and mintWindow handle missing values", () => {
  const credits = creditsWindow({ context: null, lang: "en", unknownLabel: "?" });
  assert.equal(credits.display, "? remaining");
  assert.equal(mintWindow({ mint: null, lang: "en", now: NOW }), null);
  assert.equal(mintWindow({ mint: { expiresAtMs: 0 }, lang: "en", now: NOW }), null);
});

test("fetchAccountContext sends the include param and bearer token", async () => {
  const fetchImpl = fakeFetch(() =>
    new Response(JSON.stringify({ code: "ok", data: { quota: { remaining: 5 } } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
  const payload = await fetchAccountContext(
    "https://gateway.qwenwork.ai/",
    "sess-token",
    { fetchImpl },
  );
  const call = fetchImpl.calls[0];
  assert.equal(
    call.url,
    "https://gateway.qwenwork.ai/api/v1/adapter/user/account-context?include=user,plan,quota",
  );
  const headers = new Headers(call.init.headers);
  assert.equal(headers.get("authorization"), "Bearer sess-token");
  assert.match(headers.get("user-agent"), /qoderwork\//);
  assert.equal(normalizeAccountContext(payload).remaining, 5);
});

test("buildUsageError keeps the vendor message", () => {
  const usage = buildUsageError("token gone", "en");
  assert.equal(usage.error, "token gone");
  assert.deepEqual(usage.windows, []);
  assert.equal(buildUsageError("", "en").error.length > 0, true);
});
