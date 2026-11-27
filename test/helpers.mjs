import { createCipheriv, randomBytes } from "node:crypto";

export function b64url(value) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

export function makeJwt({
  exp = Math.floor(Date.now() / 1000) + 3600,
  email = "user@example.com",
  sub = "user-1",
  type = "access",
} = {}) {
  const header = b64url({ alg: "none", typ: "JWT" });
  const payload = b64url({
    exp,
    email,
    sub,
    iss: "qwenwork",
    type,
  });
  return `${header}.${payload}.signature`;
}

export function makeAuthDoc({
  token = makeJwt(),
  expiresAt = new Date(Date.now() + 3600_000).toISOString(),
  email = "user@example.com",
  plan = "Free",
  identityVersion = 0,
  refreshToken = "refresh-1",
} = {}) {
  return {
    schemaVersion: 2,
    authRealm: "standard",
    identityVersion,
    endpoints: {
      authOrigin: "https://gateway.qwenwork.ai",
      apiOrigin: "https://gateway.qwenwork.ai",
    },
    token,
    refreshToken,
    expiresAt,
    user: { id: "u-1", email, tier: plan, planName: plan },
    loginMethod: "browser",
    refreshStrategy: "device_token",
  };
}

export function makeEncryptedBlob(plain, key = randomBytes(32)) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const ct = Buffer.concat([cipher.update(Buffer.from(plain, "utf8")), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    key,
    blob: Buffer.concat([Buffer.from("v10", "latin1"), nonce, ct, tag]),
  };
}

export function makeLocalState(key) {
  return {
    os_crypt: {
      encrypted_key: Buffer.concat([Buffer.from("DPAPI", "latin1"), key]).toString("base64"),
    },
  };
}

export function memIo(files = {}) {
  const map = new Map(
    Object.entries(files).map(([path, content]) => [
      String(path),
      Buffer.isBuffer(content) ? content : Buffer.from(JSON.stringify(content), "utf8"),
    ]),
  );
  return {
    map,
    exists: (path) => map.has(String(path)),
    isFile: (path) => map.has(String(path)),
    read: (path) => {
      const value = map.get(String(path));
      if (value === undefined) throw new Error(`missing: ${path}`);
      return value;
    },
  };
}

export function fakeFetch(handler) {
  const calls = [];
  const impl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init, calls.length);
  };
  impl.calls = calls;
  return impl;
}

export function jsonResponse(body, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

export function mintResponse({
  accessKey = "minted-key-1",
  baseUrl = "https://api1.qwenwork.ai",
  ttlMs = 7_200_000,
  expiresAtMs = Date.now() + 7_200_000,
  sessionId = "sid-1",
} = {}) {
  return jsonResponse(
    {
      access_token: accessKey,
      base_url: baseUrl,
      ttl_ms: ttlMs,
      expires_at_ms: expiresAtMs,
      session_id: sessionId,
    },
    { status: 201 },
  );
}

export function catalogPayload(entries) {
  return { schema_version: 2, catalog: entries };
}

export function catalogEntry(overrides = {}) {
  return {
    key: "qwen3.8-flash",
    i18n: {
      display_name: { en: "Qwen3.8-Flash" },
      description: { en: "Fast and light" },
    },
    is_default: false,
    frontier: false,
    price_factor: 1,
    enable: true,
    format: "openai/chat-completions",
    source: "system",
    is_reasoning: true,
    is_vl: true,
    max_input_tokens: 1000000,
    ...overrides,
  };
}

export const NOW = 1_800_000_000_000;
