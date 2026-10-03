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

> **状态（2026-10-03）**：界面已改为“单屏色块”设计（分支 `watch-tiles`，见下文）。用 Xcode 27（Swift 6.4，watchOS 27 SDK）已完成签名的真机构建，macOS 上 386 项检查通过并离屏渲染了 40/44 mm 预览图；**新界面尚未在手表上运行过**（无模拟器运行时）。详见下文“尚未验证”。

### 手表上看到什么

**只有一屏**：不滚动、没有列表、没有详情页。整个屏幕按会话数切成色块，边到边铺满，色块之间是细黑线：

| 会话数 | 布局 |
|---|---|
| 0 | 安静的空状态（“No sessions”，底部一个齿轮按钮） |
| 1 | 整屏一个色块 |
| 2 | 横切一刀：上下两行 |
| 3 | 横切两刀：上中下三行 |
| 4 | 2×2 田字格 |
| >4 | 田字格显示最重要的 4 个，左上角小徽标 “+N” 表示还有几个没显示 |

“最重要”的顺序（手表专用，与服务器不同）：waiting（等最久的在前）→ done（完成最早、晾得最久的在前）→ running（开始最早的在前）。行布局从上到下、田字格从左上到右下按此顺序排列。

每个色块**只显示**三样东西：项目名（尽量大，放不下就缩小 / 换行 / 截断）、一个小工具标记（Claude = ✦，Codex = `</>`；不显示是哪台电脑）、一个自走计时器：

- **running → 灰色**，从 `startedAt` 开始正计时；
- **done → 绿色**，从 `finishedAt` 开始正计时（= 晾了多久；被中断 / 出错的也算 done）；
- **waiting（等审批 / 输入）→ 橙色**，从 `waitingSince` 开始计时，没有则从 `startedAt`。

计时用 SwiftUI 自走文本（`Text(date, style: .timer)`），不需要网络更新也会一直走。常亮显示（Always-On，`isLuminanceReduced`）时色块变暗、文字取对应颜色，计时改为按分钟显示（`12m`、`1h 05m`，每分钟刷新），因为常亮时屏幕大约一分钟才刷新一次，秒数会停住。

**点按（没有详情页）**：

- 点 **done** 色块：`dismissPolicy = swipe`（短任务）→ 立即清除；`confirm`（长任务）→ 色块变深绿并显示 “✕ Tap again”，3 秒内再点一次才清除，否则自动恢复。同一时间只有一个色块处于“再点一次”状态。
- 点 running / waiting 色块：什么都不做。
- 清除走原有的视图模型：先乐观隐藏，`POST /sessions/:id/dismiss` 失败则恢复并弹提示（404 视为已清除）。
- **长按任意位置 → 设置**（主机 / 端口 / token / Test connection，以表单弹层打开）。空状态、连不上、未设置时屏幕上也有设置按钮。

**连接状态**：有色块时，连接问题只在左上角显示一个小标记（红色 Wi-Fi 叹号 = 连不上，黄点 = SSE 断了在轮询），色块保留最后一次的数据；只有在**没有任何色块可显示**时才整屏显示 “Can't reach Mac”（地址、原因、Retry、齿轮）。首次连接时显示天线图标和主机名；未设置主机时引导去设置。

**触感**：应用在前台时，有会话变成 waiting（`.notification`，优先）或 done（`.success`）时震动；打开应用时的第一份快照不震。长任务第一次点按时轻点一下（`.click`）。

**设为默认屏幕（推荐）**：手表上 设置 → 通用 → 返回时钟（Return to Clock）→ 在应用列表里选 AI Status，打开“返回此应用”（Return to App），并把返回时钟的时间设长一些（选项名以手表系统为准）。这样抬腕时显示的就是这一屏，配合常亮显示随时可看。

预览图（macOS 上离屏渲染，40 mm = 162×197 pt，44 mm = 184×224 pt；右上角的 10:09 和圆角是模拟的系统时钟和屏幕形状）：[`watch/previews/`](watch/previews)，总览见 `overview-40mm.png` / `overview-44mm.png`。

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
  scripts/check.sh            不需要手表的全部检查（macOS 上）
  previews/                   40/44 mm 离屏渲染预览图（每种会话数、常亮、再点一次、离线、各状态页）
  AIStatusKit/                Swift 包（macOS 上可 swift build）
    Sources/AIStatusKit       模型/解码、SSE 解析、Endpoint、URLSession 传输、连接循环、时钟、排序、视图模型、App Group 存储；
                              Tiles.swift：色块布局（会话数 → 布局、前 4 个 + “+N”、色块几何）、点按清除状态机、常亮时的分钟格式
    Sources/AIStatusUI        全部 SwiftUI 视图：RootView（单屏 + 设置弹层）、TileBoard（色块）、StateViews（空/连不上/连接中/未设置）、
                              SettingsView、WidgetViews、Samples（预览数据与渲染目录）；watch 专用 API 在 #if os(watchOS) 里
    Sources/AIStatusChecks    可执行测试程序（命令行工具里 XCTest 和 Swift Testing 都不可用）
    Fixtures/                 从真实 aistatusd 抓取的 JSON / SSE 原始字节
    scripts/capture-fixtures.mjs   重新抓取夹具（临时 HOME、关 Bonjour、端口 17779）
    scripts/live-check.mjs         对真实守护进程跑 Swift 联调（临时 HOME、端口 17780，中途重启守护进程）
