import { fetchCatalog, fallbackModels } from "../src/catalog.mjs";
import { readAuthDocument } from "../src/credentials.mjs";
import { formatDuration, maskToken, tokenClaims } from "../src/util.mjs";
import { verifySessionToken } from "../src/auth.mjs";
import {
  fetchBalance,
  fetchUserWallets,
  normalizeBalance,
  parseCreditBreakdown,
  fetchQuotaUsage,
} from "../src/usage.mjs";
import { GATEWAY } from "../src/constants.mjs";

const argv = process.argv.slice(2);

function arg(name, fallback = "") {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : fallback;
}

function maskEmail(email) {
  const [name, domain] = String(email ?? "").split("@");
  if (!domain) return "";
  return `${name.slice(0, 1)}***@${domain}`;
}

const dir = arg("dir", "");

console.log("magpie-qwenwork probe");
console.log(`  gateway: ${GATEWAY}`);

const found = await readAuthDocument({ explicitDir: dir });
if (!found.ok) {
  console.log(
    `  credentials: not available (reason: ${found.reason ?? "missing"}, tried ${found.tried.join(", ")})`,
  );
  console.log(
    "  hint: install and sign in to the QwenWork desktop app, then run the probe again.",
  );
} else {
  const state = found.state;
  const claims = tokenClaims(state.token);
  const expiresAt = state.expiresAt || claims?.expiresAt || 0;
  const left = expiresAt - Date.now();
  console.log(`  credentials: ${found.path}`);
  console.log(
    `  account: ${maskEmail(state.email)} | plan: ${state.plan || "-"} | realm: ${state.authRealm || "-"}`,
  );
  console.log(
    `  token: ${claims?.type || "unknown"} | expires ${new Date(expiresAt).toISOString()} (${left > 0 ? `in ${formatDuration(left, "en")}` : "expired"}) | ${maskToken(state.token)}`,
  );
}

try {
  const fallback = fallbackModels({});
  const anthropic = Object.values(fallback).filter(
    (model) => model.provider?.npm === "@ai-sdk/anthropic",
  ).length;
  console.log(
    `  fallback catalog: 9 models (${9 - anthropic} openai, ${anthropic} anthropic) (snapshot 2026-11-27)`,
  );
  console.log("");
  console.log("  id                      sdk");
  for (const model of Object.values(fallback)) {
    console.log(
      `  ${model.id.padEnd(23)} ${model.provider?.npm ?? ""}`,
    );
  }
} catch (err) {
  console.log(`  fallback catalog: failed (${err?.message ?? err})`);
}

if (argv.includes("--live")) {
  if (!found.ok) {
    console.log("  live: skipped (no credentials)");
  } else {
    try {
      const verified = await verifySessionToken(GATEWAY, found.state.token, {});
      console.log(
        `  live mint: ${verified.ok ? "OK" : `FAILED (${verified.error})`}${verified.baseUrl ? ` base_url=${verified.baseUrl}` : ""}`,
      );
      const balance = normalizeBalance(
        await fetchBalance(GATEWAY, found.state.token, {}),
      );
      console.log(
        `  live balance: ${balance.balance ?? "unknown"} credits (frozen ${balance.freezeCredit})`,
      );
      const breakdown = parseCreditBreakdown(
        await fetchQuotaUsage(GATEWAY, found.state.token, {}),
      );
      console.log(
        `  live breakdown: ${breakdown ? "bucketed (daily/monthly/other)" : "single pool"}`,
      );
      const wallets = await fetchUserWallets(found.state.token, {});
      if (wallets.ok) {
        for (const [name, bucket] of Object.entries(wallets.buckets)) {
          if (!bucket) continue;
          const expiry = bucket.validTo
            ? new Date(bucket.validTo).toISOString()
            : "no expiry";
          console.log(
            `  live wallet ${name}: ${bucket.balance} credits (expires ${expiry})`,
          );
        }
      } else {
        console.log("  live wallet: not served for this account");
      }
      const catalog = await fetchCatalog(GATEWAY, found.state.token, {});
      console.log(
        `  live catalog: ${catalog.models.length} models (${catalog.models.filter((m) => m.format === "anthropic/messages").length} anthropic)`,
      );
      for (const model of catalog.models) {
        console.log(
          `    ${model.key.padEnd(22)} ${model.format.padEnd(22)} ${String(model.priceFactor).padEnd(5)} ${model.name}`,
        );
      }
    } catch (err) {
      console.log(`  live: failed (${err?.message ?? err})`);
    }
  }
}
