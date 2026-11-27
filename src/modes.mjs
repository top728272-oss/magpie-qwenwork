import { GATEWAY, MODE_ADOPT, MODE_PASTE } from "./constants.mjs";
import { sha256Hex, trimSlash } from "./util.mjs";

export function resolveAccountSettings(auth, options = {}) {
  const metadata = auth?.metadata ?? {};
  const mode =
    String(
      metadata.mode ?? (auth?.type === "oauth" ? MODE_ADOPT : MODE_PASTE),
    ).trim() || MODE_PASTE;

  return {
    mode,
    gatewayOrigin: trimSlash(options.gatewayOrigin || GATEWAY),
    dataDir: String(metadata.dataDir ?? options.dataDir ?? "").trim(),
    key: String(auth?.key ?? "").trim(),
    email: String(metadata.email ?? "").trim(),
    plan: String(metadata.plan ?? "").trim(),
  };
}

export function accountIdFor({ email = "", token = "" } = {}) {
  const mail = String(email ?? "")
    .trim()
    .toLowerCase();
  if (mail) return `qwenwork:${sha256Hex(mail).slice(0, 12)}`;
  const raw = String(token ?? "").trim();
  if (raw) return `qwenwork:${sha256Hex(raw).slice(0, 12)}`;
  return "qwenwork:local";
}