```

### 不上手表能做的验证

```sh
cd ~/projects/ai_status/watch
./scripts/check.sh                              # swift build + 386 项检查 + App/Widget 入口在 macOS 上类型检查 + plist/YAML 语法
node AIStatusKit/scripts/live-check.mjs         # 再加 32 项：真实 aistatusd 进程上的 SSE、轮询、dismiss、重启重连、局域网 token
RENDER_DIR=previews AIStatusKit/.build/debug/AIStatusChecks   # 重新生成 previews/ 下的预览图（macOS 渲染，计时按“现在”取值）
# watchOS 真机构建（签名，不安装）：
xcodebuild -project AIStatus.xcodeproj -scheme AIStatus -destination 'generic/platform=watchOS' \
  -derivedDataPath DerivedData -allowProvisioningUpdates build
```

检查覆盖：会话数 → 布局（0/1/2/3/4/>4）、前 4 个的选择与 “+N”、色块几何（铺满屏幕、文字区在安全区内且大小一致、细分隔线）、点按清除状态机（短任务一点即清、长任务再点一次、3 秒超时恢复、只能有一个待确认、卡片消失/重新运行时取消）、经视图模型的清除（乐观移除）、waiting 计时起点、常亮时的分钟格式，以及所有界面在 40/44 mm 尺寸下的渲染。

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
9. **手表上**：打开 AI Status。默认主机已是本机名；不对的话**长按屏幕**（或在连不上/空状态页点齿轮）打开设置改主机，点 “Test connection”。如果设置了 `token`，在设置里填上。
10. **设为默认屏幕**：手表 设置 → 通用 → 返回时钟（Return to Clock）→ 选 AI Status，让它保持打开（Return to App）。抬腕即见。
11. **小组件**：长按表盘 → 编辑 → 复杂功能里选 AI Status；或在智能叠放里添加。先打开一次应用，小组件才有数据。

### 尚未验证（没有模拟器运行时，也未装到手表）

- **已验证**：XcodeGen 生成工程；Xcode 27 / watchOS 27 SDK 下 App + 小组件签名真机构建成功，无编译警告（包括 `#if os(watchOS)` 分支：触感、`.textInputAutocapitalization`、小组件家族）；资源目录经 `actool` 编译。
- **新界面在手表上的实际表现**（预览图是 macOS 渲染，字体度量和控件外观与手表略有不同）：
  - 系统时钟的位置和顶部安全区：布局按运行时的安全区计算（顶行色块延伸到时钟下方，文字在安全区内），预览里假设 40 mm 顶部 28 pt、44 mm 31 pt，屏幕圆角为估计值；“+N” 和离线标记放在左上角时钟旁边，真机上是否和系统元素冲突待看。
  - 手势：点按 / 再点一次 / 长按打开设置（`LongPressGesture.exclusively(before: TapGesture)`）的手感和识别、与系统手势是否冲突；设置弹层的关闭按钮。
  - 触感：`.notification` / `.success` / `.click` 的实际感受。
  - 常亮显示：`isLuminanceReduced` 下的变暗配色、`TimelineView(.everyMinute)` 的分钟计时是否按预期刷新；正常亮屏时 `Text(.timer)` 的秒级走字。
  - 色块颜色在 OLED 上的观感、白色系统时钟压在橙/绿色块上的可读性。
- 手表上的网络：`URLSession.bytes` 流式 SSE 在手表上（特别是经 iPhone 蓝牙代理时）是否会被缓冲（已做“8 秒没收到首个快照就退回轮询”的兜底）；经代理时 `.local` 名能否解析；本地网络权限提示在 watchOS 上是否出现。
- Personal Team（免费账号）能否使用 App Group 未确认。如果签名因 App Group 失败：在 `project.yml` 里删掉两个 `CODE_SIGN_ENTITLEMENTS` 行重新生成，应用照常工作，只是小组件会一直显示 “Open the app once”。

### 已知限制

- 只在前台联网：手放下、应用进入后台后不再更新；小组件/复杂功能只显示上次打开应用时的计数；没有通知推送（阶段三）。
- ATS 只放开本地网络：`xxx.local`、不带点的名字、IP 可以；`mac.lan`、`*.home.arpa` 这类 DNS 名会被拦截，请用 `.local` 名或 IP。若 `.local` 在手表上解析不了，改用 Mac 的局域网 IP（建议在路由器里给 Mac 固定 IP）。
- 免费 Personal Team 的描述文件 7 天过期，过期后需要从 Xcode 重新安装。
- token 存在 UserDefaults（`@AppStorage` 要求），不在钥匙串；HTTP 明文，仅适合可信局域网。
- 手表排序与服务器 `/sessions` 的排序不同（见上文），是有意的。
- 超过 4 个会话时只显示最重要的 4 个，其余只计入 “+N”，在手表上看不到也清除不了（等前面的处理掉才会补上来；也可以用 `aistatus dismiss`）。
- running / waiting 色块在手表上不能清除（点按无反应）；卡住的会话用 Mac 上的 `aistatus dismiss <id>` 清除。
- 时钟校正精度约等于局域网单程延迟（毫秒级），对秒级计时足够。
