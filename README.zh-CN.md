# magpie-qwenwork（中文）

一个 magpie provider 插件，把 **QwenWork** 桌面端订阅模型以 `qwenwork/<model>` 的形式提供给每个
agent。插件读取本机已登录的 QwenWork 桌面账号，向网关铸造 MaaS 访问密钥，并按模型自动选择端点。

> 状态：v0.2.0。107 个离线测试在 node 20/22/24 和 bun 上全部通过。2026-11-27 的实机验证覆盖了凭据
> 读取、密钥铸造、流式对话、工具调用、Anthropic Messages、额度卡片和每日签到钩子。

## 模型

| 模型 key            | 端点                    | 积分倍率 | SDK                        |
| ------------------- | ----------------------- | -------- | -------------------------- |
| `qwen3.8-flash`     | openai chat-completions | 0.1x     | `@ai-sdk/openai-compatible` |
| `glm-5.3`           | openai chat-completions | 1x       | `@ai-sdk/openai-compatible` |
| `gpt-6.1-sol`       | openai chat-completions | 1x       | `@ai-sdk/openai-compatible` |
| `qwen4-max`         | anthropic messages      | 1.4x     | `@ai-sdk/anthropic`        |
| `qwen3.8-max`       | openai chat-completions | 1.9x     | `@ai-sdk/openai-compatible` |
| `deepseek-flash`    | openai chat-completions | 0.2x     | `@ai-sdk/openai-compatible` |
| `glm-5.3-flash`     | openai chat-completions | 0.2x     | `@ai-sdk/openai-compatible` |
| `kimi-k3.1-pro`     | openai chat-completions | 2.6x     | `@ai-sdk/openai-compatible` |
| `minimax-m3.1-flash`| anthropic messages      | 0.2x     | `@ai-sdk/anthropic`        |

在线目录来自 `GET /api/desktop/chat-modes`（60 秒缓存）。目录里存在跨档位的重复 key（标准档 +
前沿档）；插件按服务端顺序保留每个 key 的第一个 `enable` 条目，与账号的档位默认一致。内置
2026-11-27 快照作为未登录或目录故障时的回退，并标记 `magpie.fellBack`。

## 安装

```bash
magpie plugin add ./magpie-qwenwork     # 本地目录
magpie plugin add magpie-qwenwork       # npm（发布后）
```

## 登录

`magpie plugin login qwenwork` 提供两种方式：

| 方式                 | 前提                       | 说明                                                                                     |
| -------------------- | -------------------------- | ---------------------------------------------------------------------------------------- |
| 读取桌面端登录        | QwenWork 桌面端已登录一次   | 已有新鲜会话时立即返回；否则展示 QwenWork 登录页，应用登录后自动从 `auth-v2.dat` 采纳会话 |
| 粘贴会话令牌          | `auth-v2.dat` 中的 token   | 通过铸造一次密钥来验证令牌（不消耗积分）；适合非标准安装                                  |

采纳的会话在每次铸造前都会重新读盘，只要桌面应用保持 `auth-v2.dat` 新鲜，插件无需重新登录。插件
对 QwenWork 文件只读，从不调用刷新令牌流程（那是应用自己的职责）。

## 每日签到

插件实现了 Magpie 的可选 `auth.checkin` 钩子，对应 QwenWork 的每日积分领取
（`POST /api/v1/adapter/user/daily-credit-notice/claim`，不消耗积分）。结果：`claimed`
（`领取了 20 积分`）、`ineligible`（今天无可领额度，或当前套餐/部署不提供该端点 - 实测的
Free/国际区状态，会按会话缓存，不再重试）、`failed`（服务端/网络故障，含登录过期，会提示重新
登录）。

## 工作原理

1. **会话令牌**：从 `%APPDATA%\QwenWork\auth-v2.dat` 解密（Chromium os_crypt `v10` AES-256-GCM，
   密钥来自 `Local State` 的 DPAPI 解保护）。v1 仅支持 Windows；粘贴方式无需本地解密。
2. **铸造**：`POST https://gateway.qwenwork.ai/api/desktop-sessions`（携带会话令牌与桌面端请求头）
   返回 2 小时有效的 MaaS 访问密钥和服务端选择的 `base_url`（当前为 `api1.qwenwork.ai`）。密钥在
   过期前 10 分钟轮换，仅存内存，带单飞保护。
3. **模型调用**：`{base_url}/v1/chat/completions` 与 `{base_url}/v1/messages`。loader 始终用当前
   铸造结果重建 URL（绝不信任传入的主机名），注入 `Authorization: Bearer`；收到 401 时重新铸造并
   重试一次，仍失败则给响应标记 `X-Magpie-Sign-In: expired`。
4. **额度**：卡片合并四个网关来源（各一次请求，缓存 60 秒）：`GET /api/v1/adapter/user/balance`
   （精确余量）、`GET /api/v2/quota/usage`（可选的每日/每月/附加积分分桶，解析 `daily_quota` 类
   字段，部署提供时才有）、`GET /api/v1/adapter/user/wallets`（可选的每日/每月/长期钱包桶；尝试
   一次，404 后缓存并跳过）和 `GET /api/v1/adapter/user/account-context`（套餐名、刷新日期、回退
   池）。有分桶的套餐会得到带过期时间的窗口（`每日 60/100（每天 +5）`、`套餐 400/500`、`附加额度
   剩 7`）；实测的 Free/国际区状态降级为单个 `剩 699.97 积分` 池，外加仅展示的密钥有效期窗口。

凭据只会发往 `gateway.qwenwork.ai` 和铸造返回的 `base_url`；令牌永不入日志（以 sha256 前缀 +
长度掩码）；所有请求使用 `redirect: "error"`。

## 配置

`magpie plugin options qwenwork '<json>'` 接受：

```json
{ "lang": "auto", "allowModelKeys": [], "debug": false }
```

- `lang`：`auto` / `en` / `zh`（默认跟随 `MAGPIE_LANG`）。
- `allowModelKeys`：只暴露指定的模型 key 列表。
- `debug`：同时把插件日志打印到 stderr。

## 脚本

```bash
npm test                 # 离线单元 + 插件契约测试（node --test）
npm run probe            # 本机凭据摘要（已掩码）
npm run probe -- --live  # 额外做一次铸造 + 在线目录拉取
npm run e2e              # 完整实机链路，写入 artifacts/e2e-*.json|md
```

`QWENWORK_E2E=1 node --test` 会额外运行在线网关测试。

## 限制

- v1 仅支持 Windows（macOS/Linux 的 QwenWork 使用系统钥匙串存储会话）。
- 仅面向国际版（`gateway.qwenwork.ai`）；不针对国内版（`*.qwenwork.cn`）。
- 检测到多身份安装（`identityVersion > 0`）或商业账号时明确报错。
- 未开通桌面 MaaS 的环境在铸造时返回明确错误（HTTP 503）。
- 模型调用按倍率消耗 QwenWork 积分；额度卡片显示余量，模型描述里带倍率。

## 非官方互操作声明

本插件只与用户本机自行安装的 QwenWork 账号互操作，与阿里巴巴/Qwen 无关联亦无背书；不分发任何
令牌。详见 [NOTICE](./NOTICE)。

## 许可

MIT。见 [LICENSE](./LICENSE)。
