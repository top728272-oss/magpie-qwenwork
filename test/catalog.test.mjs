import test from "node:test";
import assert from "node:assert/strict";

import {
  dedupeEntries,
  fallbackModels,
  fetchCatalog,
  filterByKeys,
  modelsFromCatalog,
  normalizeCatalog,
  normalizeEntry,
  toMagpieModel,
} from "../src/catalog.mjs";
import { NPM_ANTHROPIC, NPM_OPENAI_COMPATIBLE } from "../src/constants.mjs";
import { catalogEntry, catalogPayload, fakeFetch } from "./helpers.mjs";

const SAMPLE = catalogPayload([
  catalogEntry({ key: "qwen3.8-flash", is_default: true, price_factor: 0.1 }),
  catalogEntry({
    key: "glm-5.3",
    i18n: { display_name: { en: "Pro" }, description: { en: "" } },
    price_factor: 1,
    is_vl: false,
  }),
  catalogEntry({ key: "gpt-6.1-sol" }),
  catalogEntry({
    key: "qwen4-max",
    format: "anthropic/messages",
    frontier: true,
    price_factor: 1.4,
  }),
  catalogEntry({
    key: "qwen3.8-flash",
    frontier: true,
    price_factor: 0.1,
    i18n: { display_name: { en: "Qwen3.8-Flash" }, description: { en: "" } },
  }),
  catalogEntry({
    key: "glm-5.3",
    frontier: true,
    price_factor: 1.3,
    i18n: { display_name: { en: "GLM-5.3" }, description: { en: "" } },
  }),
  catalogEntry({ key: "glm-5.3-flash" }),
  catalogEntry({ key: "disabled-one", enable: false }),
  catalogEntry({ key: "" }),
]);

test("normalizeEntry maps catalog fields and defaults", () => {
  const entry = normalizeEntry(catalogEntry());
  assert.equal(entry.key, "qwen3.8-flash");
  assert.equal(entry.name, "Qwen3.8-Flash");
  assert.equal(entry.description, "Fast and light");
  assert.equal(entry.format, "openai/chat-completions");
  assert.equal(entry.priceFactor, 1);
  assert.equal(entry.reasoning, true);
  assert.equal(entry.vl, true);
  assert.equal(entry.maxInputTokens, 1000000);
  assert.equal(entry.enable, true);

  const anthropic = normalizeEntry(
    catalogEntry({
      format: "anthropic/messages",
      is_reasoning: false,
      is_vl: false,
    }),
  );
  assert.equal(anthropic.format, "anthropic/messages");
  assert.equal(anthropic.reasoning, false);
  assert.equal(anthropic.vl, false);

  const broken = normalizeEntry(catalogEntry({ key: "" }));
  assert.equal(broken, null);
});

test("normalizeCatalog drops disabled entries and keeps the first per key", () => {
  const duplicates = [];
  const catalog = normalizeCatalog(SAMPLE, {
    onDuplicate: (event) => duplicates.push(event),
  });
  assert.equal(catalog.schemaVersion, 2);
  assert.deepEqual(
    catalog.models.map((m) => m.key),
    ["qwen3.8-flash", "glm-5.3", "gpt-6.1-sol", "qwen4-max", "glm-5.3-flash"],
  );
  assert.equal(catalog.duplicates, 2);
  assert.equal(duplicates.length, 2);
  assert.equal(duplicates[0].key, "qwen3.8-flash");
});

test("dedupeEntries keeps the first occurrence in server order", () => {
  const entries = [
    { key: "a", priceFactor: 1 },
    { key: "a", priceFactor: 2 },
    { key: "b", priceFactor: 1 },
  ];
  const out = dedupeEntries(entries);
  assert.deepEqual(
    out.map((entry) => entry.priceFactor),
    [1, 1],
  );
});

