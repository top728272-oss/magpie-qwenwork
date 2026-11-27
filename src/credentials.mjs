import { spawn } from "node:child_process";
import { createDecipheriv } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  APP_DIR_NAME,
  AUTH_FILE,
  DPAPI_TIMEOUT_MS,
  HOME_ENV_NAME,
  LOCAL_STATE_FILE,
} from "./constants.mjs";
import { parseTimestamp, toNumber } from "./util.mjs";

const DPAPI_PREFIX = "DPAPI";
const POWERSHELL_SCRIPT =
  "$b=[Convert]::FromBase64String([Console]::In.ReadToEnd());" +
  "Add-Type -AssemblyName System.Security;" +
  "$out=[System.Security.Cryptography.ProtectedData]::Unprotect($b,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser);" +
  "[Console]::Out.Write([Convert]::ToBase64String($out))";

function nonEmpty(value) {
  return typeof value === "string" && value.trim() !== "";
}

export function expandHome(value, home = homedir()) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  if (raw === "~") return home;
  if (raw.startsWith("~/") || raw.startsWith("~\\"))
    return join(home, raw.slice(2));
  return raw;
}

export function appDataDir({ env = process.env, home = homedir() } = {}) {
  const override = String(env?.[HOME_ENV_NAME] ?? "").trim();
  if (override) return expandHome(override, home);
  const roaming = String(env?.APPDATA ?? "").trim();
  const base = roaming
    ? expandHome(roaming, home)
    : join(home, "AppData", "Roaming");
  return join(base, APP_DIR_NAME);
}

function resolveDir(explicitDir, env, home) {
  const raw = expandHome(explicitDir, home);
  if (raw) return raw;
  return appDataDir({ env, home });
}

export function authFilePath({
  explicitDir = "",
  env = process.env,
  home = homedir(),
} = {}) {
  return join(resolveDir(explicitDir, env, home), AUTH_FILE);
}

export function localStatePath({
  explicitDir = "",
  env = process.env,
  home = homedir(),
} = {}) {
  return join(resolveDir(explicitDir, env, home), LOCAL_STATE_FILE);
}

export function defaultIo() {
  return {
    exists: (path) => existsSync(path),
    isFile: (path) => {
      try {
        return statSync(path).isFile();
      } catch {
        return false;
      }
    },
    read: (path) => readFileSync(path),
  };
}

function blobFields(len, pointer) {
  const blob = Buffer.alloc(16);
  blob.writeUInt32LE(len >>> 0, 0);
  blob.writeBigUInt64LE(BigInt(pointer), 8);
  return blob;
}

let ffiSymbols = null;

async function bunUnprotect(data) {
  if (!ffiSymbols) {
    const { dlopen, ptr, toBuffer } = await import("bun:ffi");
    ffiSymbols = dlopen("crypt32.dll", {
      CryptUnprotectData: {
        args: ["ptr", "ptr", "ptr", "ptr", "ptr", "u32", "ptr"],
        returns: "i32",
      },
      LocalFree: { args: ["ptr"], returns: "ptr" },
    }).symbols;
  }
  const input = Buffer.from(data);
  const inBlob = blobFields(input.length, ptr(input));
  const outBlob = Buffer.alloc(16);
  const ok = ffiSymbols.CryptUnprotectData(
    ptr(inBlob),
    null,
    null,
    null,
    null,
    0,
    ptr(outBlob),
  );
  if (!ok) throw new Error("CryptUnprotectData failed (bun:ffi)");
  const size = outBlob.readUInt32LE(0);
  const address = outBlob.readBigUInt64LE(8);
  const out = Buffer.from(toBuffer(Number(address)).subarray(0, size));
  ffiSymbols.LocalFree(address);
  return out;
}

export function powerShellUnprotect(
  data,
  { spawnImpl = spawn, timeoutMs = DPAPI_TIMEOUT_MS } = {},
) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(
      "powershell.exe",
      ["-NoProfile", "-STA", "-Command", POWERSHELL_SCRIPT],
      { stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
    );
    let out = "";
    let err = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill();
        reject(new Error("dpapi-timeout"));
      }
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      out += chunk;
    });
    child.stderr.on("data", (chunk) => {
      err += chunk;
    });
    child.on("error", (e) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(e);
      }
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`dpapi-failed (${code}): ${err.slice(0, 200)}`));
        return;
      }
      try {
        resolve(Buffer.from(out.trim(), "base64"));
      } catch (e) {
        reject(e);
      }
    });
    child.stdin.write(Buffer.from(data).toString("base64"));
    child.stdin.end();
  });
}

export async function dpapiUnprotect(data, deps = {}) {
  if (deps.unprotect) return deps.unprotect(data);
  if (process.versions?.bun || globalThis.Bun) {
    try {
      return await bunUnprotect(data);
    } catch {
      void 0;
    }
  }
  return powerShellUnprotect(data);
}

