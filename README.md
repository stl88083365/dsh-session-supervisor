# 会话监督插件（@local/dsh-session-supervisor）

一个监督会话 + 一个执行会话的自动监督闭环，装在 DSH desktop profile（`link:D:\aipcb\session-supervisor`）。

## 工作方式（v2 语义）

- **执行会话**：普通会话，**客户直接在 Web UI 里输入需求**。中间轮次不打扰监督。
- **监督会话**：独立 LLM 会话，只评审不写码；结论只走 `supervision_verdict`。
- **评审时机（硬规定）**：执行会话**全部完成**并调用 `supervision_done` 后才触发一次评审——turn/end、工具错误、停滞**一律不触发评审**（只记录进 recentErrors，随下次评审材料一并送达）。人工想中途检查用 `supervision_review`。
- **整改回环**：`needs_fix` → 插件把修复指令**串行**发回执行会话 → 执行会话修完再 `supervision_done` → 再评审，直到 complete 或熔断。

## 串行（本地单槽模型）

- 所有插件投递（角色卡、需求、评审、修复指令、通知、nudge、交接卡）走一条全局 FIFO；
- 每步先等本对双方都空闲（`agent/status` 驱动），**执行与监督永不同时跑模型**；
- 看门狗：评审轮超过 `reviewTurnTimeoutMs`（默认 15min）自动中止该轮（防死等），中断走 nudge/重评路径（实测已触发并自救成功）。

## 上下文接力（默认 240k；客户模型上限 254k，留余量）

双方水位（`tokenMeter.contextPressure`）达 `maxContextTokens` → 同 Workspace 自动开新会话：送达**自包含交接卡**（角色卡+原始需求+对账状态+最近 40 行日志摘录），旧会话改名「（已接力）」保留；`supervision_status.lineage` 记录链路。接力上限 `maxHandovers`（默认 8）。

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

## 模型侧工具

`supervision_start`（建对+下发需求）、`supervision_enroll`（当前会话转执行/重启后重建）、`supervision_done`（唯一自动评审触发）、`supervision_verdict`（监督唯一结论渠道，评审进行中才受理）、`supervision_review`（人工中途评审）、`supervision_status`（serial/context/lineage/熔断计数）、`supervision_worker_log`、`supervision_stop`。

## 配置（行 config 原样透传；set_bundle 开关即时热载，实测无需重启）

`maxFixRounds`(3) / `maxReviews`(12) / `maxHandovers`(8) / `maxContextTokens`(240000) / `digestMaxChars`(10000) / `serialWaitMs`(1800000) / `reviewTurnTimeoutMs`(900000) / `reviewEnabled`(true)

## 已知边界

- 监督对注册表在内存：宿主重启后自动流程停摆（会话与消息不丢），在存活执行会话里 `supervision_enroll` 重建。
- 零 `@deepseek-ai/*` import（link 安装解析限制）；`ctx.on`/`ctx.timer.*` 自带 fiber 作用域；`ctx.effect(fn)` 的 fn 立即执行（返回函数才是 teardown）。
- 模块激活失败过一次会进 `unmanaged-plugin` 态，那次必须重启宿主。

## 安装 / 回滚

- 安装：`plugin_manager install_bundle target=D:\aipcb\session-supervisor`。
- 停用：`set_bundle @local/dsh-session-supervisor enabled=false`（即时生效）。
- 卸载：`remove_bundle` + 删除 `D:\aipcb\session-supervisor`。