test("toMagpieModel follows the mapping contract", () => {
  const chat = toMagpieModel(normalizeEntry(catalogEntry()));
  assert.equal(chat.id, "qwen3.8-flash");
  assert.equal(chat.name, "Qwen3.8-Flash");
  assert.equal(chat.limit.context, 1000000);
  assert.equal(chat.limit.output, undefined);
  assert.equal(chat.reasoning, true);
  assert.equal(chat.tool_call, true);
  assert.deepEqual(chat.modalities.input, ["text", "image"]);
  assert.equal(chat.capabilities.attachment, true);
  assert.deepEqual(chat.capabilities.input, { text: true, image: true });
  assert.equal(chat.provider.npm, NPM_OPENAI_COMPATIBLE);
  assert.equal(chat.description, "Fast and light");

  const priced = toMagpieModel(
    normalizeEntry(catalogEntry({ price_factor: 2.6 })),
  );
  assert.match(priced.description, /Credits: 2.6x per request/);

  const textOnly = toMagpieModel(
    normalizeEntry(catalogEntry({ is_vl: false })),
  );
  assert.deepEqual(textOnly.modalities.input, ["text"]);
  assert.equal(textOnly.capabilities.attachment, false);
  assert.deepEqual(textOnly.capabilities.input, { text: true, image: false });

  const anthropic = toMagpieModel(
    normalizeEntry(
      catalogEntry({ format: "anthropic/messages", price_factor: 1 }),
    ),
  );
  assert.equal(anthropic.provider.npm, NPM_ANTHROPIC);

  const withBase = toMagpieModel(normalizeEntry(catalogEntry()), {
    cost: { input: 1 },
  });
  assert.deepEqual(withBase.cost, { input: 1 });
});

test("modelsFromCatalog keys by catalog key and merges base entries", () => {
  const models = modelsFromCatalog(normalizeCatalog(SAMPLE).models, {
    "glm-5.3": { note: "user" },
  });
  assert.equal(models["glm-5.3"].note, "user");
  assert.equal(Object.keys(models).length, 5);
});

test("filterByKeys applies the allowModelKeys filter", () => {
  const entries = normalizeCatalog(SAMPLE).models;
  assert.deepEqual(
    filterByKeys(entries, ["glm-5.3", " nope "]).map((entry) => entry.key),
    ["glm-5.3"],
  );
  assert.equal(filterByKeys(entries, []).length, entries.length);
  assert.equal(filterByKeys(entries, "not-an-array").length, entries.length);
});

test("fallbackModels matches the measured snapshot", () => {
  const models = fallbackModels({});
  assert.equal(Object.keys(models).length, 9);
  assert.equal(models["qwen3.8-flash"].name, "Standard");
  assert.equal(models["glm-5.3"].name, "Pro");
  assert.equal(models["qwen4-max"].provider.npm, NPM_ANTHROPIC);
  assert.equal(models["minimax-m3.1-flash"].provider.npm, NPM_ANTHROPIC);
  assert.equal(models["kimi-k3.1-pro"].limit.context, 1000000);
  assert.equal(
    models["glm-5.3-flash"].modalities.input.includes("image"),
    true,
  );
  assert.equal(
    models["deepseek-flash"].modalities.input.includes("image"),
    false,
  );
});

test("fetchCatalog requests the chat-modes endpoint with the session token", async () => {
  const fetchImpl = fakeFetch(() => jsonResponseOk(SAMPLE));
  const catalog = await fetchCatalog(
    "https://gateway.qwenwork.ai/",
    "sess-token",
    {
      fetchImpl,
    },
  );
  const call = fetchImpl.calls[0];
  assert.equal(call.url, "https://gateway.qwenwork.ai/api/desktop/chat-modes");
  const headers = new Headers(call.init.headers);
  assert.equal(headers.get("authorization"), "Bearer sess-token");
  assert.match(headers.get("user-agent"), /qoderwork\//);
  assert.equal(call.init.redirect, "error");
  assert.equal(catalog.models.length, 5);
});

test("fetchCatalog rejects an empty catalog", async () => {
  const fetchImpl = fakeFetch(() => jsonResponseOk(catalogPayload([])));
  await assert.rejects(
    () => fetchCatalog("https://gateway.qwenwork.ai", "t", { fetchImpl }),
    /empty catalog/,
  );
});

function jsonResponseOk(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
