# Changelog

## 0.3.0 - 2026-11-27

### Added

- Real credit-bucket windows: the wallet buckets (daily refreshed credits, sign-up/longterm
  credits, monthly) now come from the web user-service at qwenwork.ai —
  GET /user/v2/wallets?lifecycle=active with per-credit valid_from/valid_to, falling back to
  GET /user/wallets totals. The card now shows expiring Daily and Add-on windows with the real
  reset dates the website displays, on top of the always-present pool window. qwenwork.ai joins
  the allowed host list (wallet endpoints only).

## 0.2.0 - 2026-11-27

### Added

- Multi-window quota card fed by four gateway calls: precise balance (`/api/v1/adapter/user/balance`),
  the `creditBreakdown` parsed from `/api/v2/quota/usage` optional keys (`daily_quota`,
  `monthlyQuota`, `subscription_quota`, `other_credits`, `daily_refresh_amount`, `expires_at`),
  optional wallet buckets (`/api/v1/adapter/user/wallets`, attempted once, the 404 cached and
  skipped thereafter), and account-context for plan name, refresh date and fallback pool. Bucketed
  plans get expiring `Daily` / `Plan` / `Add-on` windows; the measured single-pool state keeps the
  `Credits` card. The minted-key lifetime window stays.
- `auth.checkin` hook mapped to the daily-credit-notice claim: `claimed` / `ineligible` (including
  404/403, cached per session so the endpoint is never retried) / `failed`, matching the host's
  checkin contract. Verified 404-ineligible on the measured Free/global account.
- probe `--live` now prints the precise balance and whether the deployment serves a bucketed
  breakdown; e2e gains a `checkin` check and the usage check reports the window count.

## 0.1.0 - 2026-11-27

### Fixed

- The adopt method always returns the auto sign-in flow instead of an immediate success: the magpie
  host requires every oauth sign-in to hand back a callback (`gave nothing to finish it with`
  otherwise). The callback now adopts any fresh session that verifies by mint, so an already signed
  in desktop app completes in seconds; a token that fails verification is re-checked only when its
  value changes, never on every poll.

### Added

- Initial release. Provider id `qwenwork`, zero runtime dependencies, plain ESM, no build step.
- Adopt method: reads the signed-in QwenWork desktop app session from `%APPDATA%\QwenWork\auth-v2.dat`
  (Chromium os_crypt `v10` AES-256-GCM via DPAPI, bun:ffi with a PowerShell fallback), validates it
  by minting, and re-reads the file on every mint so the app's own refreshes keep the plugin alive.
- Paste method: validates a session token by minting a MaaS key (costs no credits).
- Mint store: single-flight `POST /api/desktop-sessions`, in-memory only, rotated 10 minutes before
  the 2 hour expiry, 401/403 mapped to re-login, 503 mapped to an unsupported-environment error.
- Loader: rebuilds every model-call URL from the current mint's `base_url`, injects the Bearer key,
  removes `x-api-key`/`api-key`, and retries once after a 401 re-mint before flagging
  `X-Magpie-Sign-In: expired`.
- Catalog: `GET /api/desktop/chat-modes` with a 60 second cache, duplicate-key dedupe (first enabled
  entry per key in server order), per-model SDK by `format`, and a 2026-11-27 fallback snapshot
  stamped `magpie.fellBack` on outages.
- Usage: account-context credits window plus a display-only minted-key lifetime window.
- Options: `lang`, `allowModelKeys`, `debug` (via `magpie.options`).
- Tests: 87 offline node:test units (DI seams, contract test) green on node and bun; live e2e
  gated behind `QWENWORK_E2E=1`.

### Verified

- 2026-11-27 live run: adopt -> catalog (9 models after dedupe) -> chat stream 200 (SSE) -> tool
  call 200 -> Anthropic messages 200 -> usage `694.99 remaining` -> mint meter `valid for 1h 59m`.
  Artifact: `artifacts/e2e-2026-11-27T17-25-36-767Z.md`.
- The same auth-v2.dat token hash decrypts under node (PowerShell DPAPI) and bun (bun:ffi).
- Acceptance in real Magpie 0.1.4975: `magpie plugin add D:\projects\magpie-qwenwork` lists
  `qwenwork (QwenWork, 9 models)`; `magpie plugin login qwenwork 1` (adopt) signs in and both model
  families stream through the gateway (`qwenwork/qwen3.8-flash` and `qwenwork/minimax-m3.1-flash`
  answered a streaming "pong"); `magpie plugin options` shows the declared options.
