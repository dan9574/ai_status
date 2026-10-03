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
3. **后台刷新**（阶段三）
   - iPhone 伴侣应用 + 实时活动，自动出现在手表智能叠放。
   - 传输二选一：蓝牙（免服务器，仅近场）或从 Mac 直接发苹果推送（需付费开发者账号）。

## 状态机
| 事件 | 结果 |
|---|---|
| SessionStart | 建立会话，状态 idle（不显示卡片） |
| UserPromptSubmit | running，记录 startedAt |
| Notification / PermissionRequest | waiting |
| PreToolUse / PostToolUse（waiting 之后） | 回到 running |
| Stop | done，记录 finishedAt 与 runDuration |
| SessionEnd | 若已 done 保留卡片直到清除，否则移除 |
| dismiss | 移除卡片 |

## 阶段状态（2026-10-03）
- 阶段一 ✅ 完成（分支 `phase1-daemon`）：守护进程、钩子、HTTP/SSE API、终端查看器，`npm test` 44 项 + e2e。
- 阶段二 🟡 代码完成、待上真机（分支 `phase2-watch`）：`watch/` 下的 watchOS 应用 + 小组件。macOS 上已验证：`swift build`、单元/视图模型/渲染检查、对真实 aistatusd 的 32 项联调、App/Widget 入口类型检查。守护进程 API 无需改动。
  - 第一版（列表 + 点开详情卡片）在真机 Apple Watch SE 3（watchOS 26.6）上试用后觉得太复杂，改为单屏色块设计（分支 `watch-tiles`）：386 项检查通过、40/44 mm 预览图在 `watch/previews/`、Xcode 27 签名真机构建成功。**未验证**：新界面在手表上的手势、触感、常亮显示和安全区（无模拟器运行时，尚未安装）。
- 阶段三 ⏳ 未开始：后台刷新 / 推送。

## 当前环境
- macOS 27.0.1（Apple M2，8 GB），Xcode 27.0（Swift 6.4，watchOS 27 SDK；未装 watchOS 模拟器运行时）；XcodeGen 在 `.tools/xcodegen`（不入库）。已配对 Apple Watch SE 3（watchOS 26.6）。
- Node 22，Claude Code 2.1.287。
- `codex` 不在 PATH，但 `~/.codex` 存在（疑为桌面版）；需确认钩子是否可用，否则回退到监听 `~/.codex/sessions`。
