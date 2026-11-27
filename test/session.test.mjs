import test from "node:test";
import assert from "node:assert/strict";

import {
  createSessionStore,
  expiredError,
  mintUrl,
  signInError,
  unsupportedError,
} from "../src/session.mjs";
import {
  NOW,
  fakeFetch,
  jsonResponse,
  makeAuthDoc,
  makeJwt,
  memIo,
  mintResponse,
} from "./helpers.mjs";

const GATEWAY = "https://gateway.qwenwork.ai";
const DIR = "/data/QwenWork";

function makeStore({
  doc,
  fetchImpl = fakeFetch(() => mintResponse({ expiresAtMs: NOW + 7_200_000 })),
  now = () => NOW,
  key = "stored-session-key",
  mode = "adopt",
  onMint,
} = {}) {
  doc ??= makeAuthDoc({ expiresAt: new Date(NOW + 3600_000).toISOString() });
  const sessions = createSessionStore({
    options: { gatewayOrigin: GATEWAY, lang: "en" },
    deps: {
      fetchImpl,
      now,
      readDoc: async () => ({
        ok: true,
        path: `${DIR}/auth-v2.dat`,
        doc,
        state: {
          token: doc.token,
          expiresAt: Date.parse(doc.expiresAt),
          email: doc.user?.email ?? "",
          plan: doc.user?.planName ?? "",
          authRealm: "standard",
          identityVersion: 0,
        },
      }),
      onMint,
      env: {},
      home: "/h",
    },
  });
  const settings = {
    mode,
    gatewayOrigin: GATEWAY,
    dataDir: DIR,
    key,
    email: "",
    plan: "",
  };
  return { sessions, settings, fetchImpl };
}

test("mintUrl joins the gateway and the mint path", () => {
  assert.equal(
    mintUrl("https://gateway.qwenwork.ai/"),
    `${GATEWAY}/api/desktop-sessions`,
  );
});

test("sessionToken prefers a fresh disk token in adopt mode", async () => {
  const doc = makeAuthDoc({
    token: "disk-token",
    expiresAt: new Date(NOW + 3600_000).toISOString(),
  });
  const { sessions, settings, fetchImpl } = makeStore({ doc });
  const session = await sessions.sessionToken(settings);
  assert.equal(session.token, "disk-token");
  assert.equal(session.source, "adopt");
  assert.equal(fetchImpl.calls.length, 0);
});

test("sessionToken falls back to the stored key when the disk token is stale", async () => {
  const stale = makeJwt({ exp: Math.floor(NOW / 1000) - 60 });
  const doc = makeAuthDoc({
    token: stale,
    expiresAt: new Date(NOW - 60_000).toISOString(),
  });
  const { sessions, settings } = makeStore({ doc, key: "stored-key" });
  const session = await sessions.sessionToken(settings);
  assert.equal(session.token, "stored-key");
  assert.equal(session.source, "stored");
});

test("sessionToken reports a multi-identity install with the dedicated error", async () => {
  const doc = makeAuthDoc({
    expiresAt: new Date(NOW + 3600_000).toISOString(),
  });
  const sessions = createSessionStore({
    options: { gatewayOrigin: GATEWAY, lang: "en" },
    deps: {
      fetchImpl: fakeFetch(() => mintResponse()),
      now: () => NOW,
      readDoc: async () => ({
        ok: false,
        path: `${DIR}/auth-v2.dat`,
        reason: "identity-unsupported",
        identityVersion: 2,
      }),
      env: {},
      home: "/h",
    },
  });
  const settings = {
    mode: "adopt",
    gatewayOrigin: GATEWAY,
    dataDir: DIR,
    key: "",
    email: "",
    plan: "",
  };
  await assert.rejects(
    () => sessions.sessionToken(settings),
    (err) => {
      assert.equal(err.signIn, "expired");
      assert.equal(err.code, "IDENTITY_UNSUPPORTED");
      assert.equal(err.identityVersion, 2);
      assert.match(err.message, /identityVersion 2/);
      return true;
    },
  );
});

test("sessionToken throws a sign-in error with no usable token", async () => {
  const stale = makeJwt({ exp: Math.floor(NOW / 1000) - 60 });
  const doc = makeAuthDoc({
    token: stale,
    expiresAt: new Date(NOW - 60_000).toISOString(),
  });
  const { sessions, settings } = makeStore({ doc, key: "" });
  await assert.rejects(
    () => sessions.sessionToken(settings),
    (err) => {
      assert.equal(err.signIn, "expired");
      return true;
    },
  );
});

test("sessionToken in paste mode uses the pasted key without disk access", async () => {
  const { sessions, settings, fetchImpl } = makeStore({
    mode: "paste",
    key: "pasted-token",
  });
  const session = await sessions.sessionToken(settings);
  assert.equal(session.token, "pasted-token");
  assert.equal(session.source, "paste");
  assert.equal(fetchImpl.calls.length, 0);
});

