import test from "node:test";
import assert from "node:assert/strict";
import { createDecipheriv, randomBytes } from "node:crypto";
import { join } from "node:path";

import {
  appDataDir,
  authFilePath,
  expandHome,
  localStatePath,
  osCryptDecrypt,
  osCryptKey,
  parseAuthDocument,
  parseTimestamp,
  powerShellUnprotect,
  readAuthDocument,
  readLocalState,
  sessionStateOf,
} from "../src/credentials.mjs";
import {
  makeAuthDoc,
  makeEncryptedBlob,
  makeLocalState,
  memIo,
} from "./helpers.mjs";

const DIR = "/data/QwenWork";
const AUTH = join(DIR, "auth-v2.dat");
const STATE = join(DIR, "Local State");

function encryptDoc(plain, key = randomBytes(32)) {
  const { blob } = makeEncryptedBlob(plain, key);
  return { blob, key };
}

function windowsFiles({ doc, key = randomBytes(32), authFile = AUTH } = {}) {
  const { blob, key: realKey } = encryptDoc(JSON.stringify(doc), key);
  return {
    key: realKey,
    io: memIo({
      [authFile]: blob,
      [STATE]: makeLocalState(realKey),
    }),
  };
}

test("osCryptDecrypt round-trips a v10 blob", () => {
  const key = randomBytes(32);
  const { blob } = makeEncryptedBlob("{\"token\":\"t\"}", key);
  const plain = osCryptDecrypt(blob, key);
  assert.equal(plain.toString("utf8"), '{"token":"t"}');
});

test("osCryptDecrypt rejects a wrong key and a bad prefix", () => {
  const key = randomBytes(32);
  const { blob } = makeEncryptedBlob("hello", key);
  assert.throws(() => osCryptDecrypt(blob, randomBytes(32)), /decipher|Unsupported|auth/);
  assert.throws(
    () => osCryptDecrypt(Buffer.from("XYZ-not-a-blob"), key),
    /unexpected os_crypt prefix/,
  );
});

test("parseTimestamp reads ISO strings and epoch numbers", () => {
  assert.equal(parseTimestamp("2026-12-04T15:24:09Z"), Date.parse("2026-12-04T15:24:09Z"));
  assert.equal(parseTimestamp(1795805297000), 1795805297000);
  assert.equal(parseTimestamp(""), 0);
  assert.equal(parseTimestamp("garbage"), 0);
});

test("sessionStateOf maps the auth document fields", () => {
  const doc = makeAuthDoc({ email: "a@b.c", plan: "Free" });
  const state = sessionStateOf(doc);
  assert.equal(state.email, "a@b.c");
  assert.equal(state.plan, "Free");
  assert.equal(state.authRealm, "standard");
  assert.equal(state.identityVersion, 0);
  assert.ok(state.token.length > 0);
  assert.ok(state.expiresAt > Date.now());

  const tierOnly = sessionStateOf({ token: "x", user: { tier: "Pro" } });
  assert.equal(tierOnly.plan, "Pro");
});

test("readAuthDocument decrypts auth-v2.dat with an injected unprotect", async () => {
  const key = randomBytes(32);
  const { blob } = encryptDoc(JSON.stringify(makeAuthDoc({ token: "tok-1" })), key);
  const io = memIo({ [AUTH]: blob, [STATE]: makeLocalState(key) });
  const found = await readAuthDocument({
    explicitDir: DIR,
    io,
    platform: "win32",
    deps: { unprotect: () => key },
  });
  assert.equal(found.ok, true);
  assert.equal(found.state.token, "tok-1");
  assert.equal(found.state.email, "user@example.com");
});

test("readAuthDocument falls back to plaintext JSON (dev mode)", async () => {
  const io = memIo({ [AUTH]: makeAuthDoc({ token: "plain-tok" }) });
  const found = await readAuthDocument({
    explicitDir: DIR,
    io,
    platform: "win32",
    deps: { unprotect: () => randomBytes(32) },
  });
  assert.equal(found.ok, true);
  assert.equal(found.state.token, "plain-tok");
});

test("readAuthDocument reports an unsupported platform without an injected unprotect", async () => {
  const io = memIo({ [AUTH]: makeAuthDoc() });
  const found = await readAuthDocument({
    explicitDir: DIR,
    io,
    platform: "darwin",
  });
  assert.equal(found.ok, false);
  assert.equal(found.reason, "unsupported-platform");
});

test("readAuthDocument rejects multi-identity installs", async () => {
  const { io, key } = windowsFiles({
    doc: makeAuthDoc({ identityVersion: 2 }),
  });
  const found = await readAuthDocument({
    explicitDir: DIR,
    io,
    platform: "win32",
    deps: { unprotect: () => key },
  });
  assert.equal(found.ok, false);
  assert.equal(found.reason, "identity-unsupported");
  assert.equal(found.identityVersion, 2);
});

test("readAuthDocument reports missing files and token-less documents", async () => {
  const missing = await readAuthDocument({
    explicitDir: DIR,
    io: memIo({}),
    platform: "win32",
    deps: { unprotect: () => randomBytes(32) },
  });
  assert.equal(missing.ok, false);
  assert.deepEqual(missing.tried, [AUTH]);

  const noToken = await readAuthDocument({
    explicitDir: DIR,
    io: memIo({ [AUTH]: Buffer.from(JSON.stringify({ schemaVersion: 2 })) }),
    platform: "win32",
    deps: { unprotect: () => randomBytes(32) },
  });
  assert.equal(noToken.ok, false);
  assert.equal(noToken.reason, "no-token");
});

