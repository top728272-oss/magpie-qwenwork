import {
  ADOPT_FRESH_MARGIN_MS,
  ADOPT_POLL_MS,
  ADOPT_WAIT_MS,
  GATEWAY,
  MODE_ADOPT,
  MODE_PASTE,
} from "./constants.mjs";
import { successResult, verifySessionToken } from "./auth.mjs";
import { readAuthDocument } from "./credentials.mjs";
import { resolveLang, t } from "./i18n.mjs";
import { describeError, isFresh } from "./util.mjs";

export { successResult, verifySessionToken };

export function pickKey(inputs) {
  for (const name of ["key", "apiKey", "token", "secret", "accessToken"]) {
    const value = inputs?.[name];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

export function authState(found) {
  if (!found?.ok) return { token: "", expiresAt: 0, email: "", plan: "" };
  return {
    token: found.state.token,
    expiresAt: found.state.expiresAt,
    email: found.state.email,
    plan: found.state.plan,
  };
}

export async function waitForAuthDocument({
  explicitDir = "",
  timeoutMs = ADOPT_WAIT_MS,
  pollMs = ADOPT_POLL_MS,
  signal,
  lang = "zh",
  now = () => Date.now(),
  readDoc = readAuthDocument,
  env = process.env,
  home,
  verify,
  onPoll,
} = {}) {
  const deadline = now() + timeoutMs;
  let lastTried = "";
  let triedOk = false;

  while (now() < deadline) {
    if (signal?.aborted) throw new Error("cancelled");

    const found = await readDoc({ explicitDir, env, home });
    if (
      found.ok &&
      isFresh(found.state.expiresAt, ADOPT_FRESH_MARGIN_MS, now())
    ) {
      const token = found.state.token;
      if (token !== lastTried) {
        lastTried = token;
        triedOk = verify ? (await verify(token)).ok : true;
      }
      if (triedOk) return found;
    }
    onPoll?.(found);

    await new Promise((resolve) => {
      setTimeout(resolve, pollMs);
    });
  }

  const err = new Error(t(lang, "errAdoptTimeout"));
  err.status = 408;
  throw err;
}

function adoptMethod({ options, lang, fetchImpl, deps = {} }) {
  const readDoc = deps.readDoc ?? readAuthDocument;
  const now = deps.now ?? (() => Date.now());
  const pollMs = deps.pollMs ?? ADOPT_POLL_MS;
  const waitMs = deps.waitMs ?? ADOPT_WAIT_MS;
  const env = deps.env ?? process.env;
  const home = deps.home;
  const origin = options.gatewayOrigin || GATEWAY;

  return {
    type: "oauth",
    label: t(lang, "loginAdopt"),
    async authorize(_inputs, { signal } = {}) {
      const explicitDir = options.dataDir;

      return {
        url: "https://qwenwork.ai",
        instructions: t(lang, "adoptInstructions"),
        method: "auto",
        async callback(_code, { signal: callbackSignal } = {}) {
          try {
            const found = await waitForAuthDocument({
              explicitDir,
              signal: callbackSignal ?? signal,
              timeoutMs: waitMs,
              lang,
              now,
              pollMs,
              readDoc,
              env,
              home,
              verify: (token) =>
                verifySessionToken(origin, token, { fetchImpl, lang }),
            });
            const next = authState(found);
            const verified = await verifySessionToken(origin, next.token, {
              fetchImpl,
              lang,
            });
            if (!verified.ok) return { type: "failed", error: verified.error };
            return successResult({
              token: next.token,
              email: next.email || verified.context?.email || "",
              plan: next.plan || verified.context?.plan || "",
              mode: MODE_ADOPT,
            });
          } catch (err) {
            return { type: "failed", error: describeError(err, { lang }) };
          }
        },
      };
    },
  };
}

function pasteMethod({ options, lang, fetchImpl }) {
  const origin = options.gatewayOrigin || GATEWAY;
  return {
    type: "api",
    label: t(lang, "loginPaste"),
    placeholder: "eyJhbGciOi...",
    prompts: [
      { type: "password", key: "key", message: t(lang, "promptSessionToken") },
    ],
    async authorize(inputs = {}) {
      const token = pickKey(inputs);
      if (!token) return { type: "failed", error: t(lang, "errKeyMissing") };

      const verified = await verifySessionToken(origin, token, {
        fetchImpl,
        lang,
      });
      if (!verified.ok) return { type: "failed", error: verified.error };

      return successResult({
        token,
        email: verified.context?.email ?? "",
        plan: verified.context?.plan ?? "",
        mode: MODE_PASTE,
      });
    },
  };
}

export function createMethods({ options = {}, deps = {} } = {}) {
  const lang = resolveLang(options);
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  return [
    adoptMethod({ options, lang, fetchImpl, deps }),
    pasteMethod({ options, lang, fetchImpl }),
  ];
}
