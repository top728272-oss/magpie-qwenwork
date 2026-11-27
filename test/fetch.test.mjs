import test from "node:test";
import assert from "node:assert/strict";

import {
  createLoader,
  guardResponse,
  maasBase,
  modelIdFromBody,
  normalizeIncomingUrl,
  sessionHeaders,
} from "../src/fetch.mjs";
import { createSessionStore } from "../src/session.mjs";
import {
  fakeFetch,
  jsonResponse,
  makeAuthDoc,
  mintResponse,
} from "./helpers.mjs";

const NOW = 1_800_000_000_000;

test("normalizeIncomingUrl rebuilds each family onto the minted base", () => {
  const base = "https://api1.qwenwork.ai/v1";
  assert.equal(
    normalizeIncomingUrl(
      "https://gateway.qwenwork.ai/v1/chat/completions?alt=sse",
      base,
    ),
    `${base}/chat/completions?alt=sse`,
  );
  assert.equal(
    normalizeIncomingUrl("https://gateway.qwenwork.ai/v1/messages", base),
    `${base}/messages`,
  );
  assert.equal(
    normalizeIncomingUrl("https://gateway.qwenwork.ai/v1/messages/", base),
    `${base}/messages`,
  );
  assert.equal(
    normalizeIncomingUrl("https://gateway.qwenwork.ai/v1/responses", base),
    `${base}/responses`,
  );
  assert.equal(
    normalizeIncomingUrl(
      "https://gateway.qwenwork.ai/v1/messages/count_tokens",
      base,
    ),
    `${base}/messages/count_tokens`,
  );
  assert.equal(normalizeIncomingUrl("/messages", base), `${base}/messages`);
});

test("maasBase trims slashes and appends /v1", () => {
  assert.equal(
    maasBase("https://api1.qwenwork.ai/"),
    "https://api1.qwenwork.ai/v1",
  );
  assert.equal(
    maasBase("https://api2.qwenwork.ai"),
    "https://api2.qwenwork.ai/v1",
  );
});

test("modelIdFromBody reads the model field and tolerates garbage", () => {
  assert.equal(
    modelIdFromBody(JSON.stringify({ model: "glm-5.3" })),
    "glm-5.3",
  );
  assert.equal(modelIdFromBody("{}"), "");
  assert.equal(modelIdFromBody("not json"), "");
  assert.equal(modelIdFromBody(undefined), "");
});

test("guardResponse flags a 401 as an expired sign-in", async () => {
  const res = await guardResponse(
    new Response(JSON.stringify({ error: "bad key" }), {
      status: 401,
      headers: { "content-type": "application/json", "content-length": "20" },
    }),
  );
  assert.equal(res.status, 401);
  assert.equal(res.headers.get("x-magpie-sign-in"), "expired");
  assert.equal(res.headers.get("content-length"), null);
  assert.match(await res.text(), /bad key/);
});

test("guardResponse leaves other statuses untouched", async () => {
  const original = new Response("nope", { status: 403 });
  assert.equal(await guardResponse(original), original);
});

test("sessionHeaders adds nothing (no verified per-session header)", () => {
  assert.deepEqual(sessionHeaders("s-1"), {});
});

function makeLoader({ fetchImpl, doc }) {
  const sessions = createSessionStore({
    options: { gatewayOrigin: "https://gateway.qwenwork.ai", lang: "en" },
    deps: {
      fetchImpl,
      now: () => NOW,
      readDoc: async () => ({
        ok: true,
        path: "/data/QwenWork/auth-v2.dat",
        doc,
        state: {
          token: doc.token,
          expiresAt: Date.parse(doc.expiresAt),
          email: "user@example.com",
          plan: "Free",
          authRealm: "standard",
          identityVersion: 0,
        },
      }),
      env: {},
      home: "/h",
    },
  });
  return createLoader(
    async () => ({
      type: "api",
      key: "stored-session-token",
      metadata: { mode: "adopt" },
    }),
    { gatewayOrigin: "https://gateway.qwenwork.ai", lang: "en" },
    { fetchImpl, sessions },
  );
}

