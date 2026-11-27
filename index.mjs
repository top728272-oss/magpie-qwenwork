import {
  fetchCatalog,
  fallbackModels,
  filterByKeys,
  modelsFromCatalog,
} from "./src/catalog.mjs";
import {
  CATALOG_TTL_MS,
  DEFAULT_MAAS_ORIGIN,
  DEFAULT_OPTIONS,
  FALLBACK_SNAPSHOT_DATE,
  NPM_OPENAI_COMPATIBLE,
  PROVIDER,
  USAGE_TIMEOUT_MS,
  USAGE_TTL_ERR_MS,
  USAGE_TTL_OK_MS,
  VERSION,
} from "./src/constants.mjs";
import { claimDailyCredit, checkinOutcome } from "./src/checkin.mjs";
import { createLoader, sessionHeaders } from "./src/fetch.mjs";
import { ICON_DATA_URI } from "./src/icon.mjs";
import { resolveLang, t } from "./src/i18n.mjs";
import { createMethods } from "./src/login.mjs";
import { accountIdFor, resolveAccountSettings } from "./src/modes.mjs";
import { createSessionStore } from "./src/session.mjs";
import {
  buildUsage,
  buildUsageError,
  fetchAccountContext,
  fetchBalance,
  fetchQuotaUsage,
  fetchWallets,
  normalizeAccountContext,
  normalizeBalance,
  parseCreditBreakdown,
} from "./src/usage.mjs";
import { describeError } from "./src/util.mjs";

export function resolveOptions(input, options) {
  const merged = {
    ...DEFAULT_OPTIONS,
    ...(options && typeof options === "object" ? options : {}),
    ...(input?.magpie?.options && typeof input.magpie.options === "object"
      ? input.magpie.options
      : {}),
    ...(input?.magpie?.option && typeof input.magpie.option === "object"
      ? input.magpie.option
      : {}),
  };
  return {
    ...merged,
    gatewayOrigin: String(
      merged.gatewayOrigin || DEFAULT_OPTIONS.gatewayOrigin,
    ).trim(),
    dataDir: String(merged.dataDir ?? "").trim(),
    allowModelKeys: Array.isArray(merged.allowModelKeys)
      ? merged.allowModelKeys.map((key) => String(key).trim()).filter(Boolean)
      : [],
  };
}

