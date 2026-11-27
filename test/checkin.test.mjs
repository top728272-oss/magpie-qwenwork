import test from "node:test";
import assert from "node:assert/strict";

import {
  checkinOutcome,
  claimDailyCredit,
  claimPath,
} from "../src/checkin.mjs";
import { fakeFetch } from "./helpers.mjs";

const GATEWAY = "https://gateway.qwenwork.ai";

test("claimPath joins the gateway and the claim route", () => {
  assert.equal(
    claimPath(`${GATEWAY}/`),
    `${GATEWAY}/api/v1/adapter/user/daily-credit-notice/claim`,
  );
});

test("claimDailyCredit posts with the desktop headers and no body", async () => {
  const fetchImpl = fakeFetch(
    () =>
      new Response(JSON.stringify({ should_show: true, credits: 20 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  );
  const result = await claimDailyCredit(GATEWAY, "sess-token", { fetchImpl });
  assert.deepEqual(result, {
    ok: true,
    status: 200,
    payload: { should_show: true, credits: 20 },
  });
  const call = fetchImpl.calls[0];
  assert.equal(call.url, claimPath(GATEWAY));
  assert.equal(call.init.method, "POST");
  assert.equal(call.init.body, undefined);
  assert.equal(call.init.redirect, "error");
  const headers = new Headers(call.init.headers);
  assert.equal(headers.get("authorization"), "Bearer sess-token");
  assert.match(headers.get("user-agent"), /qoderwork\//);
});

test("checkinOutcome maps the measured responses", () => {
  assert.deepEqual(
    checkinOutcome(
      { ok: true, status: 200, payload: { should_show: true, credits: 20 } },
      { lang: "en" },
    ),
    {
      outcome: "claimed",
      message: "Claimed 20 credits",
    },
  );
  assert.deepEqual(
    checkinOutcome(
      { ok: true, status: 200, payload: { should_show: true, credits: 0 } },
      { lang: "en" },
    ),
    {
      outcome: "ineligible",
      message: "No daily credit available today",
    },
  );
  assert.deepEqual(
    checkinOutcome(
      { ok: true, status: 200, payload: { should_show: false } },
      { lang: "en" },
    ),
    {
      outcome: "ineligible",
      message: "No daily credit available today",
    },
  );
  assert.deepEqual(
    checkinOutcome({ ok: true, status: 200, payload: null }, { lang: "en" }),
    {
      outcome: "ineligible",
      message: "No daily credit available today",
    },
  );
});

test("checkinOutcome maps 404 and 403 to ineligible with the unavailable marker", () => {
  for (const status of [404, 403]) {
    const out = checkinOutcome({ ok: false, status }, { lang: "en" });
    assert.equal(out.outcome, "ineligible");
    assert.equal(
      out.message,
      "Daily credit claim is not offered on this plan or deployment",
    );
    assert.equal(out.unavailable, true);
  }
});

test("checkinOutcome maps auth and server failures", () => {
  assert.deepEqual(checkinOutcome({ ok: false, status: 401 }, { lang: "en" }), {
    outcome: "failed",
    message:
      "The QwenWork sign-in expired. Sign in to the desktop app again, then re-authorize.",
    signIn: "expired",
  });
  assert.deepEqual(checkinOutcome({ ok: false, status: 502 }, { lang: "en" }), {
    outcome: "failed",
    message: "QwenWork upstream answered 502.",
  });
  const network = checkinOutcome(
    { ok: false, status: 0, error: "socket hang-up" },
    { lang: "en" },
  );
  assert.equal(network.outcome, "failed");
  assert.equal(network.message, "socket hang-up");
  assert.equal(
    checkinOutcome({ ok: false, status: 0 }, { lang: "en" }).message,
    "Timed out. Please retry.",
  );
});

test("claimDailyCredit surfaces http and network failures without throwing", async () => {
  const notFound = await claimDailyCredit(GATEWAY, "t", {
    fetchImpl: fakeFetch(() => new Response("", { status: 404 })),
  });
  assert.deepEqual(notFound, {
    ok: false,
    status: 404,
    error:
      "POST https://gateway.qwenwork.ai/api/v1/adapter/user/daily-credit-notice/claim -> HTTP 404",
  });

  const network = await claimDailyCredit(GATEWAY, "t", {
    fetchImpl: async () => {
      throw new Error("ECONNRESET");
    },
  });
  assert.equal(network.ok, false);
  assert.equal(network.status, 0);
  assert.equal(network.error, "ECONNRESET");
});
