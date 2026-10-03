# ai_status：手表上查看 Claude Code / Codex 多会话状态

## 目标
办公时多项目并行，抬腕就能看到每个 AI 会话的状态。本地局域网使用即可，不做远程，不做完成百分比。

## 核心体验
- 每个会话一个色块（例：2 个 Claude Code + 1 个 Codex = 3 块）。手表上**只有一屏**，不滚动、没有详情页，按会话数切分：
  - 1 个：整屏；2 个：横切一刀上下两行；3 个：横切两刀三行；4 个：2×2 田字格；
  - 超过 4 个：田字格显示最重要的 4 个，角上 “+N”。重要度：waiting（等最久的在前）→ done（晾最久的在前）→ running；
  - 0 个：安静的空状态。
- 每块只显示项目名、小工具标记（Claude ✦ / Codex `</>`）和一个自走计时：
  - `running` → 灰色，计时自 startedAt；`done` → 绿色，计时自 finishedAt（晾了多久）；`waiting`（等待审批/输入）→ 橙色，计时自 waitingSince（无则 startedAt）。
- 智能清除（点按，无详情页）：
  - 运行时长 < 60 秒的短任务（`dismissPolicy = swipe`）：点一下 done 色块直接清除。
  - 更长的任务（`confirm`）：第一下变成“再点一次”，3 秒内再点才清除，否则恢复。
  - running / waiting 色块点按无反应。
- 阈值（60 秒）可配置（守护进程）。
- 连接问题：有色块时只在角上显示小标记，色块保留最后数据；没有可显示的色块时才整屏提示连不上。设置：长按任意处，或空/离线页的齿轮。
- 推荐把应用设为默认屏幕：手表 设置 → 通用 → 返回时钟 → AI Status 保持打开，抬腕即见；常亮时变暗、计时按分钟显示。

## 架构
1. **Mac 守护进程 `aistatusd`**（阶段一，Node 22，零依赖）
   - 接收 Claude Code 与 Codex 的生命周期钩子事件，维护会话状态机。
   - 本地 HTTP API：`GET /sessions`、`GET /events`（SSE）、`POST /hook/:tool`、`POST /sessions/:id/dismiss`。
   - Bonjour 广播 `_aistatus._tcp`，供手机/手表发现。
   - `aistatus` 命令行：终端里实时显示所有会话卡片，用于验证。
2. **watchOS 应用**（阶段二，SwiftUI，独立应用，无需 iPhone 伴侣）
   - 单屏色块（1/2/3 行、2×2 + “+N”）、自走计时文本、点按清除与“再点一次”、常亮变暗、离线小标记/空状态、触感、长按进入设置；WidgetKit 计数小组件。
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
- 阶段二 ✅ 已上真机（Apple Watch SE 3，watchOS 26.6）：`watch/` 下的 watchOS 应用 + 小组件。第一版（列表 + 点开详情卡片）试用后觉得太复杂，已改为单屏色块设计（分支 `watch-tiles`，已合并）：按任务数自动切成 1 / 2 / 3 条或田字格，灰=运行、绿=完成、橙=等待，点按清除，无详情页。预览图在 `watch/previews/`。**待真机确认**：手势、触感、常亮显示和安全区。
- 阶段三 🟡 代码完成、Windows 端未实测（分支 `phase3-multihost`）：远程钩子（token）、`machine` 字段与按电脑区分的会话 id、旧 state.json 兼容、子代理未结束时保持 running、`aistatus token` / `remote-setup`、Windows PowerShell 转发与安装脚本。macOS 上已验证：`npm test` 74 项、`scripts/e2e.mjs`、`scripts/e2e-remote.mjs`。**未验证**：PowerShell 脚本在 Windows 上的实际运行、Codex Windows 版执行钩子的 shell、信任界面。
- 阶段四 ⏸ 搁置：后台刷新 / 推送。改用“应用常驻前台当默认屏幕”的做法后暂不需要。

## 当前环境
- macOS 27.0.1（Apple M2，8 GB），Xcode 27.0（Swift 6.4，watchOS 27 SDK；未装 watchOS 模拟器运行时）；XcodeGen 在 `.tools/xcodegen`（不入库）。已配对 Apple Watch SE 3（watchOS 26.6）。
- Node 22，Claude Code 2.1.287。
- `codex` 不在 PATH，但 `~/.codex` 存在（疑为桌面版）；需确认钩子是否可用，否则回退到监听 `~/.codex/sessions`。
