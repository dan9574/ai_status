# ai_status：手表上查看 Claude Code / Codex 多会话状态

## 目标
办公时多项目并行，抬腕就能看到每个 AI 会话的状态。默认在本地局域网使用；网络禁止设备互访时可经 Tailscale Funnel 的公网 HTTPS 地址访问（见 README “公网地址”）。不做完成百分比。

## 核心体验
- 用途：抬腕数一数完成了几个任务，不需要知道每个任务是什么。
- 每个会话一个色块（例：2 个 Claude Code + 1 个 Codex = 3 块）。主屏**只有一屏**，不滚动，按会话数切分：
  - 1 个：整屏；2 个：横切一刀上下两行；3 个：横切两刀三行；4 个：2×2 田字格；
  - 超过 4 个：田字格显示排在最前的 4 个，角上 “+N”；
  - 0 个：安静的空状态。
- **位置固定**：按会话开始时间排（最早在前，并列按 id），状态变化不换位置（手表记住每个会话第一次出现时的开始时间；删掉后再出现算新的）。
- 每块只有两行、居中：工具图标 + 工具名（Claude / Codex，不显示项目名）；状态词 + 自走计时（`run · 12:34` / `ask · 0:41` / `done · 3:02`，田字格去掉点）。
  - run → 灰（底 #2C2C2A / 字 #D3D1C7），计时自 startedAt；ask（等待审批/输入）→ 琥珀（#412402 / #FAC775），计时自 waitingSince（无则 startedAt）；done → 绿（#173404 / #C0DD97），计时自 finishedAt。
  - 深色调底 + 同色系浅色字；色块间 2 pt 黑线。常亮时再暗一些、计时按分钟。
  - 工具图标：单色矢量图形（Claude 星芒、Codex 云朵 + `>_`），用文字颜色着色。
- 操作：
  - 点按任意色块 → 一屏详情页（工具 + 状态、项目名、计时、运行了多久、最后一条消息）；点任意处或系统关闭按钮返回。
  - 左滑色块 → 右侧露出红色垃圾桶，点它删除会话（乐观删除，失败原位恢复）；右滑、点别处或 4 秒不动收回；同时只开一个。任何状态都能删，也是唯一的删除方式（手表不再使用 `dismissPolicy` 的短/长任务区分）。
  - 长按任意处 → 设置。状态变成 done / ask 时震动。
- 连接问题：有色块时只在角上显示小标记，色块保留最后数据；没有可显示的色块时才整屏提示连不上。
- 推荐把应用设为默认屏幕：手表 设置 → 通用 → 返回时钟 → AI Status 保持打开，抬腕即见。

## 架构
1. **Mac 守护进程 `aistatusd`**（阶段一，Node 22，零依赖）
   - 接收 Claude Code 与 Codex 的生命周期钩子事件，维护会话状态机。
   - 本地 HTTP API：`GET /sessions`、`GET /events`（SSE）、`POST /hook/:tool`、`POST /sessions/:id/dismiss`。
   - Bonjour 广播 `_aistatus._tcp`，供手机/手表发现。
   - `aistatus` 命令行：终端里实时显示所有会话卡片，用于验证。
2. **watchOS 应用**（阶段二，SwiftUI，独立应用，无需 iPhone 伴侣）
   - 单屏色块（1/2/3 行、2×2 + “+N”，位置固定）、自走计时、点按看详情、左滑删除、常亮变暗、离线小标记/空状态、触感、长按进入设置；WidgetKit 计数小组件。
   - 逻辑与视图放在 Swift 包 `watch/AIStatusKit`，可用命令行工具在 macOS 上编译与测试；Xcode 工程由 `watch/project.yml`（XcodeGen）生成。
3. **多台电脑**（阶段三，分支 `phase3-multihost`）
   - Mac 是中心：另一台电脑（Windows 上的 Codex 桌面版）用 PowerShell 钩子转发脚本把钩子 POST 到 Mac 的 `aistatusd`，手表仍只连 Mac。
   - 远程钩子默认关闭；配置 `hookToken`（或 `token`）后，非本机的 `POST /hook/:tool` 必须带 Bearer token（常数时间比较）。
   - 每个会话带 `machine` 字段；远程会话 id 为 `<tool>@<machine>:<sessionId>`，本机仍为 `<tool>:<sessionId>`（向后兼容）。界面上不区分电脑。
   - 命令行：`aistatus token [--new [--hooks-only]]`、`aistatus remote-setup`；Windows：`hooks/aistatus-hook.ps1`、`scripts/install-windows.ps1`。