export function readLocalState({ explicitDir = "", env, home, io } = {}) {
  const path = localStatePath({ explicitDir, env, home });
  if (!io.isFile(path)) return { ok: false, path, reason: "missing" };
  let doc;
  try {
    doc = JSON.parse(io.read(path).toString("utf8"));
  } catch (err) {
    return { ok: false, path, reason: `bad-json: ${err?.message ?? err}` };
  }
  const encoded = String(doc?.os_crypt?.encrypted_key ?? "").trim();
  if (!encoded) return { ok: false, path, reason: "missing-encrypted-key" };
  let blob;
  try {
    blob = Buffer.from(encoded, "base64");
  } catch {
    return { ok: false, path, reason: "bad-base64" };
  }
  if (blob.subarray(0, 5).toString("latin1") !== DPAPI_PREFIX)
    return { ok: false, path, reason: "missing-dpapi-prefix" };
  return { ok: true, path, blob: blob.subarray(5) };
}

const keyCache = new Map();

export async function osCryptKey({
  explicitDir = "",
  env = process.env,
  home = homedir(),
  io = defaultIo(),
  deps = {},
} = {}) {
  const cacheable = !deps.unprotect;
  const cacheKey = localStatePath({ explicitDir, env, home });
  if (cacheable && keyCache.has(cacheKey)) return keyCache.get(cacheKey);

  const task = (async () => {
    const state = readLocalState({ explicitDir, env, home, io });
    if (!state.ok) {
      const err = new Error(`local-state: ${state.reason} (${state.path})`);
      err.code = "LOCAL_STATE_UNAVAILABLE";
      throw err;
    }
    const key = await dpapiUnprotect(state.blob, deps);
    if (key.length !== 32) {
      const err = new Error(`unexpected os_crypt key length ${key.length}`);
      err.code = "BAD_KEY_LENGTH";
      throw err;
    }
    return key;
  })();

  if (cacheable) {
    keyCache.set(cacheKey, task);
    task.catch(() => keyCache.delete(cacheKey));
  }
  return task;
}

export function osCryptDecrypt(blob, key) {
  const data = Buffer.from(blob ?? []);
  const head = data.subarray(0, 3).toString("latin1");
  if (head !== "v10" && head !== "v11")
    throw new Error(`unexpected os_crypt prefix ${JSON.stringify(head)}`);
  const decipher = createDecipheriv("aes-256-gcm", key, data.subarray(3, 15));
  decipher.setAuthTag(data.subarray(data.length - 16));
  return Buffer.concat([
    decipher.update(data.subarray(15, data.length - 16)),
    decipher.final(),
  ]);
}

export function parseAuthDocument(raw, path = "") {
  let doc;
  try {
    doc = JSON.parse(String(raw ?? ""));
  } catch (err) {
    throw new Error(`bad-json: ${err?.message ?? "invalid JSON"}`);
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc))
    throw new Error("bad-shape");
  return doc;
}

export { parseTimestamp };

export function sessionStateOf(doc) {
  const user = doc?.user && typeof doc.user === "object" ? doc.user : {};
  const token = String(doc?.token ?? doc?.accessToken ?? "").trim();
  return {
    token,
    expiresAt: parseTimestamp(doc?.expiresAt),
    email: String(user.email ?? "").trim(),
    plan: String(user.planName ?? user.tier ?? "").trim(),
    authRealm: String(doc?.authRealm ?? "").trim(),
    identityVersion: toNumber(doc?.identityVersion, 0),
  };
}

export async function readAuthDocument({
  explicitDir = "",
  env = process.env,
  home = homedir(),
  platform = process.platform,
  io = defaultIo(),
  deps = {},
} = {}) {
  const path = authFilePath({ explicitDir, env, home });
  if (!io.isFile(path)) return { ok: false, tried: [path] };

  if (platform !== "win32" && !deps.unprotect)
    return { ok: false, tried: [path], reason: "unsupported-platform" };

  let blob;
  try {
    blob = io.read(path);
  } catch (err) {
    return {
      ok: false,
      tried: [path],
      path,
      reason: `unreadable: ${err?.message ?? err}`,
    };
  }

  let plain = null;
  const head = blob.subarray(0, 3).toString("latin1");
  if (head === "v10" || head === "v11") {
    let key;
    try {
      key = await osCryptKey({ explicitDir, env, home, io, deps });
    } catch (err) {
      return { ok: false, tried: [path], path, reason: String(err?.message ?? err) };
    }
    try {
      plain = osCryptDecrypt(blob, key);
    } catch (err) {
      return { ok: false, tried: [path], path, reason: `decrypt: ${err?.message ?? err}` };
    }
  } else {
    plain = blob;
  }

  let doc;
  try {
    doc = parseAuthDocument(plain.toString("utf8"), path);
  } catch (err) {
    return { ok: false, tried: [path], path, reason: String(err?.message ?? err) };
  }

  const state = sessionStateOf(doc);
  if (state.identityVersion > 0) {
    return {
      ok: false,
      tried: [path],
      path,
      reason: "identity-unsupported",
      identityVersion: state.identityVersion,
    };
  }
  if (!state.token) return { ok: false, tried: [path], path, reason: "no-token" };
  if (/\s/.test(state.token) || state.token.length > 8192)
    return { ok: false, tried: [path], path, reason: "invalid-token" };

  return { ok: true, tried: [path], path, doc, state };
}

export { nonEmpty };
