# ai_status · 阶段一：`aistatusd` 守护进程 + `aistatus` 终端查看器

在本机追踪每个 Claude Code / Codex 会话的实时状态（running / waiting / done），通过局域网 HTTP API 提供给阶段二的 watchOS 应用。Node 22，零 npm 依赖。设计见 [PLAN.md](PLAN.md)。

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
