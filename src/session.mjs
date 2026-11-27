import {
  FILE_CACHE_TTL_MS,
  GATEWAY,
  MODE_ADOPT,
  MODE_PASTE,
  MINT_PATH,
  MINT_TIMEOUT_MS,
  MINT_TTL_MS,
  REFRESH_BEFORE_MS,
  SESSION_FRESH_MARGIN_MS,
} from "./constants.mjs";
import { readAuthDocument } from "./credentials.mjs";
import { HttpError, desktopHeaders, fetchJson } from "./http.mjs";
import { resolveLang, t } from "./i18n.mjs";
import { isFresh, toNumber, trimSlash } from "./util.mjs";

export function mintUrl(origin) {
  return `${trimSlash(origin || GATEWAY)}${MINT_PATH}`;
}

export function signInError(lang = "zh", { reason = "", path = "" } = {}) {
  const message = path
    ? t(lang, "errBadCredentials", { path, reason: reason || "invalid" })
    : t(lang, "errNoCredentials", { path: path || "-" });
  const err = new Error(message);
  err.name = "SignInError";
  err.status = 401;
  err.signIn = "expired";
  return err;
}

export function expiredError(lang = "zh") {
  const err = new Error(t(lang, "errSignInExpired"));
  err.name = "SignInError";
  err.status = 401;
  err.signIn = "expired";
  err.code = "ACCESS_TOKEN_EXPIRED";
  return err;
}

export function unsupportedError(lang = "zh") {
  const err = new Error(t(lang, "errMintUnsupported"));
  err.name = "UnsupportedError";
  err.status = 503;
  err.code = "DESKTOP_MAAS_UNSUPPORTED";
  return err;
}

export function createSessionStore({ options = {}, deps = {} } = {}) {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const now = deps.now ?? (() => Date.now());
  const readDoc = deps.readDoc ?? readAuthDocument;
  const onMint = deps.onMint;
  const lang = resolveLang(options);

  let cached = null;
  let inflight = null;
  let docCache = null;

  async function readState(settings, { force = false } = {}) {
    if (!force && docCache && now() - docCache.at < FILE_CACHE_TTL_MS)
      return docCache.value;
    const value = await readDoc({
      explicitDir: settings.dataDir,
      env: deps.env ?? process.env,
      home: deps.home,
    });
    docCache = { at: now(), value };
    return value;
  }

  async function sessionToken(settings, { force = false } = {}) {
    if (settings.mode === MODE_PASTE) {
      if (!settings.key) throw expiredError(lang);
      return {
        token: settings.key,
        expiresAt: 0,
        email: settings.email,
        plan: settings.plan,
        source: MODE_PASTE,
      };
    }

    const found = await readState(settings, { force });
    if (
      found.ok &&
      isFresh(found.state.expiresAt, SESSION_FRESH_MARGIN_MS, now())
    ) {
      return {
        token: found.state.token,
        expiresAt: found.state.expiresAt,
        email: found.state.email || settings.email,
        plan: found.state.plan || settings.plan,
        source: MODE_ADOPT,
      };
    }
    if (settings.key) {
      return {
        token: settings.key,
        expiresAt: 0,
        email: settings.email,
        plan: settings.plan,
        source: "stored",
      };
    }
    throw signInError(lang, found);
  }

  async function mint(settings) {
    const session = await sessionToken(settings);
    const payload = await fetchJson(mintUrl(settings.gatewayOrigin), {
      method: "POST",
      headers: {
        ...desktopHeaders(session.token),
        "Content-Type": "application/json",
      },
      body: {},
      fetchImpl,
      timeoutMs: MINT_TIMEOUT_MS,
    });
    const accessKey = String(payload?.access_token ?? "").trim();
    const baseUrl = trimSlash(payload?.base_url ?? "");
    if (!accessKey || !baseUrl) throw new Error("invalid-mint-response");
    const ttl = toNumber(payload?.ttl_ms, MINT_TTL_MS);
    return {
      accessKey,
      baseUrl,
      sessionId: String(payload?.session_id ?? "").trim(),
      expiresAtMs: toNumber(payload?.expires_at_ms, 0) || now() + ttl,
      sessionExpiresAt: session.expiresAt,
      email: session.email,
      plan: session.plan,
      source: session.source,
    };
  }

  async function ensureFreshAccessKey(settings, { force = false } = {}) {
    if (
      !force &&
      cached &&
      isFresh(cached.expiresAtMs, REFRESH_BEFORE_MS, now())
    )
      return cached;
    if (inflight) return inflight;

    const task = (async () => {
      try {
        const value = await mint(settings);
        cached = value;
        try {
          onMint?.({
            baseUrl: value.baseUrl,
            expiresAtMs: value.expiresAtMs,
            sessionId: value.sessionId,
          });
        } catch {
          void 0;
        }
        return value;
      } catch (err) {
        if (err instanceof HttpError && err.status === 503)
          throw unsupportedError(lang);
        if (err instanceof HttpError && [401, 403].includes(err.status))
          throw expiredError(lang);
        throw err;
      } finally {
        inflight = null;
      }
    })();

    inflight = task;
    return task;
  }

  function peek() {
    return cached && isFresh(cached.expiresAtMs, 0, now()) ? cached : null;
  }

  function clear() {
    cached = null;
    inflight = null;
    docCache = null;
  }

  return { sessionToken, ensureFreshAccessKey, peek, clear };
}