test("ensureFreshAccessKey mints once and caches within the rotation margin", async () => {
  const { sessions, settings, fetchImpl } = makeStore();
  const first = await sessions.ensureFreshAccessKey(settings);
  const second = await sessions.ensureFreshAccessKey(settings);
  assert.equal(first.accessKey, "minted-key-1");
  assert.equal(second.accessKey, "minted-key-1");
  assert.equal(fetchImpl.calls.length, 1);

  const call = fetchImpl.calls[0];
  assert.equal(call.url, `${GATEWAY}/api/desktop-sessions`);
  const headers = new Headers(call.init.headers);
  assert.match(headers.get("user-agent"), /qoderwork\//);
  assert.match(headers.get("authorization"), /^Bearer ey/);
  assert.equal(headers.get("x-qwenwork-platform"), "win32");
  assert.equal(call.init.body, "{}");
  assert.equal(call.init.redirect, "error");
  assert.ok(sessions.peek());
});

test("ensureFreshAccessKey re-mints when forced", async () => {
  const { sessions, settings, fetchImpl } = makeStore();
  await sessions.ensureFreshAccessKey(settings);
  const forced = await sessions.ensureFreshAccessKey(settings, { force: true });
  assert.equal(forced.accessKey, "minted-key-1");
  assert.equal(fetchImpl.calls.length, 2);
});

test("ensureFreshAccessKey re-mints near expiry", async () => {
  let clock = NOW;
  const expiresAtMs = NOW + 7_200_000;
  const { sessions, settings, fetchImpl } = makeStore({
    now: () => clock,
    fetchImpl: fakeFetch(() => mintResponse({ expiresAtMs })),
  });
  await sessions.ensureFreshAccessKey(settings);
  clock = expiresAtMs - 600_000 - 1;
  await sessions.ensureFreshAccessKey(settings);
  assert.equal(fetchImpl.calls.length, 1);
  clock = expiresAtMs - 600_000;
  const minted = await sessions.ensureFreshAccessKey(settings);
  assert.equal(fetchImpl.calls.length, 2);
  assert.equal(minted.expiresAtMs, expiresAtMs);
});

test("concurrent ensure calls share one mint", async () => {
  const fetchImpl = fakeFetch(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    return mintResponse();
  });
  const { sessions, settings } = makeStore({ fetchImpl });
  const [a, b] = await Promise.all([
    sessions.ensureFreshAccessKey(settings),
    sessions.ensureFreshAccessKey(settings),
  ]);
  assert.equal(a.accessKey, "minted-key-1");
  assert.equal(b.accessKey, "minted-key-1");
  assert.equal(fetchImpl.calls.length, 1);
});

test("a 401 on mint becomes a sign-in expired error", async () => {
  const { sessions, settings } = makeStore({
    fetchImpl: fakeFetch(() =>
      jsonResponse({ error: "unauthorized" }, { status: 401 }),
    ),
  });
  await assert.rejects(
    () => sessions.ensureFreshAccessKey(settings),
    (err) => {
      assert.equal(err.signIn, "expired");
      assert.equal(err.status, 401);
      return true;
    },
  );
});

test("a 503 on mint becomes an unsupported-environment error", async () => {
  const { sessions, settings } = makeStore({
    fetchImpl: fakeFetch(() =>
      jsonResponse({ error: "no maas" }, { status: 503 }),
    ),
  });
  await assert.rejects(
    () => sessions.ensureFreshAccessKey(settings),
    (err) => {
      assert.equal(err.code, "DESKTOP_MAAS_UNSUPPORTED");
      assert.equal(err.signIn, undefined);
      return true;
    },
  );
});

test("an invalid mint payload is reported as-is", async () => {
  const { sessions, settings } = makeStore({
    fetchImpl: fakeFetch(() =>
      jsonResponse({ access_token: "k" }, { status: 201 }),
    ),
  });
  await assert.rejects(
    () => sessions.ensureFreshAccessKey(settings),
    /invalid-mint-response/,
  );
});

test("onMint fires with the mint summary", async () => {
  const events = [];
  const { sessions, settings } = makeStore({
    onMint: (event) => events.push(event),
  });
  await sessions.ensureFreshAccessKey(settings);
  assert.equal(events.length, 1);
  assert.equal(events[0].baseUrl, "https://api1.qwenwork.ai");
  assert.equal(events[0].expiresAtMs, NOW + 7_200_000);
});

test("error helpers carry the expected shape", () => {
  assert.equal(expiredError("en").signIn, "expired");
  assert.equal(signInError("en", { path: "/x", reason: "bad" }).status, 401);
  assert.equal(unsupportedError("en").status, 503);
  assert.match(unsupportedError("en").message, /503/);
});

test("sessionToken honors the file cache ttl without re-reading", async () => {
  let reads = 0;
  const doc = makeAuthDoc({
    token: "disk-token",
    expiresAt: new Date(NOW + 3600_000).toISOString(),
  });
  const sessions = createSessionStore({
    options: { gatewayOrigin: GATEWAY, lang: "en" },
    deps: {
      fetchImpl: fakeFetch(() => mintResponse()),
      now: () => NOW,
      readDoc: async () => {
        reads += 1;
        return {
          ok: true,
          path: `${DIR}/auth-v2.dat`,
          doc,
          state: {
            token: doc.token,
            expiresAt: Date.parse(doc.expiresAt),
            email: "",
            plan: "",
            authRealm: "",
            identityVersion: 0,
          },
        };
      },
      env: {},
      home: "/h",
    },
  });
  const settings = {
    mode: "adopt",
    gatewayOrigin: GATEWAY,
    dataDir: DIR,
    key: "",
    email: "",
    plan: "",
  };
  await sessions.sessionToken(settings);
  await sessions.sessionToken(settings);
  assert.equal(reads, 1);
  await sessions.sessionToken(settings, { force: true });
  assert.equal(reads, 2);
});
