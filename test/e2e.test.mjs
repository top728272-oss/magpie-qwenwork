import test from "node:test";
import assert from "node:assert/strict";

import { QwenworkPlugin } from "../index.mjs";

const enabled = process.env.QWENWORK_E2E === "1";

test(
  "live gateway: adopt, catalog, usage, chat and messages",
  { skip: enabled ? false : "set QWENWORK_E2E=1 to run the live gateway test" },
  async () => {
    const hooks = await QwenworkPlugin({}, { lang: "en" });
    const flow = await hooks.auth.methods[0].authorize({}, {});
    assert.equal(flow.method, "auto");
    const login = await flow.callback(undefined, {});
    assert.equal(login.type, "success", login?.error);

    const auth = {
      type: "api",
      key: login.key,
      accountId: login.accountId,
      metadata: login.metadata,
    };
    const getAuth = async () => auth;

    const models = await hooks.provider.models({ models: {} }, { auth });
    const ids = Object.keys(models);
    assert.ok(ids.length >= 9);
    assert.equal(models["qwen3.8-flash"].provider.npm, "@ai-sdk/openai-compatible");
    assert.equal(models["minimax-m3.1-flash"].provider.npm, "@ai-sdk/anthropic");

    const loader = await hooks.auth.loader(getAuth);

    const chat = await loader.fetch(`${loader.baseURL}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "qwen3.8-flash",
        messages: [{ role: "user", content: "Reply with: pong" }],
        max_tokens: 16,
        stream: true,
      }),
    });
    assert.equal(chat.status, 200);
    assert.match(chat.headers.get("content-type") ?? "", /event-stream/);
    const streamText = await chat.text();
    assert.match(streamText, /^data: /m);
    assert.match(streamText, /\[DONE\]/);

    const messages = await loader.fetch(`${loader.baseURL}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "minimax-m3.1-flash",
        max_tokens: 128,
        messages: [{ role: "user", content: "Reply with: pong" }],
      }),
    });
    assert.equal(messages.status, 200);
    const messagesJson = await messages.json();
    assert.ok(Array.isArray(messagesJson.content));
    assert.ok(messagesJson.content.length > 0);

    const usage = await hooks.auth.usage(getAuth);
    assert.ok(usage.plan);
    assert.ok(Number.isFinite(usage.balance));
    assert.equal(usage.windows[0].unit, "credits");
    assert.match(usage.windows[0].display, /remaining/);

    const checkin = await hooks.auth.checkin(getAuth);
    assert.ok(
      ["claimed", "ineligible", "failed"].includes(checkin?.outcome),
      `unexpected checkin outcome: ${checkin?.outcome}`,
    );
    assert.ok(checkin.message);
  },
);
