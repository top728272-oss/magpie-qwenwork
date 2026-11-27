import test from "node:test";
import assert from "node:assert/strict";
import { mock } from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { QwenworkPlugin, resolveOptions, _internal } from "../index.mjs";
import {
  catalogEntry,
  catalogPayload,
  jsonResponse,
  mintResponse,
} from "./helpers.mjs";

const GATEWAY = "https://gateway.qwenwork.ai";

function stubFetch(handler) {
  return mock.method(globalThis, "fetch", async (url, init = {}) =>
    handler(String(url), init),
  );
}

function serveAll({
  catalog = catalogPayload([catalogEntry()]),
  wallets = null,
  claim = { status: 404, body: "" },
} = {}) {
  return stubFetch((url) => {
    if (url.endsWith("/api/desktop-sessions"))
      return mintResponse({ expiresAtMs: Date.now() + 7_200_000 });
    if (url.endsWith("/api/desktop/chat-modes")) return jsonResponse(catalog);
    if (url.endsWith("/api/v1/adapter/user/balance"))
      return jsonResponse({
        code: "ok",
        data: { balance: 699.9663, freeze_credit: 0 },
      });
    if (url.endsWith("/api/v2/quota/usage"))
      return jsonResponse({
        user_quota: null,
        add_on_quota: null,
        expires_at: 0,
      });
    if (url.includes("/user/v2/wallets")) {
      if (wallets === null) return new Response("", { status: 404 });
      return jsonResponse({
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
              valid_to: "2026-11-28T16:00:00.000Z",
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
      });
    }
    if (url.endsWith("/daily-credit-notice/claim")) {
      if (typeof claim === "number") return new Response("", { status: claim });
      return jsonResponse(claim.body ?? {}, { status: claim.status ?? 200 });
    }
    return jsonResponse({
      code: "ok",
      data: {
        user: { email: "user@example.com" },
        plan: { name: "Free", next_refresh_date: null },
        quota: { remaining: 700 },
      },
    });
  });
}

test.afterEach(() => {
  mock.restoreAll();
});

test("plugin exposes the hooks magpie calls", async () => {
  const hooks = await QwenworkPlugin({}, {});
  assert.deepEqual(Object.keys(hooks).sort(), [
    "auth",
    "chat.headers",
    "config",
    "provider",
  ]);
  assert.equal(hooks.auth.provider, "qwenwork");
  assert.equal(hooks.auth.methods.length, 2);
  assert.equal(hooks.auth.methods[0].type, "oauth");
  assert.equal(hooks.auth.methods[1].type, "api");
  assert.equal(typeof hooks.auth.loader, "function");
  assert.equal(typeof hooks.auth.usage, "function");
  assert.equal(typeof hooks.auth.checkin, "function");
  assert.equal(hooks.auth.refresh, undefined);
  assert.match(hooks.auth.icon, /^data:image\/svg\+xml;base64,/);
});

test("config declares the provider without overwriting user config", async () => {
  const hooks = await QwenworkPlugin({}, {});
  const cfg = {};
  await hooks.config(cfg);
  assert.equal(cfg.provider.qwenwork.api, "https://api1.qwenwork.ai/v1");
  assert.equal(cfg.provider.qwenwork.npm, "@ai-sdk/openai-compatible");
  assert.equal(cfg.provider.qwenwork.name, "QwenWork");
  assert.equal(Object.keys(cfg.provider.qwenwork.models).length, 9);

  const existing = { provider: { qwenwork: { name: "Mine" } } };
  await hooks.config(existing);
  assert.equal(existing.provider.qwenwork.name, "Mine");
});

test("models without an account returns the fallback catalog", async () => {
  const hooks = await QwenworkPlugin({}, {});
  const models = await hooks.provider.models({ models: {} }, {});
  assert.equal(Object.keys(models).length, 9);
  assert.equal(models[Symbol.for("magpie.fellBack")], undefined);
  assert.equal(models["qwen4-max"].provider.npm, "@ai-sdk/anthropic");
  assert.equal(models["glm-5.3"].provider.npm, "@ai-sdk/openai-compatible");
});

test("allowModelKeys trims the exposed models", async () => {
  const hooks = await QwenworkPlugin(
    { magpie: { options: { allowModelKeys: ["glm-5.3", "qwen4-max"] } } },
    {},
  );
  const cfg = {};
  await hooks.config(cfg);
  assert.deepEqual(Object.keys(cfg.provider.qwenwork.models).sort(), [
    "glm-5.3",
    "qwen4-max",
  ]);
  const models = await hooks.provider.models({ models: {} }, {});
  assert.deepEqual(Object.keys(models).sort(), ["glm-5.3", "qwen4-max"]);
});

