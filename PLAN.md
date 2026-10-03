# ai_status：手表上查看 Claude Code / Codex 多会话状态

## 目标
办公时多项目并行，抬腕就能看到每个 AI 会话的状态。本地局域网使用即可，不做远程，不做完成百分比。

## 核心体验
- 每个会话一张独立卡片（例：2 个 Claude Code + 1 个 Codex = 3 张）。
- 状态：`running`（显示已运行多久）、`waiting`（等待审批/输入）、`done`（显示已晾了多久）。
- 智能清除：
  - 运行时长 < 60 秒的短任务（普通聊天）：完成后可直接滑动清除。
  - 更长的任务：需要点一次确认才清除。
  - 只有一个会话时，全屏显示这一条。
- 阈值（60 秒）可配置。

## 架构
1. **Mac 守护进程 `aistatusd`**（阶段一，Node 22，零依赖）
   - 接收 Claude Code 与 Codex 的生命周期钩子事件，维护会话状态机。
   - 本地 HTTP API：`GET /sessions`、`GET /events`（SSE）、`POST /hook/:tool`、`POST /sessions/:id/dismiss`。
   - Bonjour 广播 `_aistatus._tcp`，供手机/手表发现。
   - `aistatus` 命令行：终端里实时显示所有会话卡片，用于验证。
2. **watchOS 应用**（阶段二，SwiftUI，独立应用，无需 iPhone 伴侣）
   - 会话卡片列表、自走计时文本、滑动清除与确认、单会话全屏、离线/空状态、触感、设置页；WidgetKit 计数小组件。
   - 逻辑与视图放在 Swift 包 `watch/AIStatusKit`，可用命令行工具在 macOS 上编译与测试；Xcode 工程由 `watch/project.yml`（XcodeGen）生成。
3. **多台电脑**（阶段三，分支 `phase3-multihost`）
   - Mac 是中心：另一台电脑（Windows 上的 Codex 桌面版）用 PowerShell 钩子转发脚本把钩子 POST 到 Mac 的 `aistatusd`，手表仍只连 Mac。
   - 远程钩子默认关闭；配置 `hookToken`（或 `token`）后，非本机的 `POST /hook/:tool` 必须带 Bearer token（常数时间比较）。
   - 每个会话带 `machine` 字段；远程会话 id 为 `<tool>@<machine>:<sessionId>`，本机仍为 `<tool>:<sessionId>`（向后兼容）。界面上不区分电脑。
   - 命令行：`aistatus token [--new [--hooks-only]]`、`aistatus remote-setup`；Windows：`hooks/aistatus-hook.ps1`、`scripts/install-windows.ps1`。
4. **后台刷新**（阶段四）
   - iPhone 伴侣应用 + 实时活动，自动出现在手表智能叠放。
   - 传输二选一：蓝牙（免服务器，仅近场）或从 Mac 直接发苹果推送（需付费开发者账号）。

## 状态机
| 事件 | 结果 |
|---|---|
| SessionStart | 建立会话，状态 idle（不显示卡片） |
| UserPromptSubmit | running，记录 startedAt |
| Notification / PermissionRequest | waiting |
| PreToolUse / PostToolUse（waiting 之后） | 回到 running |
| SubagentStart / SubagentStop | 记录 / 移除活动子代理 |
| Stop（仍有子代理在运行） | 保持 running；最后一个 SubagentStop 时变 done（finishedAt = 那一刻）。新 prompt 清空子代理；30 分钟无事件兜底 |
| Stop | done，记录 finishedAt 与 runDuration |
| SessionEnd | 若已 done 保留卡片直到清除，否则移除 |
| dismiss | 移除卡片 |

## 阶段状态（2026-10-03）
- 阶段一 ✅ 完成（分支 `phase1-daemon`）：守护进程、钩子、HTTP/SSE API、终端查看器，`npm test` 44 项 + e2e。
- 阶段二 🟡 代码完成、待上真机（分支 `phase2-watch`）：`watch/` 下的 watchOS 应用 + 小组件。macOS 上已验证：`swift build`、208 项单元/视图模型/渲染检查、对真实 aistatusd 的 32 项联调、App/Widget 入口类型检查。**未验证**：watchOS SDK 编译、XcodeGen 生成、真机运行（等待安装 Xcode，步骤见 README“阶段二”）。守护进程 API 无需改动。
- 阶段三 🟡 代码完成、Windows 端未实测（分支 `phase3-multihost`）：远程钩子（token）、`machine` 字段与按电脑区分的会话 id、旧 state.json 兼容、子代理未结束时保持 running、`aistatus token` / `remote-setup`、Windows PowerShell 转发与安装脚本、Swift 模型加可选 `machine` 字段（界面未改）。macOS 上已验证：`npm test` 74 项、`scripts/e2e.mjs`、`scripts/e2e-remote.mjs`（curl 打本机局域网 IP，模拟 Windows 请求）、`watch/scripts/check.sh` 218 项、live-check 250 项。**未验证**：PowerShell 脚本在 Windows 上的实际运行、Codex Windows 版执行钩子的 shell、信任界面（本机无 Windows、无 pwsh）。
- 阶段四 ⏳ 未开始：后台刷新 / 推送。

## 当前环境
- macOS 27.0.1（Apple M2，8 GB），Swift 5.10（仅命令行工具，SDK 为 macOS 14.4；无 Xcode、无 watchOS SDK、无 XCTest；无 Homebrew/XcodeGen）。
- Node 22，Claude Code 2.1.287。
- `codex` 不在 PATH，但 `~/.codex` 存在（疑为桌面版）；需确认钩子是否可用，否则回退到监听 `~/.codex/sessions`。
