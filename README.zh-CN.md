[English](README.md) | **简体中文**

# ai_status — 在 Apple Watch 上查看 Claude Code / Codex 会话状态

在本机追踪每个 Claude Code / Codex 会话的实时状态（running / waiting / done），通过局域网 HTTP API 提供给阶段二的 watchOS 应用。Node 22，零 npm 依赖。设计见 [PLAN.md](PLAN.md)。手表应用见下文[阶段二：watchOS 应用](#阶段二watchos-应用)。另一台电脑（Windows 上的 Codex 桌面版）也可以把会话汇报给这台 Mac，见[多台电脑（Windows）](#多台电脑windows)。不想让 Mac 一直开着当中心时，可以改用 Supabase 上的云端中转，见[云端中转（Supabase）](#云端中转supabase)。

## 预览

抬腕一眼看清每个 Claude Code / Codex 会话的状态：灰 = 运行中、橙 = 等待审批、绿 = 已完成，格子按会话数自动切成 1 / 2 / 3 条或田字格。点一格看详情，左滑删除。

![各状态总览](preview/overview.png)

| 三个会话 | 田字格 | 左滑删除 | 详情 |
|---|---|---|---|
| ![](preview/three-sessions.png) | ![](preview/four-sessions-grid.png) | ![](preview/swipe-to-delete.png) | ![](preview/detail-done.png) |

更多渲染图在 `watch/previews/`。


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
| `aistatus token [--read] [--new [--hooks-only \| --shared]]` | 打印远程钩子要用的 token（`--read`：手表要用的 `token`）；`--new` 生成并保存 `token`，`--new --hooks-only` 生成 `hookToken`，`--new --shared` 生成 `token` 并删除 `hookToken`（一个 token 管所有）（见[多台电脑](#多台电脑windows)、[公网地址](#公网地址tailscale-funnel)） |
| `aistatus remote-setup [--public-url URL]` | 打印另一台电脑需要的全部信息：Mac 局域网 IP、端口、token、Windows 安装命令；配置了 `publicUrl` 时安装命令改用 `-BaseUrl <公网地址>` |
| `aistatus public-url [URL \| --clear]` | 查看 / 保存公网地址（例如 `https://<your-mac>.<your-tailnet>.ts.net`），只给 CLI 用，守护进程不读 |
| `aistatus public-status [--show] [--no-probe]` | 公网监听端口是否在运行、token 是否已设置（`--show` 才打印 token 本身）、本机和公网地址的 `/health` 能否访问 |
| `aistatus cloud setup --url URL --hook-token T [--read-token T] [--machine NAME] [--no-probe]` | 云端模式：钩子改发到云端中转（Supabase Edge Function），见[云端中转](#云端中转supabase) |
| `aistatus cloud status [--show] [--no-probe]` / `cloud off` / `cloud on` | 云端配置与连通性检查 / 切回本地守护进程 / 切回云端 |

### 配置 `~/.aistatus/config.json`（均可省略）

```json
{
  "port": 7778,
  "host": "0.0.0.0",
  "swipeThresholdSec": 60,
  "bonjour": true,
  "token": null,
  "hookToken": null,
  "publicPort": 7779,
  "publicUrl": null,
  "machine": null,
  "codex": { "source": "auto", "pollMs": 1500 },
  "idlePruneHours": 24,
  "subagentTimeoutMin": 30
}
```

- `swipeThresholdSec`：运行时长低于此值的已完成卡片 `dismissPolicy = "swipe"`，否则 `"confirm"`。
- `token`：设置后，非本机客户端（手表）需带 `Authorization: Bearer <token>` 或 `?token=<token>`；本机永远放行。它同时也允许别的电脑推送钩子（除非另设了 `hookToken`）。
- `hookToken`：只用于别的电脑推送钩子（`POST /hook/:tool`）。设置后远程钩子必须带它（此时 `token` 不再被远程钩子接受），读取接口不受影响。`token` 和 `hookToken` 都没设时，远程钩子一律 `403`。
- `publicPort`：公网监听端口（给 Tailscale Funnel 之类的隧道用），**只绑定 127.0.0.1**，只有配置了（至少 16 个字符的）`token` 或 `hookToken` 才会启动，否则不启动并在日志里写明原因；设为 `false` 关闭。这个端口上**不按来源地址信任任何请求**，见[公网地址](#公网地址tailscale-funnel)。
- `publicUrl`：隧道的公网地址（`aistatus public-url` 写入），只给 `remote-setup` / `public-status` 用。
- `machine`：本机在卡片 `machine` 字段里的名字，默认取主机名去掉 `.local`（例如 `MyMac`）。
- `subagentTimeoutMin`：主回合已结束、但子代理还在跑的会话保持 running；若这么多分钟内没有任何事件（例如丢了 `SubagentStop`），按最后一次事件的时间记为 done。
- `codex.source`：`auto`（钩子优先，会话文件监听兜底）/ `hooks` / `watcher`。
- 环境变量覆盖：`AISTATUS_PORT`、`AISTATUS_HOST`、`AISTATUS_PUBLIC_PORT`（`off` 关闭）、`AISTATUS_BONJOUR=0`、`AISTATUS_CODEX_SOURCE`、`AISTATUS_DIR`（数据目录）。
- 状态持久化在 `~/.aistatus/state.json`（原子写入），守护进程重启后卡片不丢。旧版本（阶段一/二）写的 state.json 可以直接加载，其中的会话都算本机会话。
- **升级到这个版本后**：重启守护进程，并重新执行一次 `node bin/aistatus.js install-hooks`，才会装上新增的 `SubagentStart` / `SubagentStop` 钩子（已有条目不变）。Codex 只需要在 `/hooks` 里信任这两条**新增**的条目；已经信任过的条目定义没变，信任仍然有效。

## 状态机

| 钩子事件（Claude / Codex） | 结果 |
|---|---|
| `SessionStart` | 建立会话，idle（不显示）；对已有会话不改状态（compact/resume 也会触发） |
| `UserPromptSubmit` | running，记录 `startedAt`；done 会话重新开始计时 |
| `Notification`（`permission_prompt`、`elicitation_dialog`、`agent_needs_input`）/ `PermissionRequest` / `PreToolUse(AskUserQuestion)` | waiting |
| `PostToolUse` / `PostToolUseFailure` / `PermissionDenied`（waiting 之后） | 回到 running |
| `SubagentStart` / `SubagentStop`（带 `agent_id`） | 记录 / 移除该会话正在运行的子代理 |
| `Stop`（仍有子代理在运行，例如后台子代理） | **保持 running**，记下最后一条回复；最后一个 `SubagentStop` 到达时才变 done（`finishedAt` = 那一刻，`runDurationMs` 从 `startedAt` 算起） |
| `Stop` / `StopFailure` / Codex `Interrupt` | done，记录 `finishedAt`、`runDurationMs`、最后一条回复摘要；`StopFailure` / `Interrupt` 同时清空子代理 |
| `SessionEnd` | 已 done 的保留卡片（`ended: true`）直到清除，否则删除 |
| dismiss | 隐藏卡片（会话变 idle；已结束的会话直接删除）。之后同一轮的迟到事件不会让它复活，新的 prompt 会 |

`Notification` 的 `idle_prompt`（完成 60 秒后的“等待输入”提醒）被忽略，不会把 done 变成 waiting。守护进程宕机期间错过开头的会话，收到后续事件时会以 `startedAtApprox: true` 补建卡片。

子代理的防卡死：新的 `UserPromptSubmit` 会清空子代理列表；`SessionEnd` 也会清空（若主回合已结束则记为 done）；子代理内部的工具事件（带 `agent_id`）不会让已经 done 或已清除的卡片复活；若某个 `SubagentStop` 丢了，会话在 `subagentTimeoutMin`（默认 30 分钟）内没有任何事件后自动记为 done。依据：Claude Code 文档说明 `SubagentStart` 对后台子代理也会触发、子代理内的钩子事件带 `agent_id`、`Stop` 只表示主回合回复结束；Codex 文档说明子代理钩子使用父会话的 `session_id` 并带 `agent_id`。Codex 的子代理是否会在 `Stop` 之后继续运行，文档没有说明，逻辑对两者一致。

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
      "machine": "MyMac",
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
      "activeSubagents": 0,
      "updatedAt": 1790959420000
    }
  ]
}
```

| 字段 | 说明 |
|---|---|
| `id` | 卡片主键：本机会话 `<tool>:<sessionId>`，别的电脑的会话 `<tool>@<machine>:<sessionId>`（两台电脑的同一 sessionId 不会冲突）。用于 dismiss，客户端应当把它当作不透明字符串 |
| `tool` | `claude` \| `codex` |
| `machine` | 会话所在电脑的名字（本机为 `machine` 配置或主机名；远程为发送方提供的名字，已清洗，≤32 字符）。旧版守护进程没有此字段 |
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
| `activeSubagents` | 仍在运行的子代理数（>0 时即使主回合已结束也保持 running） |

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

`{"ok":true,"name":"aistatusd","version":"0.1.0","machine":"MyMac","remoteHooks":false,"pid":…,"startedAt":…,"serverTime":…,"sessions":3,"sseClients":1}`

`remoteHooks`：当前进程是否接受别的电脑推送钩子（配置了 `hookToken` 或 `token`）。局域网端口上还有 `"public":{"listening":true,"port":7779,"read":true,"hook":true}`（公网监听端口的状态）。

公网监听端口上：不带有效 token 只返回 `{"ok":true}`；带读取 token（`token`）返回上面的完整信息（不含 `pid` 和 `public`）。

### `POST /hook/:tool`

`:tool` 为 `claude` 或 `codex`，请求体为钩子原始 JSON。由钩子转发脚本调用，手表不需要使用。

- **回环地址**（本机 `aistatus-hook`）：永远接受，会话属于本机，`?machine=` 被忽略。
- **其他地址**（别的电脑）：没有配置 `hookToken`/`token` → `403`；`Authorization: Bearer <hookToken 或 token>` 缺失或不对 → `401`（常数时间比较；钩子**不接受** `?token=`）。通过后，电脑名取 `?machine=<名字>`，其次请求头 `X-AIStatus-Machine`，都没有则用对方 IP；名字只保留字母、数字、`.`、`_`、`-`（其余变 `-`），最长 32 字符。

### `GET /setup/aistatus-hook.ps1`、`GET /setup/install-windows.ps1`

返回仓库里的这两个 PowerShell 脚本（`text/plain`，不需要 token，不含任何秘密），供 Windows 上一行命令安装。**只在局域网端口提供**，公网监听端口不提供。

### 错误与认证

错误响应为 `{"error":"…"}`。配置了 `token` 时，非本机请求缺少/错误 token 返回 `401`。公网监听端口的规则不同（所有请求都要 token），见[公网地址](#公网地址tailscale-funnel)。

## 钩子转发脚本

`hooks/aistatus-hook.sh <claude|codex> [port]`：`curl` 读取 stdin，POST 到 `127.0.0.1`，连接超时 0.5s、总超时 2s，输出全部丢弃，**始终 exit 0**。守护进程未运行时立即返回（实测冷启动首次约 180ms），正常转发实测每次约 10–45ms。Claude 钩子 `timeout: 5`，Codex `timeout: 3`（Codex 的 SessionEnd 上限 3 秒）。存在 `~/.aistatus/cloud.curl` 时（`aistatus cloud setup`）改发到云端中转，并且只发会改变卡片的事件，见[云端中转](#云端中转supabase)。

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
- 默认无认证：局域网内任何人都能读取项目名、路径、消息摘要并 dismiss；在不可信网络请设置 `token`。仅 IPv4 `0.0.0.0` 监听。远程钩子默认关闭，需要 token 才能打开。公网监听端口（`7779`，只绑 127.0.0.1）没有 token 不启动，所有请求都要 token。
- Codex 钩子与会话文件中的 session id 是否一致未验证（通过 `transcript_path` 去重兜底）；Codex 桌面版里钩子信任界面如何出现未验证。
- 卡片排序、时间都由服务器给出绝对时间；手表需自行处理时钟偏差（用 `serverTime`）。

## 多台电脑（Windows）

让另一台电脑（例如装了 **Codex 桌面版的 Windows PC**）把它的 Codex 会话汇报给这台 Mac。Mac 是中心：手表仍然只连 Mac，就能同时看到两台电脑的会话。卡片界面上不区分是哪台电脑（JSON 里有 `machine` 字段，只用来保证两台电脑的会话 id 不冲突）。

```
Windows: Codex ─钩子→ aistatus-hook.ps1 ─HTTP POST（Bearer token）→ Mac: aistatusd ─→ 手表
```

### 前提

- 两台电脑在**同一个局域网**（同一个 Wi-Fi / 路由器），Windows 能访问 Mac 的 IP。公司 / 学校网络里如果开了客户端隔离（AP isolation），两台机器互相访问不了：这时改用[公网地址](#公网地址tailscale-funnel)。
- 建议在路由器里给 Mac 固定 IP（DHCP 保留），否则 Mac 的 IP 变了要在 Windows 上重新运行安装脚本（只改配置文件，不需要重新信任钩子）。

### 第一步：Mac 上

```sh
cd ~/projects/ai_status
node bin/aistatus.js token --new --hooks-only   # 生成 token，存为 ~/.aistatus/config.json 的 "hookToken"（权限 600）
# 重启守护进程使其生效（前台运行的：Ctrl-C 后重新 node bin/aistatus.js daemon；
#   用 launchd 的：launchctl kickstart -k gui/$(id -u)/com.aistatus.daemon）
node bin/aistatus.js remote-setup                # 打印 Mac 的局域网 IP、端口、token 和 Windows 上要执行的命令
```

- 推荐 `--hooks-only`：它只保护“别的电脑推送钩子”，手表照常连接、**不用**在手表上输入 token。若改用 `aistatus token --new`（存为 `"token"`），局域网读取也会被保护，那就必须在手表设置里填上这个 token，否则手表显示 token 错误。
- `remote-setup` 最后一行的 “Daemon:” 会告诉你正在运行的守护进程有没有加载 token（显示 `remote hooks enabled` 才算好）。
- **macOS 防火墙**：如果开着（系统设置 → 网络 → 防火墙），要允许 `node` 接受传入连接（手表能连上说明已经允许过了）。

### 第二步：Windows 上（PowerShell 或 cmd）

**方式 A：一行命令安装**（脚本从 Mac 的守护进程下载）：把 `remote-setup` 打印的 “one-line install” 那一行原样粘贴执行，形如：

```bat
powershell -NoProfile -ExecutionPolicy Bypass -Command "& ([scriptblock]::Create((New-Object Net.WebClient).DownloadString('http://192.168.1.20:7778/setup/install-windows.ps1'))) -MacHost 192.168.1.20 -Port 7778 -Token '你的token'"
```

**方式 B：复制文件**：把仓库里的 `hooks\aistatus-hook.ps1` 和 `scripts\install-windows.ps1` 按原目录结构拷到 Windows（U 盘、共享文件夹或 `git clone` 都行），在仓库目录执行：

```bat
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-windows.ps1 -MacHost 192.168.1.20 -Port 7778 -Token "你的token"
```

可选参数：`-Machine 办公室PC`（电脑名，默认是 Windows 的计算机名）、`-SkipTest`（不做连通测试）、`-Uninstall`（卸载）。

安装脚本做的事：
1. 写 `%USERPROFILE%\.aistatus\config.json`：`{ "host", "port", "token", "machine" }`；
2. 把转发脚本放到 `%USERPROFILE%\.aistatus\aistatus-hook.ps1`；
3. 把钩子**合并**进 `%USERPROFILE%\.codex\hooks.json`：先备份到 `%USERPROFILE%\.aistatus\backups\codex-hooks.<时间>.json`；文件不是合法 JSON 时拒绝修改；重复执行无变化；`-Uninstall` 只删除命令里含 `aistatus-hook` 的条目。事件与 Mac 上的 Codex 钩子完全一致：`SessionStart`、`UserPromptSubmit`、`PermissionRequest`、`PostToolUse`、`SubagentStart`、`SubagentStop`、`Stop`、`Interrupt`、`SessionEnd`，`timeout: 3`；
4. 发一个测试请求（一个不会显示成卡片的 `SessionStart`），告诉你结果：OK / token 不对（401）/ Mac 没开远程钩子（403）/ 连不上（IP、防火墙、守护进程没运行、Mac 睡眠）。

钩子命令是固定的一行（换 IP/端口/token 只改 `config.json`，命令不变，Codex 不会要求重新信任）：

```
powershell -NoProfile -ExecutionPolicy Bypass -File "C:/Users/<你>/.aistatus/aistatus-hook.ps1"
```

转发脚本从标准输入读原始字节（不经过控制台代码页，中文不会乱码），POST 到 `http://<Mac>:<端口>/hook/codex?machine=<电脑名>`，带 `Authorization: Bearer <token>`，每一步网络超时 1 秒、不走代理（配置了 `url` 时改发到 `<url>/hook/codex?…`，每步 1.4 秒，见[公网地址](#公网地址tailscale-funnel)）；无论成功失败都**没有任何输出、退出码 0**，不会阻塞或影响 Codex。

### 第三步：在 Codex 里信任钩子（一次）

Codex 对新钩子按定义的哈希做信任校验，未信任的钩子会被跳过（什么也不会发送）。打开 Codex：CLI 里输入 `/hooks` 审核并信任这 9 条 aistatus 钩子；桌面版里在出现钩子审核提示时确认。之后在 Windows 上发一条消息，手表 / `aistatus list` 上应该出现对应的卡片。

### 排查

- 在 Mac 上看日志：远程钩子会记成 `hook codex@<电脑名> UserPromptSubmit …`（前台运行看终端，launchd 看 `~/.aistatus/daemon.log`）。
- Windows 上重新运行安装脚本即可再做一次连通测试。手动测试：`powershell -NoProfile -Command "Invoke-WebRequest -UseBasicParsing http://<Mac IP>:7778/health"`。
- `.local` 名字在 Windows 上不一定能解析，`-MacHost` 请用 IP。

### 尚未验证（这里没有 Windows 电脑）

以下内容只做了静态检查（脚本纯 ASCII、事件列表与 Mac 安装器一致的单元测试），**PowerShell 脚本从未实际运行过**（本机也没有 `pwsh`）：

- 两个 `.ps1` 在 Windows PowerShell 5.1 上的语法和行为，包括 `ConvertFrom-Json` / `ConvertTo-Json` 合并 `hooks.json` 的结果（已用 `Remove-TypeData System.Array` 规避 5.1 把数组序列化成 `{"value":…,"Count":…}` 的已知问题；写文件不带 BOM）。
- Codex 在 Windows 上用什么 shell 执行钩子命令，官方文档没有写（只提到可选的 `commandWindows` 字段）。命令写成在 cmd、PowerShell 和 POSIX shell 里都能解析的形式（路径用正斜杠并加引号），但没实测。如果 Codex 在 WSL 里运行代理，则钩子大概率在 Linux 里执行，这个脚本不适用。
- Codex 桌面版在 Windows 上的钩子信任界面在哪里出现。
- 每次钩子都要启动一次 `powershell.exe`（通常几百毫秒），`PostToolUse` 每个工具调用都会触发，Codex 会因此每次多等这么久；`timeout: 3` 内应该足够，但没测过冷启动最慢的情况。没有使用文档里的 `async: true`，因为异步执行可能让事件乱序（例如工具事件晚于 `Stop` 到达）。
- Windows 上 Codex 钩子 payload 的 `cwd` 是否为 `C:\…` 形式（项目名同时兼容 `\` 和 `/` 两种分隔符）。

已在本机验证（`node scripts/e2e-remote.mjs`）：用 curl 对 Mac 的局域网 IP 发送与 PowerShell 脚本完全相同的请求（同样的 URL、请求头、UTF-8 原始字节），覆盖 403 / 401 / 200、完整的 Codex 回合（含子代理）、中文文本、同一 sessionId 在两台电脑上不冲突、电脑名回退与清洗、手表方式的 dismiss、重启后持久化、Mac 不可达时发送方 1 秒左右放弃，以及一行安装命令要下载的两个脚本。

## 公网地址（Tailscale Funnel）

学校 / 公司 Wi-Fi 常常禁止设备之间互访（客户端隔离），手表（经 iPhone）和 Windows 电脑都连不到 Mac 的 `7778`。办法：用 **Tailscale Funnel** 把守护进程放到一个固定的公网 HTTPS 地址上，例如 `https://<your-mac>.<your-tailnet>.ts.net`。Funnel 在 Tailscale 那边终止 TLS，再把请求转发到 Mac 上 `127.0.0.1` 的一个端口。

```
手表 ─HTTPS─┐                          ┌→ 127.0.0.1:7779 公网监听端口（每个请求都要 token）
Windows ─HTTPS┴→ Tailscale Funnel 中继 ─┘   127.0.0.1/局域网:7778 原来的端口（行为不变）
```

### 为什么是单独的端口

反向代理转发过来的请求在守护进程看来**全部来自 127.0.0.1**。而 `7778` 信任回环地址（本机钩子和 CLI 不需要 token），如果把隧道指向 `7778`，等于整个互联网都能读你的会话、推送钩子、删除卡片。所以守护进程另开一个**公网监听端口**（`publicPort`，默认 `7779`）：

- 只绑定 `127.0.0.1`，局域网上也访问不到；只有隧道（或本机进程）能连。
- 只有配置了 token 才启动；没有 token 时不启动，并在日志里写 `public listener not started: no token configured…`。
- **不按来源地址信任任何请求**：每个接口都要 `Authorization: Bearer <token>`（常数时间比较）；**不接受** `?token=`。
- 例外只有 `GET /health`：不带有效 token 时只返回 `{"ok":true}`，不含任何细节（方便检查隧道是否通）。
- 不提供 `/setup/*.ps1`，也不提供任何含 token 的内容。
- 从这个端口进来的钩子一律算**远程钩子**：电脑名取 `?machine=` / `X-AIStatus-Machine`，都没有时取代理追加的客户端 IP（`X-Forwarded-For` 最右边一项），再没有就是 `remote`；**永远不会**被当成本机会话（即使电脑名和 Mac 同名，id 也是 `codex@<名字>:<id>`）。
- 加固：请求体上限 1 MiB（钩子；dismiss 16 KiB），超过返回 `413`；同时最多 8 个 SSE 连接，再多返回 `503`；同一客户端（按 `X-Forwarded-For` 最右项区分，没有则按连接地址）1 分钟内 10 次**错误 token** 之后返回 `429`，直到这一分钟结束（完全没带 `Authorization` 的请求——例如扫描器——只返回 `401`，不计数，避免把你自己的手表锁在外面）；请求头 10 秒、整个请求 30 秒超时；最多 64 个连接。
- 日志里不会出现 token（也不记录查询字符串）。
- `7778` 的行为**完全不变**：本机钩子和 CLI 照常不需要 token。

### token 的含义

| 配置 | 公网端口上的读取（`/sessions`、`/events`、完整 `/health`、dismiss） | 公网端口上的钩子（`POST /hook/:tool`） |
|---|---|---|
| 只有 `token` | `token` | `token`（一个 token 管所有） |
| `token` + `hookToken` | 只认 `token` | 只认 `hookToken`（`token` 不行） |
| 只有 `hookToken` | 全部拒绝（`401`） | `hookToken` |

- 推荐两个分开：手表里只有读取 token，Windows 上只有钩子 token，任一个泄露影响面更小。`aistatus token --new` 生成 `token`，`aistatus token --new --hooks-only` 生成 `hookToken`；想用一个就 `aistatus token --new --shared`。
- 公网端口只接受至少 16 个字符的 token（`--new` 生成的是 32 个字符）。
- 设置了 `token` 后，局域网上（非本机）的读取也需要它（和以前一样）。

### 上线步骤

1. **Mac：生成 token 并重启守护进程**
   ```sh
   cd ~/projects/ai_status
   node bin/aistatus.js token --new                # "token"：手表用（已有就不用再生成，否则旧 token 失效）
   node bin/aistatus.js token --new --hooks-only   # "hookToken"：Windows 用（已有就不用再生成）
   launchctl kickstart -k gui/$(id -u)/com.aistatus.daemon
   node bin/aistatus.js public-status              # 应显示 public listener up on 127.0.0.1:7779
   ```
2. **Mac：打开 Funnel（你自己执行，aistatus 不会碰 Tailscale）**
   ```sh
   tailscale funnel --bg 7779
   node bin/aistatus.js public-url https://<your-mac>.<your-tailnet>.ts.net
   node bin/aistatus.js public-status              # public probe: … HTTP 200 {"ok":true}，with token: OK
   ```
   注意是 `7779`（公网监听端口），**不要**把 Funnel 指向 `7778`。
3. **手表：把地址和 token 编进应用**（不用在手表上输入 32 位 token）
   ```sh
   cd watch
   ./scripts/generate.sh --host https://<your-mac>.<your-tailnet>.ts.net --token "$(node ../bin/aistatus.js token --read)"
   ```
   然后在 Xcode 里重新装到手表。`https://` 地址不写端口就是 443（设置里的端口只用于局域网 http）。如果以前在手表设置里改过主机或 token，手表会继续用你改过的值：长按 → 设置，点 “Use https://…” 和 “Use built-in token”。
4. **Windows：改用公网地址**：`aistatus remote-setup` 会打印带 `-BaseUrl` 的安装命令。新版转发脚本必须到 Windows 上（旧版不认 `url`）：在和 Mac 同一网络时用一行命令安装（它从局域网端口下载脚本；公网地址不提供脚本），或者把 `hooks\aistatus-hook.ps1`、`scripts\install-windows.ps1` 拷过去执行：
   ```bat
   powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-windows.ps1 -BaseUrl https://<your-mac>.<your-tailnet>.ts.net -Token "<hookToken>"
   ```
   配置文件多了 `"url"`，转发脚本优先用它（`https`、不写端口，显式开启 TLS 1.2，每步超时 1.4 秒）；`-MacHost <ip>` 且不带 `-BaseUrl` 重新运行即切回局域网。**钩子命令行和 `timeout` 没变，`hooks.json` 里的条目和以前完全一样，Codex 不需要重新信任**（只要 Windows 上已经装过阶段三的版本）。

### 经过第三方的数据

- 所有流量经过 Tailscale 的 Funnel 中继服务器。按 Tailscale 的说明，TLS 在你 Mac 上的 `tailscaled` 终止（证书和私钥在 Mac 上），中继只按 SNI 转发加密的 TCP 流、看不到内容；它能看到的是连接元数据：手表 / Windows 的公网 IP、连接时间和流量大小。内容的保密依赖 Tailscale 的实现和 Tailscale 软件本身（`tailscaled` 解密后再转给 `127.0.0.1:7779`），经过的内容包括：项目名、会话状态和时间、最后一条消息摘要（最多 160 字）、Windows 的 `cwd` 路径和电脑名、钩子原始 JSON（含提示词、工具名、工具输出片段），以及 token（在请求头里）。
- 公网地址的主机名会出现在公开的证书透明度日志里，任何人都可能找到它并来扫描；没有 token 只能拿到 `{"ok":true}` 和 `401`。
- token 只在 HTTPS 里传输；`public-status` 只有在地址是 `https://` 时才发 token 做测试。
- 不想用时：`tailscale funnel --bg 7779 off`（或 `tailscale funnel reset`），并可在配置里设 `"publicPort": false`。

已在本机验证：`test/public.test.js`（无 token 不启动、未认证 401、错误 token / `?token=`、读取、`hookToken` 与读取 token 的分工、最小 `/health`、不提供安装脚本、请求体上限、SSE 上限、错误 token 限流、`7778` 行为不变、日志不含 token）；`node scripts/e2e-public.mjs`（独立守护进程 + 模拟 Funnel 的本地反向代理，覆盖上述各项、按 PowerShell 脚本格式发送的远程钩子、SSE 推送、手表方式的 dismiss、CLI 的 `public-status` / `remote-setup`）；`watch/scripts/check.sh`（`https://` 地址解析、所有请求包括 SSE 都带 Bearer、`generate.sh` 的转义与 Xcode 展开结果）；用假地址和假 token 做的 watchOS 真机构建，构建产物 Info.plist 里是完整的 `https://…` 和 token。

### 尚未验证

- 真实的 Tailscale Funnel 没有在这里测试（按要求没有碰 Tailscale）。本机用一个模拟隧道的本地反向代理测试过（`scripts/e2e-public.mjs`）。
- Funnel 是否附带 `X-Forwarded-For`（以及是不是真实客户端 IP）未确认；没有的话所有公网客户端共享一个“错误 token 计数”，有人故意发错 token 时可能让你的手表也暂时收到 `429`（最多 1 分钟）。
- 手表经 iPhone 走 HTTPS 时 SSE 是否被缓冲（已有 8 秒无快照退回轮询的兜底）；Funnel 对长连接的空闲超时（守护进程每 15 秒发心跳）。
- Windows 上的 `url` / TLS 1.2 分支没有实际运行过（这里没有 Windows / PowerShell）。转发脚本不走系统代理（`Proxy = $null`）；如果学校网络强制走 HTTP 代理才能上外网，钩子会发不出去。

## 云端中转（Supabase）

Mac 当中心有两个问题：Mac 必须一直开着，Tailscale Funnel 隧道不稳定。云端中转把“中心”搬到 Supabase（免费版）的一个 **Edge Function** 上：Mac 和 Windows 的钩子都直接发给它，手表也直接读它，**哪台电脑都不需要一直开着，也不需要隧道**。

```
Mac 钩子 ──────HTTPS──┐
Windows 钩子 ──HTTPS──┼→ Edge Function "aistatus" ──→ Postgres 表 aistatus_sessions
手表（轮询）──HTTPS──┘   https://<ref>.supabase.co/functions/v1/aistatus
```

- **协议不变**：函数提供和守护进程一样的接口和 JSON（`POST /hook/:tool`、`GET /sessions`、`POST /sessions/:id/dismiss`、`GET /health`），只是都在函数地址下面（`<base>/sessions` 等）。没有 SSE：`GET /events` 返回 `501`，手表就只轮询（见下文）。
- **状态机是同一份代码**：`src/core.js`（纯 JS，不依赖 Node）同时被守护进程和函数使用；`scripts/build-supabase.mjs` 把它和 `src/hub/*.js` 拼成一个文件 `supabase/functions/aistatus/index.ts`（已提交，测试会检查它和源码一致），在网页编辑器里整个粘贴即可。
- **每个钩子都是“远程”的**，带电脑名：Mac 上的会话 id 也变成 `claude@<Mac 名>:<id>`（和 Windows 一样）。
- **token**（函数的 Secrets，至少 16 个字符，常数时间比较，日志里不出现）：

  | Secret | 用途 |
  |---|---|
  | `AISTATUS_READ_TOKEN` | 手表 / `aistatus list`：`GET /sessions`、dismiss、完整 `/health` |
  | `AISTATUS_HOOK_TOKEN` | 钩子：`POST /hook/:tool`（不设时用读取 token；设了之后两者互不通用） |
  | `AISTATUS_STORE_DETAILS` | 可选，设为 `1` 才保存项目名（只取文件夹名，不存完整路径）和最多 160 字的消息摘要 |

  和公网监听端口一样：`?token=` 无效；未认证的 `GET /health` 只返回 `{"ok":true}`；token 没配置时其他请求返回 `503`。
- **默认只存最少的数据**：工具、电脑名、会话 id、状态、时间戳、子代理 id。不存路径、提示词、消息、工具输出、错误文本。手表详情页没有项目名时显示电脑名。
- **并发**：钩子会同时到达（例如几个子代理同时开始）。每个会话一行，带 `version` 列；函数读出 `(state, version)`，在 JS 里跑状态机，再用 `UPDATE … WHERE id = $1 AND version = <读到的值>` 写回（新会话用 `INSERT`，主键冲突即失败）；影响 0 行说明中间有人写过，就从读开始重来（最多 30 次，带抖动退避）。每一步都是一条 SQL 语句，不在 JS 运行期间持有行锁（PostgREST 每个请求是独立事务，`select … for update` 的锁跨不过 JS 那一步；把状态机改写成 plpgsql 又会有两份逻辑）。测试里 12 个并发钩子打同一个会话，一个都不丢；去掉版本检查的对照实验会丢。
- **表的权限**：开启 RLS 且没有任何策略；`anon` / `authenticated` 角色没有表权限；只有函数用项目的 secret（service_role）key 访问。

### 发送端：只发有用的事件（省调用次数）

免费版每月 50 万次函数调用，每个钩子请求算一次（`401` 也算）。所以云端模式下转发脚本**在本机先过滤**，只发会改变卡片的事件：

| 事件 | 是否发送 |
|---|---|
| `SessionStart`、`Notification` 的 `idle_prompt` / `auth_success`、其他未知事件 | 从不发送 |
| `UserPromptSubmit`、`Stop` / `StopFailure` / `Interrupt`、`SessionEnd`、`SubagentStart` / `SubagentStop`、`PermissionRequest`、权限类 `Notification`、`AskUserQuestion` 的 `PreToolUse` | 发送 |
| `PostToolUse` 等工具活动 | 只有在本机标记文件（`~/.aistatus/marks/<tool>-<session>`）表明这个会话正在等待（发过权限请求）或刚 `Stop`（可能是继续执行）时才发一次，发完删除标记 |

- 工具活动和超过 256 KiB 的请求只发一个很小的 JSON（会话 id、事件名、`agent_id`、`notification_type`、`tool_name`、`cwd`），工具输出不会离开电脑。
- Mac（`hooks/aistatus-hook.sh`）和 Windows（`hooks/aistatus-hook.ps1`）用同一张表（测试会对比两边）。Windows 脚本不管发给谁（局域网、Funnel、云端）都这样过滤；Mac 脚本只在云端模式下过滤，本地守护进程模式和以前完全一样。
- 云端模式下 Mac 钩子同步发送（保证顺序），连接超时 2 秒、总超时 2.5 秒；Windows 每步 1.4 秒。云端不可达时钩子最多拖慢这一次事件，始终 exit 0、没有输出。

**估计用量**（每次 = 一次函数调用）：

| 来源 | 次数 |
|---|---|
| 一轮对话（提示 + 完成） | 2 |
| 一次权限等待（Claude：`PermissionRequest` + 权限 `Notification` + 之后的第一个 `PostToolUse`；Codex 少一次） | 2–3 |
| 一个子代理（开始 + 结束） | 2 |
| 一个会话结束 | 1 |
| 手表亮屏且应用在前台：每 5 秒一次 `GET /sessions`（抬腕回来立即一次） | 12 / 分钟 |
| 终端实时视图 `aistatus`（云端模式下也是轮询，默认 5 秒） | 12 / 分钟 |

典型的一天：3 个并行会话、150 轮对话、50 次权限等待、30 个子代理 ≈ 300 + 150 + 60 + 20 ≈ **550 次钩子**；手表抬腕 100 次、每次亮屏约 10 秒 ≈ **300 次轮询**。合计约 **1,000 次/天，约 3 万次/月**，是免费额度的 6%。最坏情况：手表应用在前台亮屏 8 小时 ≈ 5,800 次/天，加上钩子也只有约 20 万次/月。数据库只有几十行，流量每月几 MB，远低于免费额度（500 MB 数据库、5 GB 出流量）。

### 手表：只轮询

- 函数的 `GET /events` 返回 `501`：手表第一次连上时试一次 `/events`，之后就只轮询 `GET /sessions`，不再重试 SSE，也**不显示**黄色“轮询中”标记（在云端这是正常状态）。连续 2 次轮询失败才显示离线标记。
- **只在应用亮屏时轮询**：手腕放下（`.inactive`，常亮显示）时停止，抬腕回到前台立即轮询一次。（连本地守护进程且 SSE 正常时不变：放下手腕也保持连接。）
- 轮询间隔：手表 设置（长按）→ **Refresh**：3 / 5（默认）/ 10 / 15 / 30 / 60 秒。
- 地址可以带路径：`https://<ref>.supabase.co/functions/v1/aistatus`，所有请求都在这个路径下面。

### 上线步骤

**A. Supabase 网页上（你来做）**

1. 打开 <https://supabase.com/dashboard>，选一个项目。可以用已有的项目（表名、函数名都带 `aistatus`，不会和别的东西冲突），也可以新建一个免费项目（Region 选离你近的，例如 Singapore / Tokyo）。项目地址里的 `<ref>` 就是 `https://<ref>.supabase.co` 那一段。
2. **建表**：左侧 **SQL Editor** → New query → 把 `supabase/schema.sql` 全部粘贴进去 → **Run**。可以重复执行。**Table Editor** 里会出现 `aistatus_sessions`（标着 RLS enabled）。
3. **生成两个 token**（在 Mac 终端里，各执行一次，记下来）：
   ```sh
   node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"
   ```
4. **设置 Secrets**：左侧 **Edge Functions** → **Secrets** → 添加 `AISTATUS_READ_TOKEN` = 第一个 token、`AISTATUS_HOOK_TOKEN` = 第二个 token（想在手表详情里看到项目名和消息，再加 `AISTATUS_STORE_DETAILS` = `1`）→ Save。
5. **部署函数**：**Edge Functions** → **Deploy a new function** → **Via Editor** → 函数名填 **`aistatus`** → 删掉模板代码，把 `supabase/functions/aistatus/index.ts` 的**全部内容**粘贴进去 → **Deploy function**（10–30 秒）。
6. **关掉 JWT 校验**（必须）：打开函数 `aistatus` 的详情 / 设置页，把 **Verify JWT**（也可能叫 “Enforce JWT Verification” / “Verify JWT with legacy secret”）关掉并保存。否则 Supabase 会在函数运行前用 `401` 拒绝所有请求——我们的 token 不是 Supabase 的 JWT，函数自己检查。
   （用 Supabase CLI 的话等价于 `supabase functions deploy aistatus --no-verify-jwt`；这里没有用 CLI。）
7. 检查：`curl https://<ref>.supabase.co/functions/v1/aistatus/health` 应返回 `{"ok":true}`。返回 `401` 说明第 6 步没生效；`404` 说明函数名或地址不对。

**B. Mac 上**

```sh
cd ~/projects/ai_status
node bin/aistatus.js cloud setup --url https://<ref>.supabase.co/functions/v1/aistatus \
  --hook-token <第二个 token> --read-token <第一个 token>
node bin/aistatus.js cloud status     # health / hook token / read token 三项都应是 OK
node bin/aistatus.js list             # 云端模式下 list / dismiss / health / 实时视图都读云端（--local 读本地守护进程）
```

- `cloud setup` 写 `~/.aistatus/cloud.json`（给 CLI 用）和 `~/.aistatus/cloud.curl`（给转发脚本用，含钩子 token），都是 600 权限，并刷新 `~/.aistatus/bin/aistatus-hook`。**`~/.claude/settings.json` 和 `~/.codex/hooks.json` 一个字节都不改**，Codex 不需要重新信任。之后的新事件立刻发往云端（不用重启 Claude / Codex）。
- 电脑名默认是这台 Mac 的名字，`--machine <名字>` 可改。
- 守护进程可以继续运行（收不到钩子了，但随时可以 `cloud off` 切回去），也可以停掉：`launchctl bootout gui/$(id -u)/com.aistatus.daemon`。Funnel 不再需要：`tailscale funnel --bg 7779 off`（你自己执行）。
- `cloud status` 末尾会打印 Windows 安装命令和手表的 `generate.sh` 命令（加 `--show` 显示 token）。

**C. Windows 上**

把新版 `hooks\aistatus-hook.ps1` 和 `scripts\install-windows.ps1` 拷过去（保持目录结构），在 PowerShell 或 cmd 里：

```bat
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-windows.ps1 -BaseUrl https://<ref>.supabase.co/functions/v1/aistatus -Token "<第二个 token>"
```

应看到 `test: OK, the hub accepted a hook from '<电脑名>'`（测试发的是一个函数会忽略的事件，不会产生卡片）。`-BaseUrl` 现在可以带路径。钩子命令行和 `timeout` 不变，**Codex 不需要重新信任**。

**D. 手表**

```sh
cd watch
./scripts/generate.sh --host https://<ref>.supabase.co/functions/v1/aistatus --token <第一个 token>
```

然后在 Xcode 里重新装到手表（免费开发者账号 7 天签名照旧）。如果以前在手表设置里改过主机或 token：长按 → 设置，点 “Use https://…” 和 “Use built-in token”。

### 回滚

- **Mac**：`node bin/aistatus.js cloud off`，钩子立刻改回发给本地守护进程（守护进程要在运行）。`cloud on` 再切回云端（配置还在）。
- **Windows**：用原来的地址重新运行安装脚本，例如 `-BaseUrl https://<your-mac>.<your-tailnet>.ts.net -Token "<hookToken>"` 或 `-MacHost <ip>`。新版脚本对守护进程同样适用（过滤规则对守护进程的结果一样）。
- **手表**：用原来的 `--host` / `--token` 重新 `generate.sh` 并安装，或在手表设置里改。
- **代码**：改动前的版本打了标签 `v1-mac-hub-tailscale`（`git checkout v1-mac-hub-tailscale`）。守护进程的 `state.json` 格式没有变。
- **Supabase**：删除函数 `aistatus`；SQL Editor 里 `drop table public.aistatus_sessions;`。

### 经过第三方的数据

- Supabase 能看到：默认只有电脑名、会话 id、状态和时间（开了 `AISTATUS_STORE_DETAILS` 还有项目文件夹名和消息摘要），以及请求的 IP 和时间。钩子 token / 读取 token 在请求头里（HTTPS）。
- 云端模式下，工具活动事件只发精简 JSON；其他事件（提示、完成、权限请求等）仍然发原始钩子 JSON（可能包含提示词、`cwd`、工具输入），**函数在保存前丢弃**这些字段，但它们经过了 Supabase 的网络和函数运行时。
- 免费项目 7 天没有活动会被暂停（暂停后函数也不可用，需要在网页上恢复）；平时钩子和手表请求应该算作活动（未验证）。

### 已在本机验证

- `npm test`：状态机（`test/store.test.js`，守护进程的全部原有测试）、函数请求处理（`test/hub.test.js`：认证矩阵、最少数据 / 详细模式、并发竞争、dismiss、清理）、打包后的 `index.ts` 本身（`test/hub-bundle.test.js`：用假的 `Deno` 全局对象和模拟 PostgREST 的假 supabase-js 客户端运行打包文件，覆盖环境变量、key 的选择、`Deno.serve`、并发）、真实转发脚本 → 本地 Node 服务器（挂载同一个处理函数）→ 手表格式（`test/cloud.test.js`：事件过滤和调用次数、`cloud setup/status/off/on`、设置文件逐字节不变、`list/dismiss/health`、`cloud off` 后回到本地守护进程），Windows 脚本与 Mac 脚本过滤表一致（`test/senders.test.js`，静态对比）。
- `watch/scripts/check.sh`：带路径的地址、`/events` 返回 404/405/501 时只轮询且不再重试、轮询不显示标记、放下手腕停止轮询、轮询间隔、解码函数返回的快照（`Fixtures/sessions-cloud.json`，由 `test/cloud.test.js` 生成并校验）、`generate.sh` 和 `xcodebuild` 对带路径地址的展开；用假地址做的 watchOS 真机构建成功，产物 Info.plist 里是完整的 `https://…/functions/v1/aistatus`。
- 本地试用（不需要 Supabase）：`AISTATUS_READ_TOKEN=… AISTATUS_HOOK_TOKEN=… node scripts/hub-local.mjs`，然后 `aistatus cloud setup --url http://127.0.0.1:17810/functions/v1/aistatus …`（http 只允许 127.0.0.1 / localhost）。

### 尚未验证

- **没有在真实的 Supabase 上运行过**（按要求没有部署、没有连接任何项目），这里也没有 Deno / Docker / Supabase CLI。具体是：
  - Deno 适配层（`src/hub/deno-entry.js`）：`Deno.serve`、`Deno.env.get`、`npm:@supabase/supabase-js@2` 的导入方式、`SUPABASE_SECRET_KEYS`（取 `default`）/ `SUPABASE_SERVICE_ROLE_KEY` 的选择——都按 2026-10 的 Supabase 文档写的，只在 Node 里用假对象跑过。
  - 网页编辑器对一个 38 KB、带 `// @ts-nocheck` 的单文件是否直接接受（文档说编辑器会做类型检查）。
  - 函数收到的路径：按文档应是 `/aistatus/...`；处理函数同时接受 `/aistatus/...`、`/functions/v1/aistatus/...` 和不带前缀的路径。
  - “Verify JWT” 开关在网页上的确切名字和位置（文档只写了 `config.toml` 的 `verify_jwt = false` 和 CLI 的 `--no-verify-jwt`）。
  - `supabase/schema.sql` 没有在 Postgres 上执行过（这里没有 Postgres）；PostgREST 的行为（`update … eq(version) … select()` 返回受影响的行、重复插入返回 `23505`、`bigint` 以 JSON 数字返回）是按文档和 supabase-js 的已知行为模拟的。
  - 冷启动延迟和从你所在网络到 Supabase 的延迟：Mac 钩子总超时 2.5 秒、Windows 每步 1.4 秒，超时的事件会丢失（卡片可能停在旧状态，直到下一个事件）。
- Windows 脚本的新过滤逻辑没有实际运行过（这里没有 PowerShell）。
- 手表上真实的轮询 / 抬腕行为、`.inactive` 时停止轮询的实际效果。

## 开发

```
src/core.js           状态机与钩子归一化（纯 JS，无 Node API；守护进程和 Supabase 函数共用）
src/store.js          守护进程用的 SessionStore（包装 core.js）
src/cloud.js          云端模式：aistatus cloud setup/status/on/off
src/hub/handler.js    云端中转的请求处理（Request -> Response，Deno 和 Node 都能跑）
src/hub/supabase-storage.js  基于 supabase-js 的存储（按 version 比较后写入）
src/hub/memory-storage.js    内存存储（测试、本地试用；语义同 SQL）
src/hub/deno-entry.js 函数入口（Deno.env、createClient、Deno.serve）
src/hub/node-server.js 把处理函数挂到 Node HTTP 服务器上（测试、本地试用）
supabase/schema.sql   建表 SQL（幂等）
supabase/functions/aistatus/index.ts  生成的函数文件（node scripts/build-supabase.mjs）
scripts/build-supabase.mjs  生成上面的文件（--check 只检查）
scripts/hub-local.mjs 本地假云端（内存，端口 17810）
src/server.js         HTTP / SSE API
src/daemon.js         组装：持久化、Bonjour、Codex 监听
src/codex-watcher.js  Codex rollout 文件监听
src/installer.js      钩子安装/卸载、launchd plist
src/cli.js, render.js 命令行与终端渲染
hooks/aistatus-hook.sh 钩子转发脚本
hooks/aistatus-hook.ps1     Windows 钩子转发脚本（PowerShell 5.1）
scripts/install-windows.ps1 Windows 安装/卸载脚本
scripts/e2e.mjs       端到端检查（临时 HOME，默认端口 17778）
scripts/e2e-remote.mjs 远程钩子端到端检查（临时 HOME，默认端口 17790，用 curl 打本机局域网 IP）
scripts/e2e-public.mjs 公网监听端口端到端检查（临时 HOME，端口 17800/17801/17802，全部只绑 127.0.0.1，带一个模拟 Funnel 的本地反向代理）
test/public.test.js    公网监听端口的单元测试
test/hub.test.js, test/hub-bundle.test.js, test/cloud.test.js, test/senders.test.js  云端中转
```

测试与 e2e 只使用临时 HOME，不会修改真实的 `~/.claude`、`~/.codex` 或加载 launchd 任务。

## 阶段二：watchOS 应用

独立的 watchOS 应用（SwiftUI，**不需要 iPhone 伴侣应用**，部署目标 watchOS 11），外加一个 WidgetKit 小组件（智能叠放 / 表盘复杂功能）。代码在 `watch/`。

> **状态（2026-10-03）**：界面为“单屏色块”第二版（分支 `watch-tiles-v2`，见下文）：位置固定、只显示工具和状态计时、深色调色块、点按看详情、左滑删除。用 Xcode 27（Swift 6.4，watchOS 27 SDK）已完成签名的真机构建，macOS 上 451 项检查通过并离屏渲染了 40/44 mm 预览图；**新界面尚未在手表上运行过**（无模拟器运行时）。详见下文“尚未验证”。

### 手表上看到什么

**主屏只有一屏**：不滚动、没有列表。用途是抬腕数一数完成了几个任务，不需要知道每个任务是什么。整个屏幕按会话数切成色块，边到边铺满，色块之间是 2 pt 细黑线：

| 会话数 | 布局 |
|---|---|
| 0 | 安静的空状态（“No sessions”，底部一个齿轮按钮） |
| 1 | 整屏一个色块 |
| 2 | 横切一刀：上下两行 |
| 3 | 横切两刀：上中下三行 |
| 4 | 2×2 田字格 |
| >4 | 田字格显示前 4 个，左上角小徽标 “+N” 表示还有几个没显示 |

**位置固定**：按会话开始时间排（最早的在前，同时开始按 id），状态变化不换位置；行布局从上到下、田字格从左上到右下。守护进程只给出“本轮”开始时间（新 prompt 时 `startedAt` 会变），所以手表记住每个会话第一次出现时的开始时间，只要会话还在列表里就一直用它——完成后再开始新一轮也不挪位置。会话被删掉后再出现算新的，按新的开始时间排。（手表应用重启后按当时的开始时间重新排一次。）超过 4 个时显示排在最前的 4 个。

每个色块**只有两行**，居中：

1. 工具小图标 + 工具名：`Claude` 或 `Codex`（不显示项目名、不显示是哪台电脑）；
2. 状态词 + 自走计时：`run · 12:34`、`ask · 0:41`、`done · 3:02`（田字格里去掉中间的点：`run 12:34`）。
   - **run**（运行中）→ 灰：底 `#2C2C2A` / 字 `#D3D1C7`，从 `startedAt` 计时；
   - **ask**（等审批 / 输入）→ 琥珀：底 `#412402` / 字 `#FAC775`，从 `waitingSince` 计时，没有则 `startedAt`；
   - **done**（完成，含中断 / 出错）→ 绿：底 `#173404` / 字 `#C0DD97`，从 `finishedAt` 计时（= 晾了多久）。

计时格式 `0:41` / `12:34` / `1:05:12`，超过一天显示 `1d 2h`；由 `TimelineView` 每秒刷新，不需要网络更新。常亮显示（Always-On，`isLuminanceReduced`）时颜色再暗一些，计时改为按分钟（`run · 12m`、`1h 05m`，每分钟刷新），因为常亮时屏幕大约一分钟才刷新一次。

**工具图标**：单色矢量图形（SwiftUI `Shape`，在 `AIStatusUI/ToolGlyphs.swift`），用色块的文字颜色着色。Claude = 放射状星芒（参照 Claude 桌面版菜单栏图标）；Codex = 波浪边“云朵”里镂空一个 `>_` 提示符（参照 ChatGPT 桌面版里自带的 Codex 图标）。全彩应用图标在约 14 pt 的深色块上看不清，所以画成简化的模板图形。仅供个人构建使用，不分发。

**操作**：

- **点按任意色块（任何状态）→ 详情页**（一屏、不滚动）：工具 + 状态、项目名、状态计时（`done · 3:02`）、一行说明（“Done · ran 4m 10s”、“Needs approval · ran 14m before”）、最后一条消息（若有，最多 4 行）。详情页跟着实时数据走；点屏幕任意处或系统的关闭按钮返回。
- **左滑色块 → 右侧露出红色垃圾桶**（底 `#791F1F`，图标 `#F7C1C1`；宽度为色块一半，最多 60 pt），点垃圾桶删除该会话（走原有视图模型：先乐观隐藏，`POST /sessions/:id/dismiss` 失败则在原位置恢复并弹提示，404 视为已清除）。右滑、点别处或 4 秒不动会收回；同一时间只有一个色块是打开的；滑动后的同一次触摸不会再触发点按。**任何状态都能删，这也是唯一的删除方式**（不再有“点一下清除 / 再点一次”，手表界面也不再使用 `dismissPolicy`；VoiceOver 下有 “Delete” 操作）。
- **长按任意位置 → 设置**（主机 / 端口 / token / Test connection，以表单弹层打开）。空状态、连不上、未设置时屏幕上也有设置按钮。

**连接状态**：有色块时，连接问题只在左上角显示一个小标记（红色 Wi-Fi 叹号 = 连不上，黄点 = SSE 断了在轮询），色块保留最后一次的数据；只有在**没有任何色块可显示**时才整屏显示 “Can't reach Mac”（地址、原因、Retry、齿轮）。首次连接时显示天线图标和主机名；未设置主机时引导去设置。

**触感**：应用在前台时，有会话变成 ask（`.notification`，优先）或 done（`.success`）时震动；打开应用时的第一份快照不震。

**设为默认屏幕（推荐）**：手表上 设置 → 通用 → 返回时钟（Return to Clock）→ 在应用列表里选 AI Status，打开“返回此应用”（Return to App），并把返回时钟的时间设长一些（选项名以手表系统为准）。这样抬腕时显示的就是这一屏，配合常亮显示随时可看。

预览图（macOS 上离屏渲染，40 mm = 162×197 pt，44 mm = 184×224 pt；右上角的 10:09、详情页左上角的 ✕ 和圆角是模拟的系统元素和屏幕形状）：[`watch/previews/`](watch/previews)——`tiles-0/1/2/3/4/6`、`tiles-3-swiped` / `tiles-4-swiped`（左滑露出垃圾桶）、`detail-done/ask/run`、`tiles-3-offline`、`tiles-4-always-on`、各状态页，总览见 `overview-40mm.png` / `overview-44mm.png`。

- **设置**：主机、端口（默认 7778）、token（可选），`@AppStorage` 持久化。主机只写名字会自动补 `.local`（`my-mac` → `my-mac.local`），也接受 IP、`host:port`、带 `http://` 的写法，以及完整的 `https://` 地址（例如 Funnel 地址；不写端口即 443，此时设置里的端口不用）；“Test connection” 调 `/health`。构建时 `generate.sh` 会把默认主机（本机的 Bonjour 名，或 `--host` 给的地址）和 `--token` 给的 token 写进 Info.plist（`AIStatusDefaultHost` / `AIStatusDefaultToken`），**手表上通常不用打字**；用户在设置里改过的值优先，设置里有 “Use …” / “Use built-in token” 按钮恢复成内置值。所有请求（包括 SSE）都带 `Authorization: Bearer <token>`。
- **小组件**：`accessoryRectangular / Circular / Inline / Corner`，显示 running / waiting / done 计数和“as of 时间”；数据来自应用最后一次写入 App Group 的快照（计数变化时才刷新时间线）。小组件自己不联网，所以它只和你上次打开应用时一样新（后台刷新是阶段三）。

### 网络

- 前台时用 `URLSession.bytes` 连 `GET /events`（SSE，自己按字节解析，因为 `AsyncBytes.lines` 会吞掉空行）；首个快照 8 秒内没到（例如代理缓冲了流）或连接断开 → 立即 `GET /sessions` 轮询（每 5 秒），同时按指数退避（1→2→4…30 秒，±20% 抖动）重连 SSE；连续 2 次失败才显示离线。SSE 空闲 40 秒（守护进程每 15 秒 ping）视为断线。
- 应用进入后台（`scenePhase == .background`）即断开；抬腕回来自动重连。
- 服务器没有 SSE（`/events` 返回 404 / 405 / 501，例如[云端中转](#云端中转supabase)）时只轮询（间隔见设置 → Refresh，默认 5 秒），不显示轮询标记，手腕放下（`.inactive`）时也停止轮询。主机可以是带路径的完整地址（`https://<ref>.supabase.co/functions/v1/aistatus`）。
- 时钟偏差：每份快照的 `serverTime` 与本地收到时刻（轮询取往返中点）求差，取最近 5 个样本的中位数，所有时间戳换算成本地时间再交给计时文本。
- 没有使用 Bonjour 浏览：普通 watchOS 应用基本拿不到 Network.framework 的 NWBrowser/NWConnection，所以手动主机是基线。
- Info.plist：`NSAppTransportSecurity → NSAllowsLocalNetworking = YES`（允许明文 HTTP 到 `.local`、不带点的主机名和局域网 IP；**故意没有**加 `NSAllowsArbitraryLoads`，两者同时存在时后者会被忽略；到公网 `https://` 地址本来就允许，不需要例外）、`NSLocalNetworkUsageDescription`、`NSBonjourServices = _aistatus._tcp`、`WKApplication`、`WKWatchOnly`。
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
  previews/                   40/44 mm 离屏渲染预览图（每种会话数、左滑删除、详情页、常亮、离线、各状态页）
  AIStatusKit/                Swift 包（macOS 上可 swift build）
    Sources/AIStatusKit       模型/解码、SSE 解析、Endpoint、URLSession 传输、连接循环、时钟、固定排序（SessionOrder）、视图模型、App Group 存储；
                              Tiles.swift：色块布局（会话数 → 布局、前 4 个 + “+N”、色块几何）、色块文字（run/ask/done + 计时）、左滑删除状态机、常亮时的分钟格式
    Sources/AIStatusUI        全部 SwiftUI 视图：RootView（单屏 + 设置弹层）、TileBoard（色块、左滑、详情弹层）、SessionDetail（详情页）、
                              ToolGlyphs（Claude / Codex 单色图标）、StateViews（空/连不上/连接中/未设置）、
                              SettingsView、WidgetViews、Samples（预览数据与渲染目录）；watch 专用 API 在 #if os(watchOS) 里
    Sources/AIStatusChecks    可执行测试程序（命令行工具里 XCTest 和 Swift Testing 都不可用）
    Fixtures/                 从真实 aistatusd 抓取的 JSON / SSE 原始字节
    scripts/capture-fixtures.mjs   重新抓取夹具（临时 HOME、关 Bonjour、端口 17779）
    scripts/live-check.mjs         对真实守护进程跑 Swift 联调（临时 HOME、端口 17780，中途重启守护进程）
```

### 不上手表能做的验证

```sh
cd ~/projects/ai_status/watch
./scripts/check.sh                              # swift build + 451 项检查 + App/Widget 入口在 macOS 上类型检查 + plist/YAML 语法
node AIStatusKit/scripts/live-check.mjs         # 再加 32 项：真实 aistatusd 进程上的 SSE、轮询、dismiss、重启重连、局域网 token
RENDER_DIR=previews AIStatusKit/.build/debug/AIStatusChecks   # 重新生成 previews/ 下的预览图（macOS 渲染，计时按“现在”取值）
# watchOS 真机构建（签名，不安装）：
xcodebuild -project AIStatus.xcodeproj -scheme AIStatus -destination 'generic/platform=watchOS' \
  -derivedDataPath DerivedData -allowProvisioningUpdates build
```

检查覆盖：会话数 → 布局（0/1/2/3/4/>4）、按开始时间的固定排序（状态变化 / 新一轮不换位置、删掉后再出现按新时间、并列按 id）与前 4 个 + “+N”、色块几何（铺满屏幕、文字区在安全区内且大小一致、细分隔线）、色块文字（run/ask/done、`run · 12:34`、田字格去点、常亮按分钟、计时起点）、左滑删除状态机（跟手与限位、过半或快速甩动才打开、竖向拖动不算、只能开一个、右滑 / 点别处 / 4 秒超时收回、手指按住时不超时、触摸被系统取消、滑动后的同次点按被忽略、只有打开的垃圾桶能删、删一次、色块消失时收回）、经视图模型删除任意状态的会话（乐观移除、失败后原位置恢复），以及所有界面在 40/44 mm 尺寸下的渲染。

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
   可选：`./scripts/generate.sh --team ABCDE12345 --host my-mac.local --prefix com.yourname`；公网地址和 token：`--host https://mac.tailnet.ts.net --token <aistatus token --read 的输出>`（`--token ""` 删除）。没给的选项保留 `Local.xcconfig` 里原来的值。xcconfig 里 `//` 是注释，所以脚本把每个 `/` 写成 `/$()`（`https:/$()/$()host`，Xcode 展开后就是 `https://host`）；`Local.xcconfig` 权限 600、不入库，脚本输出里不显示 token。项目改动只改 `project.yml`，然后重新运行 `generate.sh`（`.xcodeproj` 不入库）。
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
  - 手势：每个色块上是 `LongPressGesture(0.5 s).exclusively(before: TapGesture)` 加一个并行的 `DragGesture(minimumDistance: 8)`。在田字格窄色块（约 80 pt 宽，垃圾桶 40 pt）里左滑是否顺手、轻微移动的点按会不会被当成拖动（或反过来）、滑动后是否误开详情（状态机里有 0.35 秒的保护）、长按设置是否仍可靠、触摸被系统取消时色块是否回位，都要真机确认；详情弹层和设置弹层的系统关闭按钮。
  - 触感：`.notification` / `.success` 的实际感受。
  - 常亮显示：`isLuminanceReduced` 下的变暗配色、`TimelineView(.everyMinute)` 的分钟计时是否按预期刷新；正常亮屏时 `TimelineView(.periodic)` 每秒走字（及耗电）。
  - 深色调色块在 OLED 上的观感、工具图标在约 13 pt 时是否清楚可辨（预览里可辨）。
- 手表上的网络：`URLSession.bytes` 流式 SSE 在手表上（特别是经 iPhone 蓝牙代理时）是否会被缓冲（已做“8 秒没收到首个快照就退回轮询”的兜底）；经代理时 `.local` 名能否解析；本地网络权限提示在 watchOS 上是否出现。
- Personal Team（免费账号）能否使用 App Group 未确认。如果签名因 App Group 失败：在 `project.yml` 里删掉两个 `CODE_SIGN_ENTITLEMENTS` 行重新生成，应用照常工作，只是小组件会一直显示 “Open the app once”。

### 已知限制

- 只在前台联网：手放下、应用进入后台后不再更新；小组件/复杂功能只显示上次打开应用时的计数；没有通知推送（阶段三）。
- ATS 只放开本地网络的明文 HTTP：`xxx.local`、不带点的名字、IP 可以；`mac.lan`、`*.home.arpa` 这类 DNS 名的 `http://` 会被拦截，请用 `.local` 名或 IP（`https://` 地址不受影响）。若 `.local` 在手表上解析不了，改用 Mac 的局域网 IP（建议在路由器里给 Mac 固定 IP）。
- 免费 Personal Team 的描述文件 7 天过期，过期后需要从 Xcode 重新安装。
- token 存在 UserDefaults（`@AppStorage` 要求），不在钥匙串；用 `--token` 编进应用时它以明文写在应用包的 Info.plist 里（只装在你自己的手表上，但任何拿到这个 .app 的人都能读到，不要分发构建产物）。局域网 `http://` 是明文，仅适合可信局域网；公网请用 `https://` 地址。
- 手表排序（按开始时间、位置固定）与服务器 `/sessions` 的排序不同，是有意的；“第一次出现时的开始时间”只记在内存里，应用重启后按当时的开始时间重排。
- 超过 4 个会话时只显示最早开始的 4 个，其余只计入 “+N”，在手表上看不到也删不了（删掉前面的才会补上来；也可以用 `aistatus dismiss`）。
- 时钟校正精度约等于局域网单程延迟（毫秒级），对秒级计时足够。
