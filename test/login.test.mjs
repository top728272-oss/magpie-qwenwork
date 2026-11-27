import test from "node:test";
import assert from "node:assert/strict";

import {
  authState,
  createMethods,
  pickKey,
  waitForAuthDocument,
} from "../src/login.mjs";
import { accountIdFor, resolveAccountSettings } from "../src/modes.mjs";
import {
  fakeFetch,
  jsonResponse,
  makeAuthDoc,
  makeJwt,
  mintResponse,
} from "./helpers.mjs";

const GATEWAY = "https://gateway.qwenwork.ai";

function happyFetch() {
  return fakeFetch((url) => {
    if (url.endsWith("/api/desktop-sessions")) return mintResponse();
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

function sadFetch(status = 401) {
  return fakeFetch(() => jsonResponse({ error: "unauthorized" }, { status }));
}

test("pickKey accepts the usual input names", () => {
  assert.equal(pickKey({ key: " a " }), "a");
  assert.equal(pickKey({ token: "t", apiKey: "" }), "t");
  assert.equal(pickKey({}), "");
});

test("authState maps a found document", () => {
  assert.deepEqual(authState({ ok: false }), {
    token: "",
    expiresAt: 0,
    email: "",
    plan: "",
  });
  const state = authState({
    ok: true,
    state: { token: "t", expiresAt: 42, email: "a@b.c", plan: "Free" },
  });
  assert.equal(state.token, "t");
  assert.equal(state.expiresAt, 42);
});

test("paste method verifies the token by minting and reads plan info", async () => {
  const methods = createMethods({ options: { gatewayOrigin: GATEWAY, lang: "en" }, deps: { fetchImpl: happyFetch() } });
  const paste = methods[1];
  assert.equal(paste.type, "api");

  const missing = await paste.authorize({});
  assert.equal(missing.type, "failed");

  const ok = await paste.authorize({ key: " pasted-token " });
  assert.equal(ok.type, "success");
  assert.equal(ok.key, "pasted-token");
  assert.equal(ok.metadata.mode, "paste");
  assert.equal(ok.metadata.email, "user@example.com");
  assert.equal(ok.metadata.plan, "Free");
});

test("paste method fails on an invalid token", async () => {
  const methods = createMethods({ options: { gatewayOrigin: GATEWAY, lang: "en" }, deps: { fetchImpl: sadFetch(401) } });
  const result = await methods[1].authorize({ key: "bad" });
  assert.equal(result.type, "failed");
  assert.match(result.error, /expired/);
});

test("adopt method always hands back an auto flow and adopts a fresh session in the callback", async () => {
  const future = new Date(Date.now() + 3600_000).toISOString();
  const doc = makeAuthDoc({ token: makeJwt({}), expiresAt: future });
  const methods = createMethods({
    options: { gatewayOrigin: GATEWAY, lang: "en" },
    deps: {
      fetchImpl: happyFetch(),
      readDoc: async () => ({
        ok: true,
        path: "/data/QwenWork/auth-v2.dat",
        doc,
        state: { token: doc.token, expiresAt: Date.parse(future), email: "user@example.com", plan: "Free", authRealm: "", identityVersion: 0 },
      }),
    },
  });
  const adopt = methods[0];
  assert.equal(adopt.type, "oauth");

  const flow = await adopt.authorize({}, {});
  assert.equal(flow.url, "https://qwenwork.ai");
  assert.equal(flow.method, "auto");
  assert.match(flow.instructions, /QwenWork/);
  assert.equal(typeof flow.callback, "function");

  const result = await flow.callback();
  assert.equal(result.type, "success");
  assert.equal(result.metadata.mode, "adopt");
  assert.equal(result.metadata.email, "user@example.com");
  assert.equal(result.metadata.plan, "Free");
});

test("adopt callback adopts the session that appears on disk", async () => {
  const past = new Date(Date.now() - 600_000).toISOString();
  const future = new Date(Date.now() + 3600_000).toISOString();
  let current = { ok: false, tried: ["/x"] };
  const methods = createMethods({
    options: { gatewayOrigin: GATEWAY, lang: "en" },
    deps: {
      fetchImpl: happyFetch(),
      readDoc: async () => current,
      pollMs: 10,
    },
  });
  const flow = await methods[0].authorize({}, {});
  setTimeout(() => {
    current = { ok: true, path: "/x", doc: makeAuthDoc({ token: "new-token", expiresAt: future }), state: { token: "new-token", expiresAt: Date.parse(future), email: "user@example.com", plan: "Free", authRealm: "", identityVersion: 0 } };
  }, 30);
  const result = await flow.callback();
  assert.equal(result.type, "success");
  assert.equal(result.key, "new-token");
  assert.equal(result.metadata.mode, "adopt");
});

test("waitForAuthDocument verifies an unchanged invalid token only once", async () => {
  const future = new Date(Date.now() + 3600_000).toISOString();
  let verifications = 0;
  const readDoc = async () => ({
    ok: true,
    path: "/x",
    doc: makeAuthDoc({ token: "bad-token", expiresAt: future }),
    state: { token: "bad-token", expiresAt: Date.parse(future), email: "", plan: "", authRealm: "", identityVersion: 0 },
  });
  const result = await waitForAuthDocument({
    explicitDir: "",
    pollMs: 10,
    timeoutMs: 60,
    lang: "en",
    readDoc,
    verify: async () => {
      verifications += 1;
      return { ok: false, error: "nope" };
    },
  }).catch((err) => err);
  assert.match(String(result?.message ?? result), /Timed out/);
  assert.equal(verifications, 1);
});

test("adopt callback times out when the session never becomes valid", async () => {
  const past = new Date(Date.now() - 600_000).toISOString();
  const methods = createMethods({
    options: { gatewayOrigin: GATEWAY, lang: "en" },
    deps: {
      fetchImpl: happyFetch(),
      readDoc: async () => ({
        ok: true,
        path: "/x",
        doc: makeAuthDoc({ token: "old-token", expiresAt: past }),
        state: { token: "old-token", expiresAt: Date.parse(past), email: "", plan: "", authRealm: "", identityVersion: 0 },
      }),
      pollMs: 10,
      waitMs: 60,
    },
  });
  const flow = await methods[0].authorize({}, {});
  const result = await flow.callback();
  assert.equal(result.type, "failed");
  assert.match(result.error, /Timed out/);
});

test("waitForAuthDocument aborts on signal", async () => {
  const controller = new AbortController();
  const task = waitForAuthDocument({
    timeoutMs: 60_000,
    pollMs: 10,
    signal: controller.signal,
    readDoc: async () => ({ ok: false, tried: ["/x"] }),
  });
  controller.abort();
  await assert.rejects(() => task, /cancelled/);
});

test("resolveAccountSettings and accountIdFor keep identities stable", () => {
  const settings = resolveAccountSettings(
    {
      type: "api",
      key: "tok",
      metadata: { mode: "paste", email: "a@b.c", plan: "Free" },
    },
    { gatewayOrigin: "https://gateway.qwenwork.ai/" },
  );
  assert.equal(settings.mode, "paste");
  assert.equal(settings.gatewayOrigin, GATEWAY);
  assert.equal(settings.email, "a@b.c");
  assert.equal(settings.key, "tok");

  const oauthSettings = resolveAccountSettings({ type: "oauth", key: "x" }, {});
  assert.equal(oauthSettings.mode, "adopt");

  assert.match(accountIdFor({ email: "User@Example.com" }), /^qwenwork:[0-9a-f]{12}$/);
  assert.equal(
    accountIdFor({ email: "User@Example.com" }),
    accountIdFor({ email: "user@example.com" }),
  );
  assert.match(accountIdFor({ token: "abc" }), /^qwenwork:[0-9a-f]{12}$/);
  assert.equal(accountIdFor({}), "qwenwork:local");
});