export const QwenworkPlugin = async (input = {}, options = {}) => {
  const opts = resolveOptions(input, options);
  const lang = resolveLang(opts);
  const fetchImpl = globalThis.fetch;
  const catalogCache = new Map();

  const log = async (level, message) => {
    try {
      await input?.client?.app?.log?.({
        body: { service: "magpie-qwenwork", level, message },
      });
    } catch {
      void 0;
    }
    if (opts.debug) console.error(`[magpie-qwenwork] ${level}: ${message}`);
  };

  const sessions = createSessionStore({
    options: opts,
    deps: {
      fetchImpl,
      onMint: (event) => {
        log(
          "info",
          `maas key minted: base ${event.baseUrl}, expires ${new Date(event.expiresAtMs).toISOString()}`,
        );
      },
    },
  });

  async function loadCatalog(settings, token, { force = false } = {}) {
    const key = settings.gatewayOrigin;
    const hit = catalogCache.get(key);
    if (hit && !force && Date.now() - hit.at < CATALOG_TTL_MS) return hit.value;
    const value = await fetchCatalog(settings.gatewayOrigin, token, {
      fetchImpl,
    });
    catalogCache.set(key, { at: Date.now(), value });
    return value;
  }

  const provider = {
    id: PROVIDER,
    async models(p, ctx = {}) {
      const auth = ctx?.auth;
      const base = p?.models ?? {};
      if (!auth)
        return fallbackModels(base, { allowModelKeys: opts.allowModelKeys });

      const settings = resolveAccountSettings(auth, opts);
      try {
        const session = await sessions.sessionToken(settings);
        const catalog = await loadCatalog(settings, session.token);
        return modelsFromCatalog(
          filterByKeys(catalog.models, opts.allowModelKeys),
          base,
        );
      } catch (err) {
        if (err?.signIn === "expired") throw err;
        await log(
          "warn",
          `catalog fallback: ${err?.status ?? ""} ${err?.message ?? err}`,
        );
        const out = fallbackModels(base, {
          allowModelKeys: opts.allowModelKeys,
        });
        out[Symbol.for("magpie.fellBack")] = true;
        return out;
      }
    },
  };

  const usageCache = new Map();
  const walletsDead = new Set();
  const checkinDead = new Set();

  async function usage(getAuth) {
    const auth = await getAuth();
    const settings = resolveAccountSettings(auth, opts);
    const key = accountIdFor({ email: settings.email, token: settings.key });

    const cached = usageCache.get(key);
    if (cached && Date.now() - cached.at < cached.ttl) return cached.value;

    let value;
    try {
      const session = await sessions.sessionToken(settings);
      const [context, balance, breakdown, wallets] = await Promise.all([
        fetchAccountContext(settings.gatewayOrigin, session.token, {
          fetchImpl,
          timeoutMs: USAGE_TIMEOUT_MS,
        })
          .then(normalizeAccountContext)
          .catch(() => null),
        fetchBalance(settings.gatewayOrigin, session.token, {
          fetchImpl,
          timeoutMs: USAGE_TIMEOUT_MS,
        })
          .then(normalizeBalance)
          .catch(() => null),
        fetchQuotaUsage(settings.gatewayOrigin, session.token, {
          fetchImpl,
          timeoutMs: USAGE_TIMEOUT_MS,
        })
          .then(parseCreditBreakdown)
          .catch(() => null),
        walletsDead.has(key)
          ? Promise.resolve(null)
          : fetchWallets(settings.gatewayOrigin, session.token, {
              fetchImpl,
              timeoutMs: USAGE_TIMEOUT_MS,
            }).then((result) => {
              if (!result.ok && result.permanent) walletsDead.add(key);
              return result.ok ? result.buckets : null;
            }),
      ]);

      if (!context && !balance && !breakdown && !wallets) {
        throw new Error("gateway usage endpoints unavailable");
      }
      value = buildUsage({
        balance: balance?.balance ?? null,
        breakdown,
        wallets,
        context,
        mint: sessions.peek(),
        lang,
      });
      usageCache.set(key, { at: Date.now(), ttl: USAGE_TTL_OK_MS, value });
    } catch (err) {
      await log(
        "warn",
        `usage unavailable: ${err?.status ?? ""} ${err?.message ?? err}`,
      );
      value = buildUsageError(describeError(err, { lang }), lang);
      usageCache.set(key, { at: Date.now(), ttl: USAGE_TTL_ERR_MS, value });
    }
    return value;
  }

  async function checkin(getAuth) {
    const auth = await getAuth();
    const settings = resolveAccountSettings(auth, opts);
    const key = accountIdFor({ email: settings.email, token: settings.key });

    if (checkinDead.has(key)) {
      return { outcome: "ineligible", message: t(lang, "checkinUnavailable") };
    }

    let result;
    try {
      const session = await sessions.sessionToken(settings);
      result = await claimDailyCredit(settings.gatewayOrigin, session.token, {
        fetchImpl,
        timeoutMs: USAGE_TIMEOUT_MS,
      });
    } catch (err) {
      return { outcome: "failed", message: describeError(err, { lang }) };
    }

    const out = checkinOutcome(result, { lang });
    if (out.unavailable) {
      checkinDead.add(key);
      delete out.unavailable;
    }
    if (out.outcome === "claimed") usageCache.delete(key);
    return out;
  }

  return {
    config: async (cfg) => {
      cfg.provider ??= {};
      cfg.provider[PROVIDER] ??= {
        name: t(lang, "providerName"),
        npm: NPM_OPENAI_COMPATIBLE,
        api: `${DEFAULT_MAAS_ORIGIN}/v1`,
        models: fallbackModels({}, { allowModelKeys: opts.allowModelKeys }),
      };
    },

    auth: {
      provider: PROVIDER,
      methods: createMethods({ options: opts, deps: { fetchImpl } }),
      loader: async (getAuth) =>
        createLoader(getAuth, opts, { fetchImpl, sessions }),
      usage,
      checkin,
      icon: ICON_DATA_URI,
    },

    provider,

    "chat.headers": async (hookInput, output) => {
      if (hookInput?.model?.providerID !== PROVIDER) return;
      Object.assign(output.headers, sessionHeaders(hookInput?.sessionID));
    },
  };
};

export const _internal = {
  resolveOptions,
  resolveAccountSettings,
  accountIdFor,
  createMethods,
  createSessionStore,
  createLoader,
  claimDailyCredit,
  checkinOutcome,
  fetchAccountContext,
  fetchBalance,
  fetchQuotaUsage,
  fetchWallets,
  fetchCatalog,
  fallbackModels,
  modelsFromCatalog,
  normalizeAccountContext,
  normalizeBalance,
  parseCreditBreakdown,
  buildUsage,
  buildUsageError,
  sessionHeaders,
  describeError,
  FALLBACK_SNAPSHOT_DATE,
  ICON_DATA_URI,
  VERSION,
};