test("models with an account uses the live catalog and dedupes", async () => {
  const restore = serveAll({
    catalog: catalogPayload([
      catalogEntry({ key: "qwen3.8-flash", is_default: true }),
      catalogEntry({ key: "qwen3.8-flash", frontier: true }),
      catalogEntry({ key: "qwen4-max", format: "anthropic/messages" }),
    ]),
  });
  try {
    const hooks = await QwenworkPlugin({}, {});
    const auth = {
      type: "api",
      key: "sess-token",
      metadata: { mode: "paste", email: "user@example.com", plan: "Free" },
    };
    const models = await hooks.provider.models({ models: {} }, { auth });
    assert.deepEqual(Object.keys(models), ["qwen3.8-flash", "qwen4-max"]);
    assert.equal(models["qwen3.8-flash"].name, "Qwen3.8-Flash");
    assert.equal(models["qwen4-max"].provider.npm, "@ai-sdk/anthropic");
  } finally {
    restore.mock.restore();
  }
});

test("models falls back with the fellBack marker when the catalog fails", async () => {
  const restore = stubFetch(() =>
    jsonResponse({ error: "boom" }, { status: 500 }),
  );
  try {
    const hooks = await QwenworkPlugin({}, {});
    const auth = {
      type: "api",
      key: "sess-token",
      metadata: { mode: "paste", email: "", plan: "" },
    };
    const models = await hooks.provider.models({ models: {} }, { auth });
    assert.equal(Object.keys(models).length, 9);
    assert.equal(models[Symbol.for("magpie.fellBack")], true);
  } finally {
    restore.mock.restore();
  }
});

test("models rethrows expired sign-in errors without a fallback", async () => {
  const restore = stubFetch(() =>
    jsonResponse({ error: "unauthorized" }, { status: 401 }),
  );
  const missingDir = join(tmpdir(), `magpie-qwenwork-missing-${Date.now()}`);
  try {
    const hooks = await QwenworkPlugin({}, {});
    const auth = {
      type: "api",
      key: "",
      metadata: { mode: "adopt", dataDir: missingDir, email: "", plan: "" },
    };
    await assert.rejects(
      () => hooks.provider.models({ models: {} }, { auth }),
      (err) => {
        assert.equal(err.signIn, "expired");
        return true;
      },
    );
  } finally {
    restore.mock.restore();
  }
});

test("usage reads the precise balance, plan and the mint meter once a key exists", async () => {
  const restore = serveAll();
  try {
    const hooks = await QwenworkPlugin({}, { lang: "en" });
    const auth = {
      type: "api",
      key: "sess-token",
      metadata: { mode: "paste", email: "user@example.com", plan: "" },
    };
    const getAuth = async () => auth;
    const loader = await hooks.auth.loader(getAuth);
    const res = await loader.fetch(
      "https://gateway.qwenwork.ai/v1/chat/completions",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "glm-5.3", messages: [] }),
      },
    );
    assert.equal(res.status, 200);

    const usage = await hooks.auth.usage(getAuth);
    assert.equal(usage.plan, "Free");
    assert.equal(usage.user, "user@example.com");
    assert.equal(usage.balance, 699.9663);
    assert.equal(usage.windows.length, 2);
    assert.equal(usage.windows[0].name, "Credits");
    assert.equal(usage.windows[0].unit, "credits");
    assert.equal(usage.windows[0].display, "699.97 credits remaining");
    assert.equal(usage.windows[1].name, "MaaS access key");
    assert.match(usage.windows[1].display, /valid for/);
  } finally {
    restore.mock.restore();
  }
});

test("usage renders wallet bucket windows with their real expiry", async () => {
  const restore = serveAll({ wallets: { items: [] } });
  try {
    const hooks = await QwenworkPlugin({}, { lang: "en" });
    const auth = {
      type: "api",
      key: "sess-token",
      metadata: { mode: "paste", email: "user@example.com", plan: "" },
    };
    const usage = await hooks.auth.usage(async () => auth);
    assert.equal(usage.windows.length, 3);
    assert.equal(usage.windows[0].name, "Daily");
    assert.equal(usage.windows[0].display, "199.95 credits");
    assert.equal(usage.windows[0].resetsAt, "2026-11-28T16:00:00.000Z");
    assert.equal(usage.windows[1].name, "Add-on");
    assert.equal(usage.windows[1].display, "500 credits");
    assert.equal(usage.windows[1].resetsAt, "2027-02-25T11:20:29.820Z");
    assert.equal(usage.windows[1].aside, true);
    assert.equal(usage.windows[2].name, "Credits");
    assert.equal(usage.windows[2].display, "699.97 credits remaining");
  } finally {
    restore.mock.restore();
  }
});

test("usage serves repeat calls from its cache without new fetches", async () => {
  const restore = serveAll();
  try {
    const hooks = await QwenworkPlugin({}, { lang: "en" });
    const auth = {
      type: "api",
      key: "sess-token",
      metadata: { mode: "paste", email: "user@example.com", plan: "" },
    };
    const getAuth = async () => auth;
    const first = await hooks.auth.usage(getAuth);
    const callsAfterFirst = restore.mock.calls.length;
    const second = await hooks.auth.usage(getAuth);
    assert.equal(second, first);
    assert.equal(restore.mock.calls.length, callsAfterFirst);
  } finally {
    restore.mock.restore();
  }
});