test("readAuthDocument reports a corrupt ciphertext", async () => {
  const key = randomBytes(32);
  const { blob } = encryptDoc(JSON.stringify(makeAuthDoc()), key);
  const corrupted = Buffer.from(blob);
  corrupted[corrupted.length - 1] ^= 0xff;
  const found = await readAuthDocument({
    explicitDir: DIR,
    io: memIo({ [AUTH]: corrupted, [STATE]: makeLocalState(key) }),
    platform: "win32",
    deps: { unprotect: () => key },
  });
  assert.equal(found.ok, false);
  assert.match(found.reason, /^decrypt:/);
});

test("readLocalState validates the DPAPI prefix", () => {
  const good = readLocalState({
    explicitDir: DIR,
    io: memIo({ [STATE]: makeLocalState(randomBytes(32)) }),
  });
  assert.equal(good.ok, true);
  assert.equal(good.blob.length, 32);

  const bad = readLocalState({
    explicitDir: DIR,
    io: memIo({
      [STATE]: Buffer.from(
        JSON.stringify({ os_crypt: { encrypted_key: Buffer.from("nope").toString("base64") } }),
      ),
    }),
  });
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, "missing-dpapi-prefix");
});

test("osCryptKey validates the 32-byte key length", async () => {
  await assert.rejects(
    () =>
      osCryptKey({
        explicitDir: DIR,
        io: memIo({ [STATE]: makeLocalState(randomBytes(32)) }),
        deps: { unprotect: () => Buffer.alloc(16, 1) },
      }),
    (err) => err.code === "BAD_KEY_LENGTH",
  );
});

test("osCryptKey reports an unavailable Local State", async () => {
  await assert.rejects(
    () =>
      osCryptKey({
        explicitDir: DIR,
        io: memIo({}),
        deps: {},
      }),
    (err) => err.code === "LOCAL_STATE_UNAVAILABLE",
  );
});

test("path helpers resolve APPDATA, QWENWORK_HOME and tilde", () => {
  assert.equal(
    authFilePath({ explicitDir: "", env: { APPDATA: "/r" }, home: "/h" }),
    join("/r", "QwenWork", "auth-v2.dat"),
  );
  assert.equal(
    authFilePath({ explicitDir: "", env: { QWENWORK_HOME: "/custom" }, home: "/h" }),
    join("/custom", "auth-v2.dat"),
  );
  assert.equal(
    authFilePath({ explicitDir: "", env: {}, home: "/h" }),
    join("/h", "AppData", "Roaming", "QwenWork", "auth-v2.dat"),
  );
  assert.equal(
    localStatePath({ explicitDir: "/d", env: {}, home: "/h" }),
    join("/d", "Local State"),
  );
  assert.equal(expandHome("~/x", "/h"), join("/h", "x"));
  assert.equal(appDataDir({ env: { APPDATA: "~/roam" }, home: "/h" }), join("/h", "roam", "QwenWork"));
});

test("parseAuthDocument reports malformed JSON and shapes", () => {
  assert.throws(() => parseAuthDocument("{oops"), /bad-json/);
  assert.throws(() => parseAuthDocument("[]"), /bad-shape/);
  assert.deepEqual(parseAuthDocument("{}"), {});
});

test("powerShellUnprotect spawns a fixed script and base64-round-trips", async () => {
  const secret = randomBytes(32);
  let stdinValue = "";
  let dataHandler = null;
  let closeHandler = null;
  const spawnImpl = (exe, args, opts) => {
    assert.equal(exe, "powershell.exe");
    assert.deepEqual(args.slice(0, 3), ["-NoProfile", "-STA", "-Command"]);
    assert.equal(opts.windowsHide, true);
    return {
      stdout: {
        on: (event, handler) => {
          if (event === "data") dataHandler = handler;
        },
      },
      stderr: { on: () => {} },
      stdin: {
        write: (data) => {
          stdinValue = data.toString();
        },
        end: () => {
          setImmediate(() => {
            assert.equal(stdinValue, secret.toString("base64"));
            dataHandler?.(Buffer.from(secret.toString("base64")));
            setImmediate(() => closeHandler?.(0));
          });
        },
      },
      kill: () => {},
      on: (event, handler) => {
        if (event === "close") closeHandler = handler;
      },
    };
  };
  const out = await powerShellUnprotect(secret, { spawnImpl });
  assert.deepEqual(out, secret);
});

test("powerShellUnprotect reports a non-zero exit", async () => {
  const spawnImpl = () => ({
    stdout: { on: () => {} },
    stderr: {
      on: (event, handler) => {
        if (event === "data") setImmediate(() => handler(Buffer.from("boom")));
      },
    },
    stdin: { write: () => {}, end: () => {} },
    kill: () => {},
    on: (event, handler) => {
      if (event === "close") setImmediate(() => handler(1));
    },
  });
  await assert.rejects(
    () => powerShellUnprotect(randomBytes(4), { spawnImpl }),
    /dpapi-failed \(1\): boom/,
  );
});