test("loader rebuilds the URL onto the minted base and injects the access key", async () => {
  const doc = makeAuthDoc({ token: makeSessionJwt() });
  const fetchImpl = fakeFetch((url) =>
    url.includes("/chat/completions")
      ? jsonResponse({ ok: true })
      : mintResponse({
          accessKey: "key-a",
          baseUrl: "https://api1.qwenwork.ai",
        }),
  );
  const loader = makeLoader({ fetchImpl, doc });

  const res = await loader.fetch(
    "https://gateway.qwenwork.ai/v1/chat/completions",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": "drop-me",
      },
      body: JSON.stringify({ model: "glm-5.3", messages: [] }),
    },
  );

  assert.equal(res.status, 200);
  const chat = fetchImpl.calls.find((call) =>
    call.url.includes("/chat/completions"),
  );
  assert.equal(chat.url, "https://api1.qwenwork.ai/v1/chat/completions");
  const headers = new Headers(chat.init.headers);
  assert.equal(headers.get("authorization"), "Bearer key-a");
  assert.equal(headers.get("x-api-key"), null);
  assert.equal(headers.get("x-qwenwork-platform"), "win32");
  assert.match(headers.get("user-agent"), /qoderwork\//);
  assert.equal(chat.init.redirect, "error");
  assert.match(loader.baseURL, /\/v1$/);
});

test("loader routes messages requests to the minted base as well", async () => {
  const doc = makeAuthDoc({ token: makeSessionJwt() });
  const fetchImpl = fakeFetch((url) =>
    url.includes("/messages")
      ? jsonResponse({ ok: true })
      : mintResponse({
          accessKey: "key-a",
          baseUrl: "https://api2.qwenwork.ai",
        }),
  );
  const loader = makeLoader({ fetchImpl, doc });
  const res = await loader.fetch(
    "https://gateway.qwenwork.ai/v1/messages?beta=1",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "minimax-m3.1-flash", messages: [] }),
    },
  );
  assert.equal(res.status, 200);
  const messages = fetchImpl.calls.find((call) =>
    call.url.includes("/messages"),
  );
  assert.equal(messages.url, "https://api2.qwenwork.ai/v1/messages?beta=1");
});

test("loader re-mints once on a 401 and retries with the new key and base", async () => {
  const doc = makeAuthDoc({ token: makeSessionJwt() });
  let chatCalls = 0;
  const fetchImpl = fakeFetch((url) => {
    if (!url.includes("/chat/completions"))
      return mintResponse({ accessKey: "key-a" });
    chatCalls += 1;
    if (chatCalls === 1) {
      return jsonResponse({ error: "expired" }, { status: 401 });
    }
    return jsonResponse({ ok: true });
  });
  let mints = 0;
  const wrapped = async (url, init) => {
    if (url.endsWith("/api/desktop-sessions")) {
      mints += 1;
      return mintResponse({
        accessKey: mints === 1 ? "key-a" : "key-b",
        baseUrl:
          mints === 1 ? "https://api1.qwenwork.ai" : "https://api9.qwenwork.ai",
      });
    }
    return fetchImpl(url, init);
  };
  const loader = makeLoader({ fetchImpl: wrapped, doc });

  const res = await loader.fetch(
    "https://gateway.qwenwork.ai/v1/chat/completions",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "glm-5.3", messages: [] }),
    },
  );

  assert.equal(res.status, 200);
  assert.equal(chatCalls, 2);
  const retry = fetchImpl.calls.filter((call) =>
    call.url.includes("/chat/completions"),
  )[1];
  assert.equal(retry.url, "https://api9.qwenwork.ai/v1/chat/completions");
  const headers = new Headers(retry.init.headers);
  assert.equal(headers.get("authorization"), "Bearer key-b");
  assert.equal(res.headers.get("x-magpie-sign-in"), null);
});

test("loader stamps the sign-in header when the retry also fails with 401", async () => {
  const doc = makeAuthDoc({ token: makeSessionJwt() });
  const fetchImpl = fakeFetch((url) =>
    url.includes("/chat/completions")
      ? jsonResponse({ error: "expired" }, { status: 401 })
      : mintResponse({ accessKey: "key-a" }),
  );
  const loader = makeLoader({ fetchImpl, doc });
  const res = await loader.fetch(
    "https://gateway.qwenwork.ai/v1/chat/completions",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "glm-5.3", messages: [] }),
    },
  );
  assert.equal(res.status, 401);
  assert.equal(res.headers.get("x-magpie-sign-in"), "expired");
});

test("loader surfaces the sign-in error when re-minting fails with 401", async () => {
  const doc = makeAuthDoc({ token: makeSessionJwt() });
  const fetchImpl = fakeFetch((url) =>
    url.includes("/chat/completions")
      ? jsonResponse({ error: "expired" }, { status: 401 })
      : jsonResponse({ error: "unauthorized" }, { status: 401 }),
  );
  const loader = makeLoader({ fetchImpl, doc });
  await assert.rejects(
    () =>
      loader.fetch("https://gateway.qwenwork.ai/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "glm-5.3", messages: [] }),
      }),
    (err) => {
      assert.equal(err.signIn, "expired");
      return true;
    },
  );
});

function makeSessionJwt() {
  const b64 = (value) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${b64({ alg: "none" })}.${b64({ exp: 9999999999, email: "user@example.com" })}.sig`;
}