4. **后台刷新**（阶段四）
   - iPhone 伴侣应用 + 实时活动，自动出现在手表智能叠放。
   - 传输二选一：蓝牙（免服务器，仅近场）或从 Mac 直接发苹果推送（需付费开发者账号）。
5. **公网地址**（分支 `public-endpoint`，接在阶段三之后）
   - 学校 Wi-Fi 禁止设备互访，改用 Tailscale Funnel 把守护进程放到固定的公网 HTTPS 地址（`https://danielmacbook-air.tail66228a.ts.net`），Funnel 由用户自己开：`tailscale funnel --bg 7779`。
   - 守护进程新增**公网监听端口** `publicPort`（默认 7779，只绑 127.0.0.1，没有 token 不启动）：不按来源地址信任，所有接口都要 Bearer token（`?token=` 不接受），读取/dismiss 用 `token`，钩子用 `hookToken`（没有则 `token`）；未认证的 `/health` 只回 `{"ok":true}`；不提供 `/setup`；钩子一律算远程；请求体 1 MiB、SSE 8 个、错误 token 限流、日志不含 token。`7778` 行为不变。
   - CLI：`token --read` / `--new --shared`、`public-url`、`public-status`、`remote-setup` 打印 `-BaseUrl` 安装命令。
   - 手表：主机可填 `https://…`（默认 443），所有请求带 token；`generate.sh --host <url> --token <token>` 编进 Info.plist，手表上不用输入。
   - Windows：配置文件加 `url`，转发脚本走 HTTPS（显式 TLS 1.2）；钩子命令和 `hooks.json` 条目不变，不需要重新信任。

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
- 阶段二 ✅ 已上真机（Apple Watch SE 3，watchOS 26.6）：`watch/` 下的 watchOS 应用 + 小组件。第一版（列表 + 点开详情卡片）试用后觉得太复杂，改为单屏色块设计（分支 `watch-tiles`，已合并）。
  - 色块第二版（分支 `watch-tiles-v2`，2026-10-03）：按开始时间固定位置（去掉“等待优先”的重要度排序）；色块只显示工具图标 + 名称和 `run/ask/done · 计时`；深色调配色；点按任意色块看详情；左滑露出垃圾桶删除（任何状态，唯一删除方式），去掉点按清除/再点一次。macOS 上 `watch/scripts/check.sh` 451 项通过，40/44 mm 预览图已更新，签名真机构建成功（未安装）。**待真机确认**：田字格窄色块里的左滑与点按/长按是否冲突、触感、常亮显示和安全区、图标在手表上的清晰度。
- 阶段三 ✅ 已实测（2026-10-03）：Windows 上的 Codex 桌面版通过局域网把钩子事件上报到 Mac（令牌校验），手表上显示为独立一格；子代理未结束时保持 running；Mac 上 Codex 钩子已信任。
- 公网地址 🟡 代码完成（分支 `public-endpoint`，2026-10-03）：`npm test` 93 项（新增 19）、`scripts/e2e-public.mjs` 40 项、`watch/scripts/check.sh` 509 项通过，watchOS 真机构建成功（未安装）。**待上线**：设置 token → 重启守护进程 → 用户执行 `tailscale funnel --bg 7779` → 带地址和 token 重新构建手表应用 → Windows 重新安装配置。未实测：真实 Funnel（是否带 `X-Forwarded-For`、SSE 是否缓冲）、Windows 上的 HTTPS 分支。
- 阶段四 ⏸ 搁置：后台刷新 / 推送。改用“应用常驻前台当默认屏幕”的做法后暂不需要。

## 当前环境
- macOS 27.0.1（Apple M2，8 GB），Xcode 27.0（Swift 6.4，watchOS 27 SDK；未装 watchOS 模拟器运行时）；XcodeGen 在 `.tools/xcodegen`（不入库）。已配对 Apple Watch SE 3（watchOS 26.6）。
- Node 22，Claude Code 2.1.287。
- `codex` 不在 PATH，但 `~/.codex` 存在（疑为桌面版）；需确认钩子是否可用，否则回退到监听 `~/.codex/sessions`。
