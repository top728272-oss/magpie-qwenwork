import test from "node:test";
import assert from "node:assert/strict";

import { MESSAGES_ALL, detectLang, resolveLang, t } from "../src/i18n.mjs";

test("resolveLang follows an explicit language and detects the system locale otherwise", () => {
  assert.equal(resolveLang({ lang: "en" }), "en");
  assert.equal(resolveLang({ lang: "en-US" }), "en");
  assert.equal(resolveLang({ lang: "zh-CN" }), "zh");
  assert.ok(["zh", "en"].includes(resolveLang({})));
  assert.ok(["zh", "en"].includes(resolveLang({ lang: "auto" })));
});

test("detectLang maps zh locales to Chinese and everything else to English", () => {
  assert.equal(detectLang({ locale: "zh-CN" }), "zh");
  assert.equal(detectLang({ locale: "zh_Hans_CN.UTF-8" }), "zh");
  assert.equal(detectLang({ locale: "en-US" }), "en");
  assert.equal(detectLang({ locale: "C.UTF-8" }), "en");
  assert.equal(detectLang({ locale: "" }), "en");
});

test("t interpolates named variables and falls back to the key", () => {
  assert.equal(
    t("en", "errUpstream", { status: 502 }),
    "QwenWork upstream answered 502.",
  );
  assert.equal(
    t("zh", "errUpstream", { status: 502 }),
    "QwenWork 上游返回 502。",
  );
  assert.equal(t("en", "missing-key"), "missing-key");
  assert.equal(t("en", "errUpstream"), "QwenWork upstream answered {status}.");
});

test("every message key exists in both languages", () => {
  const zh = Object.keys(MESSAGES_ALL.zh).sort();
  const en = Object.keys(MESSAGES_ALL.en).sort();
  assert.deepEqual(en, zh);
});

test("no user-facing message contains an em dash", () => {
  for (const [lang, messages] of Object.entries(MESSAGES_ALL)) {
    for (const [key, value] of Object.entries(messages)) {
      assert.equal(String(value).includes("\u2014"), false, `${lang}.${key}`);
    }
  }
});
