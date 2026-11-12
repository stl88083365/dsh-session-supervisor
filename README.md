# 会话监督插件（@local/dsh-session-supervisor）

一个监督会话 + 一个执行会话的自动监督闭环，装在 DSH desktop profile（`link:D:\aipcb\session-supervisor`）。

**GitHub**: https://github.com/stl88083365/dsh-session-supervisor

## 工作方式

- **执行会话**：普通会话，**客户直接在 Web UI 里输入需求**。中间轮次不打扰监督。
- **监督会话**：独立 LLM 会话，只评审不写码；结论只走 `supervision_verdict`。
- **评审时机**：执行会话**全部完成**并 `supervision_done` 后触发评审（浏览器错误上报 / 客户反馈 / 人工 `supervision_review` 也会送审）；turn/end、工具错误只记录不触发。
- **整改回环**：`needs_fix` → 修复指令**串行**发回执行会话 → 修完再 `supervision_done` → 再评审，直到 complete 或熔断。
- **验收清单（关键）**：`supervision_start` 的 `acceptance` 数组 / `supervision_requirement` 登记的每一项，监督都必须**亲自复现**（读文件、跑命令、请求 API、查注册）；不可复核或复核不过 → needs_fix。执行会话不掌握"验收解释权"，自述不算数。

## 为什么之前监督没发现 UI 空白页（v4 补的洞）

评审输入只有执行日志，三类故障天然不可见，已全部堵上：

1. **日志外故障**：浏览器崩溃不进会话日志 → Client 全局捕获 `error`/`unhandledrejection` + ErrorBoundary，POST `/api/session-supervisor`（type=ui-error）落持久日志并**自动触发评审**；评审消息带「硬故障证据」段，存在未决记录禁止 complete。
2. **自述不可核**：见上面验收清单；清单同步下发执行会话，杜绝"各自按自己理解验收"。
3. **客户所见无回路**：面板**「反馈给评审」输入框** + `supervision_feedback` 工具，一条文字直接进日志并送审，作为无条件 bug。

## 串行（本地单槽模型）

- 所有插件投递（角色卡、需求、评审、修复指令、通知、nudge、交接卡、错误通知）走一条全局 FIFO；
- 每步先等本对双方都空闲（`agent/status` 驱动），**执行与监督永不同时跑模型**；
- 看门狗：评审轮超过 `reviewTurnTimeoutMs`（默认 15min）自动中止该轮（防死等），中断走 nudge/重评路径（实测已触发并自救成功）。

## 上下文接力（默认 240k；客户模型上限 254k，留余量）

双方水位（`tokenMeter.contextPressure`）达 `maxContextTokens` → 同 Workspace 自动开新会话：送达**自包含交接卡**（角色卡+原始需求+验收清单+对账状态+最近 40 行日志摘录），旧会话改名「（已接力）」保留；`supervision_status.lineage` 记录链路。接力上限 `maxHandovers`（默认 8）。

## 防死循环熔断（多重保险）

| 保险 | 默认 |
|---|---|
| `maxFixRounds` 自动修复轮上限 | 3 |
| `maxReviews` 评审总预算 | 12 |
| `maxHandovers` 接力上限 | 8 |
| 连续模型错误（本地模型断联） | 3 次即停 |
| 角色防自爆：监督/执行会话**禁止**调用 start/enroll/done（跨角色调用） | 代码硬拒 |
| nudge 每评审最多 1 次 + 重评计入评审预算 | 有界 |

任何一条触发即 `halted` 并通知执行会话，等人工输入。

## UI 面板（Client 半）

侧边栏「会话监督」图标 → 全页面板（`sidebar.panellist` + `main` keyed slot，纯 React.createElement，宿主主题 token）：

- **监督对卡片**：状态、双方运行位、上下文水位、评审/修复/接力预算比；10s 自动刷新 + 手动刷新。
- **审查报告流**：pair / review / verdict / handover / halted / stopped / client-error / user-review / requirement 全类型记录，chip 过滤 + 全文搜索 + 详情全文。
- **浏览器错误上报区** + **「反馈给评审」输入框**（客户看到的问题一键进评审回路）。
- 模块 inject 声明 `['slots','locale']`（缺 locale 曾致面板空白崩溃，已修复并推上游）。

## 模型侧工具

`supervision_start`（建对+需求+验收清单）、`supervision_enroll`（当前会话转执行/重启后重建）、`supervision_done`（唯一自动评审触发）、`supervision_verdict`（监督唯一结论渠道）、`supervision_requirement`（补充/查看验收标准）、`supervision_feedback`（问题直送评审回路）、`supervision_review`（人工中途评审）、`supervision_status`、`supervision_worker_log`、`supervision_reports`（报告查询）、`supervision_stop`。

## 配置（行 config 原样透传；set_bundle 开关即时热载，实测无需重启）

`maxFixRounds`(3) / `maxReviews`(12) / `maxHandovers`(8) / `maxContextTokens`(240000) / `digestMaxChars`(10000) / `serialWaitMs`(1800000) / `reviewTurnTimeoutMs`(900000) / `reviewEnabled`(true)

## 已知边界

- 监督对注册表在内存：宿主重启后自动流程停摆（会话与消息、审查报告日志不丢），在存活执行会话里 `supervision_enroll` 重建。
- Client 模块改动需**整页刷新**（无 dev watcher 时 HMR 不覆盖 bundle client 构建）。
- 零 `@deepseek-ai/*` import（link 安装解析限制）；`ctx.on`/`ctx.timer.*` 自带 fiber 作用域；`ctx.effect(fn)` 的 fn 立即执行。
- 模块激活失败过一次会进 `unmanaged-plugin` 态，那次必须重启宿主。

## 安装 / 回滚

- 安装：`plugin_manager install_bundle target=D:\aipcb\session-supervisor`（或克隆仓库后本地安装）。
- 停用：`set_bundle @local/dsh-session-supervisor enabled=false`（即时生效）。
- 卸载：`remove_bundle` + 删除目录；代码回滚按仓库 git 历史 revert。