test("usage reports an error payload when every gateway endpoint refuses", async () => {
  const restore = stubFetch(() =>
    jsonResponse({ error: "unauthorized" }, { status: 401 }),
  );
  try {
    const hooks = await QwenworkPlugin({}, { lang: "en" });
    const auth = {
      type: "api",
      key: "expired",
      metadata: { mode: "paste", email: "", plan: "" },
    };
    const usage = await hooks.auth.usage(async () => auth);
    assert.match(usage.error, /unavailable/i);
    assert.deepEqual(usage.windows, []);
  } finally {
    restore.mock.restore();
  }
});

test("checkin claims credits and invalidates the usage cache", async () => {
  const restore = serveAll({
    claim: { status: 200, body: { should_show: true, credits: 20 } },
  });
  try {
    const hooks = await QwenworkPlugin({}, { lang: "en" });
    const auth = {
      type: "api",
      key: "sess-token",
      metadata: { mode: "paste", email: "user@example.com", plan: "" },
    };
    const getAuth = async () => auth;
    const result = await hooks.auth.checkin(getAuth);
    assert.deepEqual(result, {
      outcome: "claimed",
      message: "Claimed 20 credits",
    });
  } finally {
    restore.mock.restore();
  }
});

test("checkin maps a quiet day to ineligible", async () => {
  const restore = serveAll({
    claim: { status: 200, body: { should_show: false } },
  });
  try {
    const hooks = await QwenworkPlugin({}, { lang: "en" });
    const result = await hooks.auth.checkin(async () => ({
      type: "api",
      key: "sess-token",
      metadata: { mode: "paste", email: "", plan: "" },
    }));
    assert.deepEqual(result, {
      outcome: "ineligible",
      message: "No daily credit available today",
    });
  } finally {
    restore.mock.restore();
  }
});

test("checkin caches an unsupported claim endpoint and stops calling it", async () => {
  const restore = serveAll({ claim: { status: 404, body: "" } });
  try {
    const hooks = await QwenworkPlugin({}, { lang: "en" });
    const getAuth = async () => ({
      type: "api",
      key: "sess-token",
      metadata: { mode: "paste", email: "", plan: "" },
    });
    const claimCalls = () =>
      restore.mock.calls.filter((call) =>
        String(call.arguments[0]).includes("daily-credit-notice"),
      ).length;
    const first = await hooks.auth.checkin(getAuth);
    assert.equal(first.outcome, "ineligible");
    assert.equal(claimCalls(), 1);
    const second = await hooks.auth.checkin(getAuth);
    assert.equal(second.outcome, "ineligible");
    assert.equal(second.message, first.message);
    assert.equal(claimCalls(), 1);
  } finally {
    restore.mock.restore();
  }
});

test("checkin reports a failed claim without throwing", async () => {
  const restore = serveAll({ claim: { status: 503, body: "" } });
  try {
    const hooks = await QwenworkPlugin({}, { lang: "en" });
    const result = await hooks.auth.checkin(async () => ({
      type: "api",
      key: "sess-token",
      metadata: { mode: "paste", email: "", plan: "" },
    }));
    assert.equal(result.outcome, "failed");
    assert.match(result.message, /503/);
  } finally {
    restore.mock.restore();
  }
});

test("chat.headers adds nothing for this provider and stays quiet for others", async () => {
  const hooks = await QwenworkPlugin({}, {});
  const output = { headers: {} };
  await hooks["chat.headers"](
    { model: { providerID: "qwenwork" }, sessionID: "s-1" },
    output,
  );
  assert.deepEqual(output.headers, {});

  const other = { headers: {} };
  await hooks["chat.headers"](
    { model: { providerID: "openai" }, sessionID: "s-1" },
    other,
  );
  assert.deepEqual(other.headers, {});
});

test("resolveOptions merges function options and magpie options", () => {
  const opts = resolveOptions(
    { magpie: { options: { lang: "en" }, option: { debug: true } } },
    { dataDir: "/tmp/qw" },
  );
  assert.equal(opts.lang, "en");
  assert.equal(opts.debug, true);
  assert.equal(opts.dataDir, "/tmp/qw");
  assert.deepEqual(opts.allowModelKeys, []);
  assert.equal(opts.gatewayOrigin, "https://gateway.qwenwork.ai");
});

test("the internal test bag exposes the expected names", () => {
  for (const name of [
    "resolveOptions",
    "resolveAccountSettings",
    "createMethods",
    "createSessionStore",
    "createLoader",
    "fallbackModels",
    "buildUsage",
    "ICON_DATA_URI",
    "VERSION",
    "FALLBACK_SNAPSHOT_DATE",
  ]) {
    assert.notEqual(_internal[name], undefined, name);
  }
  assert.equal(_internal.FALLBACK_SNAPSHOT_DATE, "2026-11-27");
  assert.equal(_internal.VERSION, "0.3.0");
});
