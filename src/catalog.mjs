import {
  CATALOG_PATH,
  CATALOG_TIMEOUT_MS,
  FALLBACK_MODELS,
  FORMAT_ANTHROPIC,
  FORMAT_OPENAI,
  NPM_ANTHROPIC,
  NPM_OPENAI_COMPATIBLE,
} from "./constants.mjs";
import { desktopHeaders, fetchJson } from "./http.mjs";
import { toNumber, trimSlash } from "./util.mjs";

export function normalizeEntry(raw) {
  const key = String(raw?.key ?? "").trim();
  if (!key) return null;
  return {
    key,
    name: String(raw?.i18n?.display_name?.en ?? "").trim() || key,
    description: String(raw?.i18n?.description?.en ?? "").trim(),
    format:
      String(raw?.format ?? "").trim() === FORMAT_ANTHROPIC
        ? FORMAT_ANTHROPIC
        : FORMAT_OPENAI,
    priceFactor: toNumber(raw?.price_factor, 1),
    frontier: Boolean(raw?.frontier),
    isDefault: Boolean(raw?.is_default),
    reasoning:
      raw?.is_reasoning === undefined ? true : Boolean(raw?.is_reasoning),
    vl: Boolean(raw?.is_vl),
    maxInputTokens: toNumber(raw?.max_input_tokens, 0),
    enable: raw?.enable === undefined ? true : Boolean(raw.enable),
  };
}

export function dedupeEntries(entries, { onDuplicate } = {}) {
  const seen = new Map();
  const out = [];
  for (const entry of entries) {
    const first = seen.get(entry.key);
    if (first) {
      onDuplicate?.({ key: entry.key, kept: first, dropped: entry });
      continue;
    }
    seen.set(entry.key, entry);
    out.push(entry);
  }
  return out;
}

export function normalizeCatalog(payload, { onDuplicate } = {}) {
  const raw = Array.isArray(payload?.catalog)
    ? payload.catalog
    : Array.isArray(payload?.modes)
      ? payload.modes
      : [];
  const enabled = raw
    .map(normalizeEntry)
    .filter(Boolean)
    .filter((entry) => entry.enable);
  const duplicates = [];
  const models = dedupeEntries(enabled, {
    onDuplicate: (event) => {
      duplicates.push(event);
      onDuplicate?.(event);
    },
  });
  return {
    schemaVersion: toNumber(payload?.schema_version, 0),
    models,
    duplicates: duplicates.length,
  };
}

export function toMagpieModel(entry, base = {}) {
  const out = {
    ...base,
    id: entry.key,
    name: entry.name || entry.key,
    limit: {
      context: entry.maxInputTokens || base?.limit?.context || 0,
    },
    reasoning: entry.reasoning,
    tool_call: true,
    modalities: { input: entry.vl ? ["text", "image"] : ["text"] },
    capabilities: {
      reasoning: entry.reasoning,
      toolcall: true,
      attachment: entry.vl,
      input: { text: true, image: entry.vl },
    },
    provider: {
      ...(base?.provider ?? {}),
      npm:
        entry.format === FORMAT_ANTHROPIC
          ? NPM_ANTHROPIC
          : NPM_OPENAI_COMPATIBLE,
    },
  };
  const description = buildDescription(entry);
  if (description) out.description = description;
  return out;
}

function buildDescription(entry) {
  const parts = [];
  if (entry.description) parts.push(entry.description);
  if (entry.priceFactor && entry.priceFactor !== 1)
    parts.push(`Credits: ${entry.priceFactor}x per request`);
  return parts.join(" | ");
}

export function modelsFromCatalog(entries, baseModels = {}) {
  const out = {};
  for (const entry of entries) {
    out[entry.key] = toMagpieModel(entry, baseModels?.[entry.key] ?? {});
  }
  return out;
}

export function filterByKeys(entries, allowModelKeys = []) {
  const allowed = Array.isArray(allowModelKeys)
    ? allowModelKeys.map((key) => String(key).trim()).filter(Boolean)
    : [];
  if (allowed.length === 0) return entries;
  const set = new Set(allowed);
  return entries.filter((entry) => set.has(entry.key));
}

export function fallbackEntries({ allowModelKeys = [] } = {}) {
  return filterByKeys(FALLBACK_MODELS, allowModelKeys);
}

export function fallbackModels(baseModels = {}, { allowModelKeys = [] } = {}) {
  return modelsFromCatalog(fallbackEntries({ allowModelKeys }), baseModels);
}

export async function fetchCatalog(
  origin,
  token,
  { fetchImpl = globalThis.fetch, timeoutMs = CATALOG_TIMEOUT_MS } = {},
) {
  const payload = await fetchJson(`${trimSlash(origin || "")}${CATALOG_PATH}`, {
    headers: desktopHeaders(token),
    fetchImpl,
    timeoutMs,
  });
  const catalog = normalizeCatalog(payload);
  if (catalog.models.length === 0) throw new Error("empty catalog");
  return catalog;
}
