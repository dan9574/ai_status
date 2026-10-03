# ai_status · 阶段一：`aistatusd` 守护进程 + `aistatus` 终端查看器；阶段二：watchOS 应用

在本机追踪每个 Claude Code / Codex 会话的实时状态（running / waiting / done），通过局域网 HTTP API 提供给阶段二的 watchOS 应用。Node 22，零 npm 依赖。设计见 [PLAN.md](PLAN.md)。手表应用见下文[阶段二：watchOS 应用](#阶段二watchos-应用)。

## 安装与运行

```sh
cd ~/projects/ai_status
npm test                          # 单元/集成测试（node:test）
node scripts/e2e.mjs              # 可选：在临时 HOME 中跑端到端检查，不碰真实配置

node bin/aistatus.js install-hooks          # 写入 ~/.claude/settings.json 与 ~/.codex/hooks.json（先备份）
node bin/aistatus.js daemon                 # 前台运行守护进程（Ctrl-C 退出）
node bin/aistatus.js                        # 另开终端：实时卡片视图（q 退出）
```

- 可选 `npm link`，之后直接用 `aistatus` / `aistatusd`。
- `install-hooks` 会把转发脚本复制到 `~/.aistatus/bin/aistatus-hook`，再把钩子**合并**进配置文件；修改前把原文件备份到 `~/.aistatus/backups/<名称>.<时间戳>.json`。重复执行无变化（幂等）；`uninstall-hooks` 只删除命令中含 `aistatus-hook` 的条目。可用 `--claude` / `--codex` 只装一边，`--port N` 指定端口。
- 按官方文档，Claude Code 会通过文件监听自动加载 settings.json 中钩子的修改；若某个已打开会话没反应，重启该会话即可。
- **Codex 需要额外一步**：Codex 对新钩子按哈希做信任校验，未信任的钩子会被跳过。安装后在 Codex CLI 里执行 `/hooks` 审核并信任（CLI 路径：`/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex`），或在桌面版出现钩子审核提示时确认。未信任前，守护进程会自动退回到“监听会话文件”模式（见下文）。
- 开机自启（可选）：`node bin/aistatus.js install-daemon` 生成 `~/Library/LaunchAgents/com.aistatus.daemon.plist`（**只写文件，不加载**），然后自行执行 `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.aistatus.daemon.plist`。日志在 `~/.aistatus/daemon.log`。`--print` 只打印不写入。

### CLI

| 命令 | 作用 |
|---|---|
| `aistatus` | 实时卡片视图（SSE 推送，计时器本地每秒刷新） |
| `aistatus list [--json]` | 打印一次当前卡片 |
| `aistatus dismiss <id>` | 清除卡片；id 可为 `claude:<sessionId>`、sessionId 或唯一前缀 |
| `aistatus health` | 守护进程健康信息 |
| `aistatus daemon [--port N] [--no-bonjour]` | 前台运行守护进程 |
| `aistatus install-hooks` / `uninstall-hooks` | 安装 / 卸载钩子 |
| `aistatus install-daemon [--print]` | 生成 launchd plist（不加载） |

### 配置 `~/.aistatus/config.json`（均可省略）

```json
{
  "port": 7778,
  "host": "0.0.0.0",
  "swipeThresholdSec": 60,
  "bonjour": true,
  "token": null,
  "codex": { "source": "auto", "pollMs": 1500 },
  "idlePruneHours": 24
}
```

- `swipeThresholdSec`：运行时长低于此值的已完成卡片 `dismissPolicy = "swipe"`，否则 `"confirm"`。
- `token`：设置后，非本机客户端需带 `Authorization: Bearer <token>` 或 `?token=<token>`；本机永远放行。
- `codex.source`：`auto`（钩子优先，会话文件监听兜底）/ `hooks` / `watcher`。
- 环境变量覆盖：`AISTATUS_PORT`、`AISTATUS_HOST`、`AISTATUS_BONJOUR=0`、`AISTATUS_CODEX_SOURCE`、`AISTATUS_DIR`（数据目录）。
- 状态持久化在 `~/.aistatus/state.json`（原子写入），守护进程重启后卡片不丢。

## 状态机

| 钩子事件（Claude / Codex） | 结果 |
|---|---|
| `SessionStart` | 建立会话，idle（不显示）；对已有会话不改状态（compact/resume 也会触发） |
| `UserPromptSubmit` | running，记录 `startedAt`；done 会话重新开始计时 |
| `Notification`（`permission_prompt`、`elicitation_dialog`、`agent_needs_input`）/ `PermissionRequest` / `PreToolUse(AskUserQuestion)` | waiting |
| `PostToolUse` / `PostToolUseFailure` / `PermissionDenied`（waiting 之后） | 回到 running |
| `Stop` / `StopFailure` / Codex `Interrupt` | done，记录 `finishedAt`、`runDurationMs`、最后一条回复摘要 |
| `SessionEnd` | 已 done 的保留卡片（`ended: true`）直到清除，否则删除 |
| dismiss | 隐藏卡片（会话变 idle；已结束的会话直接删除）。之后同一轮的迟到事件不会让它复活，新的 prompt 会 |

`Notification` 的 `idle_prompt`（完成 60 秒后的“等待输入”提醒）被忽略，不会把 done 变成 waiting。守护进程宕机期间错过开头的会话，收到后续事件时会以 `startedAtApprox: true` 补建卡片。

## API（供 watchOS 客户端使用）

默认 `http://<mac>:7778`，绑定 `0.0.0.0`。所有时间戳均为 **Unix 毫秒（整数）**，客户端自行计时；用响应里的 `serverTime` 校正时钟偏差（`offset = serverTime - 本地收到时刻`）。

### 服务发现

Bonjour：`_aistatus._tcp`，实例名 `aistatus@<主机名>`，TXT：`path=/sessions events=/events v=1`。

### `GET /sessions`

```json
{
  "version": 1,
  "serverTime": 1790959466000,
  "swipeThresholdSec": 60,
  "sessions": [
    {
      "id": "claude:2f1c…",
      "tool": "claude",
      "sessionId": "2f1c…",
      "project": "ai_status",
      "cwd": "/Users/me/projects/ai_status",
      "status": "running",
      "startedAt": 1790959400000,
      "startedAtApprox": false,
      "finishedAt": null,
      "runDurationMs": null,
      "waitingSince": null,
      "waitingReason": null,
      "lastMessage": "fix the failing tests",
      "dismissPolicy": "confirm",
      "interrupted": false,
      "error": null,
      "ended": false,
      "updatedAt": 1790959420000
    }
  ]
}
```

| 字段 | 说明 |
|---|---|
| `id` | 卡片主键 `<tool>:<sessionId>`，用于 dismiss |
| `tool` | `claude` \| `codex` |
| `project` / `cwd` | 工作目录及其 basename |
| `status` | `running` \| `waiting` \| `done`（idle 不出现在列表里） |
| `startedAt` | 本轮开始时间；running 显示 `now - startedAt`。done 且开头未知时为 `null` |
| `startedAtApprox` | `true` 表示开头事件缺失，`startedAt` 为近似值 |
| `finishedAt` / `runDurationMs` | done 时有值；“晾了多久” = `now - finishedAt` |
| `waitingSince` / `waitingReason` | waiting 时有值；原因 `permission` \| `question` \| `input` |
| `lastMessage` | 摘要（≤160 字符）：提问 → 等待原因 → 最终回复 |
| `dismissPolicy` | `swipe`（短任务，可直接滑掉）\| `confirm`（需确认）。非 done 卡片一律 `confirm` |
| `interrupted` / `error` | 被中断 / 以错误结束 |
| `ended` | 会话进程已退出 |

排序：waiting → running → done，同组内按开始时间先后。

### `GET /events`（SSE）

连接即推送一次完整快照，之后**每次变化推送完整快照**（与 `/sessions` 同结构），无需做增量合并：

```
retry: 2000

event: snapshot
data: {"version":1,"serverTime":…,"sessions":[…]}
```

每 15 秒发送注释行 `: ping` 保活。手表在后台无法保持长连接时，可退化为定时 `GET /sessions`。

### `POST /sessions/:id/dismiss`

清除卡片。`:id` 为 `id`（需 URL 编码，如 `claude%3A2f1c…`），也接受 sessionId 或唯一前缀。成功 `200 {"ok":true,"dismissed":{…卡片…}}`；不存在或前缀不唯一 `404`。确认交互（`dismissPolicy`）由客户端负责，服务端不强制。

### `GET /health`

`{"ok":true,"name":"aistatusd","version":"0.1.0","pid":…,"startedAt":…,"serverTime":…,"sessions":3,"sseClients":1}`

### `POST /hook/:tool`（仅本机）

`:tool` 为 `claude` 或 `codex`，请求体为钩子原始 JSON。**只接受回环地址**，其他来源返回 `403`。由 `aistatus-hook` 脚本调用，客户端不需要使用。

### 错误与认证

错误响应为 `{"error":"…"}`。配置了 `token` 时，非本机请求缺少/错误 token 返回 `401`。

## 钩子转发脚本

`hooks/aistatus-hook.sh <claude|codex> [port]`：`curl` 读取 stdin，POST 到 `127.0.0.1`，连接超时 0.5s、总超时 2s，输出全部丢弃，**始终 exit 0**。守护进程未运行时立即返回（实测冷启动首次约 180ms），正常转发实测每次约 10–45ms。Claude 钩子 `timeout: 5`，Codex `timeout: 3`（Codex 的 SessionEnd 上限 3 秒）。

## Codex 调查结果（2026-10-02，只读）

- 本机是 **Codex 桌面版**（`ChatGPT.app` 内置 `codex-cli 0.159.0-alpha.12.1`，`config.toml` 里 `originator = codex_work_desktop`），`codex` 不在 PATH。
- **支持生命周期钩子**：`codex features list` 显示 `hooks  stable  true`；二进制内嵌的钩子输入 schema 包含 `SessionStart`、`UserPromptSubmit`、`PreToolUse`、`PermissionRequest`、`PostToolUse`、`PreCompact`、`PostCompact`、`Stop`（含 `last_assistant_message`）、`SubagentStart`、`SubagentStop`、`Interrupt`、`SessionEnd`；**没有** `Notification`。payload 与 Claude Code 基本同构（`session_id`、`cwd`、`transcript_path`、`hook_event_name`、`turn_id`…）。配置位置为 `~/.codex/hooks.json` 或 `config.toml` 的 `[hooks]`；目前两者都没有。新钩子需信任（见上文）。
- **legacy `notify` 不可用**：`config.toml` 的 `notify` 已被 Codex Computer Use 客户端占用（`… SkyComputerUseClient turn-ended`），且只能配置一个程序、只在回合结束触发，所以没有使用它，也没有修改。
- **会话文件**：`~/.codex/sessions/YYYY/MM/DD/rollout-<本地时间>-<uuid>.jsonl`，每行 `{"timestamp","type","payload"}`。观察到的类型：`session_meta`（`id`、`cwd`、`originator`、`cli_version`）、`turn_context`、`response_item`、`world_state`、`token_usage_record`，以及 `event_msg` 下的 `task_started`、`item_completed`、`token_count`、`task_complete`（`last_agent_message`、`duration_ms`）、`thread_settings_applied`。`session_index.jsonl` 只有 `id/thread_name/updated_at`。`state_5.sqlite` 的 `threads.rollout_path` 指向这些文件。
- **实现**：钩子为主；同时运行只读的会话文件监听（每 1.5 秒轮询最近 7 个日期目录，增量读取）：`task_started`→running，`task_complete`→done，`turn_aborted`→done(interrupted)，`*_approval_request` / `request_user_input` / `request_permissions`→waiting。同一个会话（或同一 `transcript_path`）一旦收到钩子事件，监听器就不再管它，避免重复卡片。启动时只重放 24 小时内的文件，且只恢复仍在运行或 10 分钟内刚完成的会话。
- **可靠性**：钩子（信任后）应与 Claude 同级；监听器的 running/done 基于实际观察到的 `task_started`/`task_complete`，可靠，延迟 ≤1.5s。waiting 检测**未验证**：审批事件名存在于二进制中，但本机现有文件里没有审批记录，无法确认它们会写入 rollout。另外 Codex 有 `migrate-rollouts`（迁移到 `thread_history_1.sqlite` 分页历史）和尚未启用的 `background_paginated_rollout_migration` 特性，将来 rollout 文件格式/存在性可能变化，届时监听器会失效，钩子不受影响。

## 已知限制

- **Claude 的权限审批**：没有“审批已通过”的钩子，waiting 要等被批准的工具**执行完**（`PostToolUse`）才回到 running；长时间运行的命令期间卡片会一直显示 waiting。
- **用户按 Esc 中断 Claude**：文档中 `Stop` 定义为“Claude 完成回复时”，中断时很可能不触发（未实测），此时卡片会停在 running，直到下一个 prompt 或手动 dismiss。Codex 有 `Interrupt` 钩子，不受影响。
- 代理进程崩溃/被杀且没有 `Stop`/`SessionEnd` 时，卡片同样会停留，需手动 dismiss。
- `PostToolUse` 每次工具调用都会触发一次 curl（同步，约 10–45ms）。
- 默认无认证：局域网内任何人都能读取项目名、路径、消息摘要并 dismiss；在不可信网络请设置 `token`。仅 IPv4 `0.0.0.0` 监听。
- Codex 钩子与会话文件中的 session id 是否一致未验证（通过 `transcript_path` 去重兜底）；Codex 桌面版里钩子信任界面如何出现未验证。
- 卡片排序、时间都由服务器给出绝对时间；手表需自行处理时钟偏差（用 `serverTime`）。

## 开发

```
src/store.js          状态机与钩子归一化
src/server.js         HTTP / SSE API
src/daemon.js         组装：持久化、Bonjour、Codex 监听
src/codex-watcher.js  Codex rollout 文件监听
src/installer.js      钩子安装/卸载、launchd plist
src/cli.js, render.js 命令行与终端渲染
hooks/aistatus-hook.sh 钩子转发脚本
scripts/e2e.mjs       端到端检查（临时 HOME，默认端口 17778）
```

测试与 e2e 只使用临时 HOME，不会修改真实的 `~/.claude`、`~/.codex` 或加载 launchd 任务。

## 阶段二：watchOS 应用

独立的 watchOS 应用（SwiftUI，**不需要 iPhone 伴侣应用**，部署目标 watchOS 11），外加一个 WidgetKit 小组件（智能叠放 / 表盘复杂功能）。代码在 `watch/`。

> **状态（2026-10-03）**：本机只有命令行工具（Swift 5.10，无 Xcode、无 watchOS SDK）。逻辑和视图都已在 macOS 上编译、测试、离屏渲染，并对真实守护进程跑过联调；但**整个工程从未针对 watchOS SDK 编译过，也从未在手表上运行过**。详见下文“尚未验证”。

### 手表上看到什么

- **每个会话一张卡片**：工具（Claude = 橙色 ✦ sparkle，Codex = 蓝色 `</>`，颜色和图形都不同）、项目名、状态。
  - running：绿色，“for 12:34” 自走计时（`Text(date, style: .timer)`，不轮询）。
  - waiting：橙色底 + 橙色描边 + 举手图标，“Needs approval / Has a question / Needs input”，显示已等待多久和等待前跑了多久。
  - done：“idle 3:02” 自走计时（自 finishedAt 起），外加“ran 4m 10s”（本次运行时长）；被中断显示 Interrupted，出错显示红色 Failed。
- **只有一个会话**：整屏一张大卡片；向左滑或点 “Clear” 清除。**多个会话**：列表，每行一张卡片，点开看大卡片。
- **排序（手表专用，与服务器不同）**：waiting（等最久的在前）→ done（最早完成的在前）→ running（最早开始的在前）。
- **智能清除**：完全按守护进程给的 `dismissPolicy`：`swipe` → 列表里一滑到底直接清除；`confirm` → 滑动后点 Clear，再弹确认框。清除是乐观的（先隐藏，`POST /sessions/:id/dismiss` 失败则恢复并提示；404 视为已清除）。running / waiting 卡片也能清除（总是需要确认），用于处理卡住的会话（见阶段一“已知限制”）。
- **状态页**：未设置主机 → 引导设置；连接中 → 转圈；连不上 → 红色 “Can't reach Mac”，显示地址、原因（拒绝连接 / 找不到主机 / token 错误…）、最后更新时间和当时的计数，带 Retry；无会话 → “No active sessions”。左上角小圆点：绿 = SSE 实时，黄 = 轮询，红 = 离线。
- **触感**：应用在前台时，有会话变成 waiting（`.notification`，优先）或 done（`.success`）时震动；打开应用时的第一份快照不震。
- **设置**：主机、端口（默认 7778）、token（可选），`@AppStorage` 持久化。主机只写名字会自动补 `.local`（`Daniels-MacBook-Air` → `Daniels-MacBook-Air.local`），也接受 IP、`host:port`、带 `http://` 的写法；“Test connection” 调 `/health`。构建时 `generate.sh` 会把本机的 Bonjour 名写进 Info.plist 作为默认主机，**手表上通常不用打字**。
- **小组件**：`accessoryRectangular / Circular / Inline / Corner`，显示 running / waiting / done 计数和“as of 时间”；数据来自应用最后一次写入 App Group 的快照（计数变化时才刷新时间线）。小组件自己不联网，所以它只和你上次打开应用时一样新（后台刷新是阶段三）。

### 网络

- 前台时用 `URLSession.bytes` 连 `GET /events`（SSE，自己按字节解析，因为 `AsyncBytes.lines` 会吞掉空行）；首个快照 8 秒内没到（例如代理缓冲了流）或连接断开 → 立即 `GET /sessions` 轮询（每 5 秒），同时按指数退避（1→2→4…30 秒，±20% 抖动）重连 SSE；连续 2 次失败才显示离线。SSE 空闲 40 秒（守护进程每 15 秒 ping）视为断线。
- 应用进入后台（`scenePhase == .background`）即断开；抬腕回来自动重连。
- 时钟偏差：每份快照的 `serverTime` 与本地收到时刻（轮询取往返中点）求差，取最近 5 个样本的中位数，所有时间戳换算成本地时间再交给计时文本。
- 没有使用 Bonjour 浏览：普通 watchOS 应用基本拿不到 Network.framework 的 NWBrowser/NWConnection，所以手动主机是基线。
- Info.plist：`NSAppTransportSecurity → NSAllowsLocalNetworking = YES`（允许明文 HTTP 到 `.local`、不带点的主机名和局域网 IP；**故意没有**加 `NSAllowsArbitraryLoads`，两者同时存在时后者会被忽略）、`NSLocalNetworkUsageDescription`、`NSBonjourServices = _aistatus._tcp`、`WKApplication`、`WKWatchOnly`。
- 守护进程 API **无需改动**，阶段一的 `/sessions`、`/events`、`/sessions/:id/dismiss`、`/health` 和 Bearer token 已够用。

### 目录

```
watch/
  project.yml                 XcodeGen 规格：watchOS 应用 AIStatus + 小组件扩展 AIStatusWidget、App Group
  Config/Base.xcconfig        包名前缀、App Group、默认主机、团队（可被 Local.xcconfig 覆盖）
  App/                        @main（只承载 AIStatusRootView）、Info.plist、entitlements、图标
  Widget/                     WidgetKit 扩展（@main WidgetBundle + TimelineProvider）
  scripts/generate.sh         写 Config/Local.xcconfig（首次）并运行 xcodegen
  scripts/check.sh            不需要 Xcode 的全部检查
  AIStatusKit/                Swift 包（macOS 上可 swift build）
    Sources/AIStatusKit       模型/解码、SSE 解析、Endpoint、URLSession 传输、连接循环、时钟、排序、视图模型、App Group 存储
    Sources/AIStatusUI        全部 SwiftUI 视图（watch 专用 API 在 #if os(watchOS) 里）
    Sources/AIStatusChecks    可执行测试程序（命令行工具里 XCTest 和 Swift Testing 都不可用）
    Fixtures/                 从真实 aistatusd 抓取的 JSON / SSE 原始字节
    scripts/capture-fixtures.mjs   重新抓取夹具（临时 HOME、关 Bonjour、端口 17779）
    scripts/live-check.mjs         对真实守护进程跑 Swift 联调（临时 HOME、端口 17780，中途重启守护进程）
```

### 现在（无 Xcode）能做的验证

```sh
cd ~/projects/ai_status/watch
./scripts/check.sh                              # swift build + 208 项检查 + App/Widget 入口在 macOS 上类型检查 + plist/YAML 语法
node AIStatusKit/scripts/live-check.mjs         # 再加 32 项：真实 aistatusd 进程上的 SSE、轮询、dismiss、重启重连、局域网 token
RENDER_DIR=/tmp/aistatus-render AIStatusKit/.build/debug/AIStatusChecks   # 把各个界面渲染成 PNG（macOS 渲染）看一眼
```

### 装好 Xcode 之后：上手表的步骤

1. **Xcode**：安装后打开一次，同意许可，在 Settings → Components 里安装 **watchOS** 平台。终端执行 `sudo xcode-select -s /Applications/Xcode.app/Contents/Developer`（需要你自己输密码），然后 `xcodebuild -version` 确认。
2. **XcodeGen**：`brew install xcodegen`（没有 Homebrew 的话，从 https://github.com/yonaskolb/XcodeGen/releases 下载 `xcodegen.zip`，把 `xcodegen` 放进 PATH）。
3. **生成工程**：
   ```sh
   cd ~/projects/ai_status/watch
   ./scripts/generate.sh                 # 首次会写 Config/Local.xcconfig：
                                         #   BUNDLE_ID_PREFIX = dev.<你的用户名>
                                         #   AISTATUS_DEFAULT_HOST = <scutil --get LocalHostName>.local
   open AIStatus.xcodeproj
   ```
   可选：`./scripts/generate.sh --team ABCDE12345 --host my-mac.local --prefix com.yourname`。项目改动只改 `project.yml`，然后重新运行 `generate.sh`（`.xcodeproj` 不入库）。
4. **签名**：选中 `AIStatus` 目标 → Signing & Capabilities → Team 选你的 Personal Team；`AIStatusWidget` 目标同样操作。若提示包名被占用，用 `--prefix` 换一个前缀重新生成。为了避免每次重新生成都要再选团队，把团队 ID（在 Xcode 选好团队后，Build Settings 里 `DEVELOPMENT_TEAM` 的值）写进去：`./scripts/generate.sh --team <ID>`。
5. **先在模拟器跑一次**（可选但推荐）：Scheme 选 `AIStatus`，目标选任意 Apple Watch 模拟器，⌘R。模拟器和 Mac 同机，主机填 `localhost` 或 `127.0.0.1` 即可验证界面和网络。
6. **手表开发者模式**：iPhone 用线连 Mac 并“信任此电脑”；在 Xcode → Window → Devices and Simulators 里能看到配对的手表（首次会花较久“准备设备/拷贝符号”，手表要充电、解锁、靠近 iPhone）。在 iPhone 设置 → 隐私与安全性 → 开发者模式 打开并重启；手表上 设置 → 隐私与安全性 → 开发者模式 打开并重启，按提示确认。
7. **装到手表**：Scheme `AIStatus`，运行目标选你的 Apple Watch，⌘R。若手表/手机提示不受信任的开发者：iPhone 设置 → 通用 → VPN 与设备管理 → 信任你的开发者证书。
8. **Mac 端**：`node bin/aistatus.js daemon`（或按阶段一的 launchd 方式常驻）。macOS 防火墙若弹窗，允许 `node` 接受传入连接。先用 iPhone 浏览器打开 `http://<LocalHostName>.local:7778/health` 确认局域网可达。
9. **手表上**：打开 AI Status。默认主机已是本机名；不对的话点右上角齿轮改主机，点 “Test connection”。如果设置了 `token`，在设置里填上。
10. **小组件**：长按表盘 → 编辑 → 复杂功能里选 AI Status；或在智能叠放里添加。先打开一次应用，小组件才有数据。

### 尚未验证（因为没有 Xcode / watchOS SDK）

- **从未针对 watchOS SDK 编译过的代码**（macOS 上被 `#if os(watchOS)` 跳过，或只在 watchOS 上有意义）：
  - `Haptics.swift` 里的 `WKInterfaceDevice.current().play(...)`；
  - `RootView.swift` 的 `.topBarLeading / .topBarTrailing` 工具栏位置；
  - `SettingsView.swift` 的 `.textInputAutocapitalization(.never)`；
  - `WidgetViews.swift` 的 `accessoryCircular / accessoryInline / accessoryCorner` 分支（`AccessoryWidgetBackground`、`.widgetLabel`）；
  - `Widget/AIStatusWidget.swift` 的 watchOS 小组件家族列表。
- **全部 Swift 代码**都只用 Swift 5.10 + macOS 14.4 SDK 编译过；Xcode 自带的新编译器（Swift 6.x，工程设为 Swift 5 语言模式）可能报出新的警告或错误。
- `project.yml` 只做过 YAML 语法检查，**从未用 XcodeGen 生成过**（本机没有 Homebrew/XcodeGen，按要求没有安装）；目标类型、扩展嵌入、包依赖、`#include? "Local.xcconfig"` 等都要在生成时确认。Info.plist / entitlements 只做过 `plutil -lint`。
- 资源目录（图标、AccentColor）没被 `actool` 编译过。
- 手表上的实际表现：列表/大卡片排版、滑动清除手势（单卡片页是自定义拖动手势，可能和系统手势冲突，有 Clear 按钮兜底）、确认框、Digital Crown 滚动、常亮显示（AOD）下的计时、触感、小组件外观。
- 手表上的网络：`URLSession.bytes` 流式 SSE 在手表上（特别是经 iPhone 蓝牙代理时）是否会被缓冲（已做“8 秒没收到首个快照就退回轮询”的兜底）；经代理时 `.local` 名能否解析；本地网络权限提示在 watchOS 上是否出现。
- Personal Team（免费账号）能否使用 App Group 未确认。如果签名因 App Group 失败：在 `project.yml` 里删掉两个 `CODE_SIGN_ENTITLEMENTS` 行重新生成，应用照常工作，只是小组件会一直显示 “Open the app once”。

### 已知限制

- 只在前台联网：手放下、应用进入后台后不再更新；小组件/复杂功能只显示上次打开应用时的计数；没有通知推送（阶段三）。
- ATS 只放开本地网络：`xxx.local`、不带点的名字、IP 可以；`mac.lan`、`*.home.arpa` 这类 DNS 名会被拦截，请用 `.local` 名或 IP。若 `.local` 在手表上解析不了，改用 Mac 的局域网 IP（建议在路由器里给 Mac 固定 IP）。
- 免费 Personal Team 的描述文件 7 天过期，过期后需要从 Xcode 重新安装。
- token 存在 UserDefaults（`@AppStorage` 要求），不在钥匙串；HTTP 明文，仅适合可信局域网。
- 手表排序与服务器 `/sessions` 的排序不同（见上文），是有意的。
- 时钟校正精度约等于局域网单程延迟（毫秒级），对秒级计时足够。
