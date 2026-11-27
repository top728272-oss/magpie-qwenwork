export const PROVIDER = "qwenwork";
export const VERSION = "0.3.1";

export const GATEWAY = "https://gateway.qwenwork.ai";
export const WEB_ORIGIN = "https://qwenwork.ai";
export const DEFAULT_MAAS_ORIGIN = "https://api1.qwenwork.ai";
export const MINT_PATH = "/api/desktop-sessions";
export const CATALOG_PATH = "/api/desktop/chat-modes";
export const ACCOUNT_CONTEXT_PATH = "/api/v1/adapter/user/account-context";
export const ACCOUNT_CONTEXT_INCLUDE = "user,plan,quota";
export const BALANCE_PATH = "/api/v1/adapter/user/balance";
export const QUOTA_USAGE_PATH = "/api/v2/quota/usage";
export const WALLETS_V1_PATH = "/user/wallets";
export const WALLETS_V2_PATH = "/user/v2/wallets";
export const CLAIM_PATH = "/api/v1/adapter/user/daily-credit-notice/claim";

export const DESKTOP_USER_AGENT = "qoderwork/2.0.1";
export const DESKTOP_VERSION = "2.0.1";
export const DESKTOP_RELEASE = "2.0.1-26112601";
export const DESKTOP_BUILD = "26112601";
export const DESKTOP_PLATFORM = "win32";
export const DESKTOP_ARCH = "x64";
export const DESKTOP_CHANNEL = "stable";
export const DESKTOP_APP_MODE = "standard";

export const HEADER_SIGN_IN = "X-Magpie-Sign-In";

export const MINT_TTL_MS = 7_200_000;
export const REFRESH_BEFORE_MS = 600_000;
export const SESSION_FRESH_MARGIN_MS = 300_000;
export const CATALOG_TTL_MS = 60_000;
export const USAGE_TTL_OK_MS = 60_000;
export const USAGE_TTL_ERR_MS = 30_000;
export const FILE_CACHE_TTL_MS = 3_000;
export const MINT_TIMEOUT_MS = 20_000;
export const CATALOG_TIMEOUT_MS = 20_000;
export const USAGE_TIMEOUT_MS = 8_000;
export const DPAPI_TIMEOUT_MS = 10_000;
export const ADOPT_POLL_MS = 2_000;
export const ADOPT_WAIT_MS = 5 * 60_000;
export const ADOPT_FRESH_MARGIN_MS = 120_000;
export const MAX_JSON_BYTES = 1 << 20;

export const APP_DIR_NAME = "QwenWork";
export const AUTH_FILE = "auth-v2.dat";
export const LOCAL_STATE_FILE = "Local State";
export const HOME_ENV_NAME = "QWENWORK_HOME";

export const VALIDATION_MODEL = "qwen3.8-flash";
export const VALIDATION_MESSAGES_MODEL = "minimax-m3.1-flash";

export const FORMAT_OPENAI = "openai/chat-completions";
export const FORMAT_ANTHROPIC = "anthropic/messages";

export const NPM_OPENAI_COMPATIBLE = "@ai-sdk/openai-compatible";
export const NPM_ANTHROPIC = "@ai-sdk/anthropic";

export const MODE_ADOPT = "adopt";
export const MODE_PASTE = "paste";

export const FALLBACK_SNAPSHOT_DATE = "2026-11-27";

export const DEFAULT_OPTIONS = {
  gatewayOrigin: GATEWAY,
  dataDir: "",
  lang: "auto",
  debug: false,
  allowModelKeys: [],
};

export const FALLBACK_MODELS = [
  {
    key: "qwen3.8-flash",
    name: "Standard",
    description: "Cost efficient for everyday tasks",
    format: FORMAT_OPENAI,
    priceFactor: 0.1,
    isDefault: true,
    frontier: false,
    reasoning: true,
    vl: true,
    maxInputTokens: 1_000_000,
  },
  {
    key: "glm-5.3",
    name: "Pro",
    description: "Balanced performance for complex tasks",
    format: FORMAT_OPENAI,
    priceFactor: 1,
    isDefault: false,
    frontier: false,
    reasoning: true,
    vl: false,
    maxInputTokens: 1_000_000,
  },
  {
    key: "gpt-6.1-sol",
    name: "Flagship",
    description: "Most capable for demanding tasks",
    format: FORMAT_OPENAI,
    priceFactor: 1,
    isDefault: false,
    frontier: false,
    reasoning: true,
    vl: true,
    maxInputTokens: 1_000_000,
  },
  {
    key: "qwen4-max",
    name: "Qwen4-Max",
    description: "Proven flagship for intensive tasks",
    format: FORMAT_ANTHROPIC,
    priceFactor: 1.4,
    isDefault: false,
    frontier: true,
    reasoning: true,
    vl: true,
    maxInputTokens: 1_000_000,
  },
  {
    key: "qwen3.8-max",
    name: "Qwen3.8-Max",
    description: "Proven flagship for intensive tasks",
    format: FORMAT_OPENAI,
    priceFactor: 1.9,
    isDefault: false,
    frontier: true,
    reasoning: true,
    vl: true,
    maxInputTokens: 1_000_000,
  },
  {
    key: "deepseek-flash",
    name: "DeepSeek-V4.1-Flash",
    description: "Visual reasoning, coding, and agentic tasks",
    format: FORMAT_OPENAI,
    priceFactor: 0.2,
    isDefault: false,
    frontier: true,
    reasoning: true,
    vl: false,
    maxInputTokens: 1_000_000,
  },
  {
    key: "glm-5.3-flash",
    name: "GLM-5.3-Flash",
    description: "Light multimodal for visual coding",
    format: FORMAT_OPENAI,
    priceFactor: 0.2,
    isDefault: false,
    frontier: true,
    reasoning: true,
    vl: true,
    maxInputTokens: 1_000_000,
  },
  {
    key: "kimi-k3.1-pro",
    name: "Kimi-K3.1-Pro",
    description: "Long context for UI and research",
    format: FORMAT_OPENAI,
    priceFactor: 2.6,
    isDefault: false,
    frontier: true,
    reasoning: true,
    vl: true,
    maxInputTokens: 1_000_000,
  },
  {
    key: "minimax-m3.1-flash",
    name: "MiniMax-M3.1-Flash",
    description: "Fast multimodal for office, agents, and coding",
    format: FORMAT_ANTHROPIC,
    priceFactor: 0.2,
    isDefault: false,
    frontier: true,
    reasoning: true,
    vl: true,
    maxInputTokens: 1_000_000,
  },
];
