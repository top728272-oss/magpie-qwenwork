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

function serveAll({ catalog = catalogPayload([catalogEntry()]) } = {}) {
  return stubFetch((url) => {
    if (url.endsWith("/api/desktop-sessions"))
      return mintResponse({ expiresAtMs: Date.now() + 7_200_000 });
    if (url.endsWith("/api/desktop/chat-modes")) return jsonResponse(catalog);
    return jsonResponse({
      code: "ok",
      data: {
        user: { email: "user@example.com" },
        plan: { name: "Free" },
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

test("usage reads plan, credits and picks up the mint meter once a key exists", async () => {
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
    const res = await loader.fetch("https://gateway.qwenwork.ai/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "glm-5.3", messages: [] }),
    });
    assert.equal(res.status, 200);

    const usage = await hooks.auth.usage(getAuth);
    assert.equal(usage.plan, "Free");
    assert.equal(usage.user, "user@example.com");
    assert.equal(usage.balance, 700);
    assert.equal(usage.windows.length, 2);
    assert.equal(usage.windows[0].name, "Credits");
    assert.equal(usage.windows[0].unit, "credits");
    assert.equal(usage.windows[0].display, "700 remaining");
    assert.equal(usage.windows[1].name, "MaaS access key");
    assert.match(usage.windows[1].display, /valid for/);
  } finally {
    restore.mock.restore();
  }
});

test("usage reports an error payload when the gateway refuses", async () => {
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
    assert.match(usage.error, /expired/i);
    assert.deepEqual(usage.windows, []);
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
  assert.equal(_internal.VERSION, "0.1.0");
});
