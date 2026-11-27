const MESSAGES = {
  zh: {
    providerName: "QwenWork",

    loginAdopt: "读取本机 QwenWork 桌面登录",
    loginPaste: "粘贴 QwenWork 会话令牌",

    promptSessionToken: "QwenWork 会话令牌（auth-v2.dat 中的 token）",

    adoptInstructions:
      "在 QwenWork 桌面应用里完成登录。登录成功后这里会自动继续；若应用没有打开，请从刚打开的页面安装并登录 QwenWork。",
    errAdoptTimeout: "等待 QwenWork 登录超时，请重试。",

    errKeyMissing: "缺少 QwenWork 会话令牌。",
    errNoCredentials:
      "没有找到 QwenWork 登录信息（{path}）。请先在 QwenWork 桌面应用里登录一次。",
    errBadCredentials: "账号文件解析失败：{path}（{reason}）",
    errSignInExpired: "QwenWork 登录已失效，请在桌面应用里重新登录后重新授权。",
    errUnsupportedPlatform:
      "本插件目前仅支持 Windows 版 QwenWork（macOS/Linux 使用系统钥匙串存储，暂不支持）。",
    errIdentityVersion:
      "检测到多身份 QwenWork 安装（identityVersion {version}），暂不支持。",
    errMintUnsupported:
      "当前 QwenWork 环境未开通桌面 MaaS（503），无法创建模型会话。",
    errForbidden: "QwenWork 拒绝了这次请求（403）。",
    errRateLimited: "QwenWork 限流了这次请求（429），稍后重试。",
    errUpstream: "QwenWork 上游返回 {status}。",
    errTimeout: "请求超时，请重试。",
    errRedirect: "请求被重定向（鉴权失败），请重新登录。",
    errNoToken: "没有可用的 QwenWork 会话令牌。",

    usageCreditsName: "积分",
    usageCreditsDisplay: "剩 {remaining}",
    usageUnknown: "未知",
    usageKeyName: "MaaS 访问密钥",
    usageKeyLeft: "有效 {time}",
    usageKeyExpired: "已过期",
    usageNoSession: "未读取到账号会话",
  },
  en: {
    providerName: "QwenWork",

    loginAdopt: "Read the signed-in QwenWork desktop app",
    loginPaste: "Paste a QwenWork session token",

    promptSessionToken: "QwenWork session token (the token in auth-v2.dat)",

    adoptInstructions:
      "Finish the sign-in in the QwenWork desktop app. This dialog continues automatically once the app is signed in. If QwenWork did not open, install it from the page that just opened, then sign in.",
    errAdoptTimeout: "Timed out waiting for the QwenWork sign-in. Please retry.",

    errKeyMissing: "The QwenWork session token is missing.",
    errNoCredentials:
      "No QwenWork sign-in found ({path}). Sign in to the QwenWork desktop app once.",
    errBadCredentials: "Cannot parse the account file: {path} ({reason})",
    errSignInExpired:
      "The QwenWork sign-in expired. Sign in to the desktop app again, then re-authorize.",
    errUnsupportedPlatform:
      "This plugin currently supports QwenWork on Windows only (macOS and Linux builds use the system keychain).",
    errIdentityVersion:
      "Multi-identity QwenWork installs are not supported yet (identityVersion {version}).",
    errMintUnsupported:
      "This QwenWork environment has no desktop MaaS access (503). Model sessions cannot be created.",
    errForbidden: "QwenWork refused the request (403).",
    errRateLimited: "QwenWork rate-limited the request (429). Retry shortly.",
    errUpstream: "QwenWork upstream answered {status}.",
    errTimeout: "Timed out. Please retry.",
    errRedirect:
      "The request was redirected (auth failed). Sign in again.",
    errNoToken: "No QwenWork session token is available.",

    usageCreditsName: "Credits",
    usageCreditsDisplay: "{remaining} remaining",
    usageUnknown: "unknown",
    usageKeyName: "MaaS access key",
    usageKeyLeft: "valid for {time}",
    usageKeyExpired: "expired",
    usageNoSession: "No account session was read",
  },
};

function systemLocale() {
  if (typeof process !== "undefined") {
    for (const name of ["MAGPIE_LANG", "LC_ALL", "LC_MESSAGES", "LANG"]) {
      const value = String(process.env?.[name] ?? "").trim();
      if (value && !/^(c|posix)(\.|$)/i.test(value)) return value;
    }
  }
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale ?? "";
  } catch {
    return "";
  }
}

export function detectLang({ locale = systemLocale() } = {}) {
  const value = String(locale ?? "")
    .trim()
    .toLowerCase();
  return value.startsWith("zh") ? "zh" : "en";
}

export function resolveLang(options = {}) {
  const raw = String(options.lang ?? "auto")
    .trim()
    .toLowerCase();
  if (raw.startsWith("zh")) return "zh";
  if (raw.startsWith("en")) return "en";
  return detectLang();
}

export function t(lang, key, vars = {}) {
  const dict = MESSAGES[lang] ?? MESSAGES.zh;
  const raw = dict[key] ?? MESSAGES.zh[key] ?? key;
  return String(raw).replace(
    /\{(\w+)\}/g,
    (_, name) => vars[name] ?? `{${name}}`,
  );
}

export const MESSAGES_ALL = MESSAGES;
