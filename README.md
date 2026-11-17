# 会话监督插件（@local/dsh-session-supervisor）

一个监督会话 + 一个执行会话的自动监督闭环，装在 DSH desktop profile（`link:D:\aipcb\session-supervisor`）。

**GitHub**: https://github.com/stl88083365/dsh-session-supervisor

## 工作方式

- **执行会话**：普通会话，**客户直接在 Web UI 里输入需求**。中间轮次不打扰监督。
- **监督会话**：独立 LLM 会话，只评审不写码；结论只走 `supervision_verdict`。
- **评审时机**：执行会话**全部完成**并 `supervision_done` 后触发评审（浏览器错误上报 / 客户反馈 / 人工 `supervision_review` 也会送审）；turn/end、工具错误只记录不触发。
- **整改回环**：`needs_fix` → 修复指令**串行**发回执行会话 → 修完再 `supervision_done` → 再评审，直到 complete 或熔断。
- **验收清单（关键）**：`supervision_start` 的 `acceptance` 数组 / `supervision_requirement` 登记的每一项，监督都必须**亲自复现**（读文件、跑命令、请求 API、查注册）；不可复核或复核不过 → needs_fix。执行会话不掌握"验收解释权"，自述不算数。

## 如何使用（v3，最新版）

### 0. 安装 / 升级到最新版

```powershell
# 方式 A：本地目录安装（推荐，link 模式可直接改代码）
# 在插件控制台 / plugin_console 里执行：
plugin_manager install_bundle target=D:\aipcb\session-supervisor

# 方式 B：从 GitHub 克隆后安装
git clone https://github.com/stl88083365/dsh-session-supervisor.git
plugin_manager install_bundle target=D:\repo\dsh-session-supervisor    # clone 回来的目录，指过去即可
```

- 改完代码让插件重载：往 `C:\Users\<用户>\.dsh\profiles\desktop\cordis.patch.yml` 追加一行注释（`# touch xxx`）即触发重转；或整页刷新 Web UI。
- **`client.js` 属 bundle client，改完必须整页刷新**（没有 client HMR）。
- 模块若激活失败过一次会进 `unmanaged-plugin` 态，那次必须重启宿主。

### 1. 建监督对（三选一）

| 方式 | 怎么做 | 适用 |
|---|---|---|
| 自动纳入 | 在**新会话**的第一条客户消息里写「需要审查」（可用 `reviewTriggerPattern` 自定义词） | 日常干活：立刻开始，不需要模型自己调工具 |
| 当前会话纳入 | 让模型调用 `supervision_enroll`（可带 `requirement`） | 任务中途才决定要监督、或宿主重启后续跑 |
| 新开会话执行 | 调用 `supervision_start`（带 `requirement` + `acceptance`） | 由别的会话下发任务；会自建一个执行会话 + 一个监督会话 |

```
# 客户在最开始的会话里直接说：
需要审查：把 x.yml 改成 B，并跑一次校验

# 或者：
supervision_start(requirement="把 x.yml 改成 B", acceptance=["x.yml 里 B 存在且 grep 命中","node --check 通过"])
```

**验收清单是评审的唯一标准**：`acceptance` 里每一项，监督都必须亲自复现（读文件、跑命令、请求 API、开页面）；日志里说成功而监督复现不了的，一律 `needs_fix`。执行会话不掌握验收解释权。

### 2. 跑起来之后（生命周期）

```
pending-card -> working --(执行会话 supervision_done 一次)--> reviewing
  reviewing --complete--> done（关对，通知执行会话）
  reviewing --needs_fix--> fixing（整改指令串行发回执行会话）-> working -> 再 done -> 再评审
任意阶段 --> halted（预算/接力上限/连续模型错误/重复对合并）-> 等人工输入
宿主重启/插件重转 --> 从 journal 复原；静默超 dormantAfterMs 的老对转 dormant，重开时复用同一个监督会话
```

- 串行：本地单模型槽，**执行与监督永不同时跑**；所有投递走全局 FIFO，双方空闲才投下一步。
- 忘了上报：空闲 `idleNudgeMs`(120s) 提醒 → 再 `idleForceReviewMs`(300s) 强制送审（会被判「未自证完成」）。
- **一个执行只对一个监督，一个监督只对一个执行**；重复纳入会被复用（回复里带「直接复用」），并发/重启都不再叠开会话。
- 上下文水位达阈值 → 自动开**一个**新会话接力：交接卡自包含，**老会话被停止运行并退休**（改名「已接力」，永不再被自动纳入，也不再被投递；客户手误在老会话里输入，会被告知去活体会话继续）。provider 直接以 `CONTEXT_WINDOW_EXCEEDED` 拒绝请求时，插件按【溢出】立刻紧急接力，不再计入「连续模型错误」。**任何一条插件投递前都会先量目标会话的剩余额度，装不下就裁（记 `delivery-trim`/`pressure-wall`）**——插件自己绝不成为撑爆上下文的那一笔。

### 3. 看进度 / 查报告

- 侧边栏「会话监督」面板：监督对状态、双方运行位、上下文水位、评审/修复/接力预算、**配对唯一性（1 执行↔1 监督 / 发现重复对）**、已接力老会话数、报告流（含 `pairing` 类型）、浏览器错误上报区、「反馈给评审」输入框。
- HTTP：`GET http://127.0.0.1:<端口>/api/session-supervisor?pairId=&kind=&text=&limit=`（返回 `pairs[]` 含 `pairing`/`retiredSessions`，`reports[]` 全类型）；`POST {type:"ui-error"|"ui-review", ...}` 直接进评审回路。
- 工具：`supervision_status`（含 `pairing` 自检与重复对处理记录）、`supervision_reports kind=pairing`（接力/复用/去重/复原流水）、`supervision_worker_log`（执行日志摘录）、`supervision_review`（人工中途评审）、`supervision_requirement`（补验收标准）、`supervision_feedback`（客户问题直送评审）、`supervision_stop`（停监督并停两侧当前轮）。

### 4. 配置（profile 行 config 原样透传，热载生效）

| 键 | 默认 | 说明 |
|---|---|---|
| `maxFixRounds` | 3 | 自动整改轮上限，超限 halted |
| `maxReviews` | 12 | 评审总预算 |
| `maxHandovers` | 8 | 上下文接力上限 |
| `contextSplitTokens` | 0 | **客户设置的上下文大小**（512K/1M 这类）。>0 即成为唯一接力阈值（受窗口−预留夹住），超过就分成有序分段逐段做；0=关闭，退回整段接力 |
| `contextSplitMaxParts` | 6 | 分段上限（尾部合并，防止太碎反而更慢） |
| `contextSplitPartChars` | 0 | 每段字数预算（0=按阈值自动折算 ≈2.4 字/token） |
| `maxContextTokens` | 240000 | 接力阈值上限（真正的阈值 = `min(本值, 窗口 - contextReserveTokens)`） |
| `contextReserveTokens` | 60000 | 从模型真实窗口里预留的量（窗口由 `tokenMeter.contextPressure().contextWindow` 读出） |
| `minContextTokens` | 12000 | 小窗口下的阈值下限（但不超过窗口的一半） |
| `contextSafetyRatio` | 0.5 | 投递时可占用的剩余额度比例 |
| `deliverMaxChars` | 12000 | **单条投递**的硬字数上限（超出即中间裁断并留标记） |
| `reviewMaxChars` | 20000 | 评审材料整体上限 |
| `handoverMaxChars` | 9000 | 交接卡整体上限 |
| `requirementMaxChars` | 4000 | 需求/验收标准在卡片里的上限 |
| `checklistNoteMaxChars` | 2200 | 核验清单在评审/整改里的上限 |
| `fixSummaryMaxChars` / `fixInstrMaxChars` | 1500 / 3000 | 整改指令里症状/要求的上限（全文仍留在 journal，可用 `supervision_reports` 取回） |
| `workerLogMaxChars` | 9000 | `supervision_worker_log` 返回值上限 |
| `handoverTailLines` | 25 | 交接卡带多少行日志摘录 |
| `overflowRelay` | true | 溢出错误走紧急接力（关掉才按「模型错误」计数） |
| `digestMaxChars` | 6000 | 评审材料里的执行日志摘录上限 |
| `serialWaitMs` | 1800000 | （遗留硬上限）v3.4 起投递闸门不再等待：等不到空闲就入队；本值只用在 `waitPairIdle` 的默认分支 |
| `reviewEnabled` | true | 关掉=只记录不评审 |
| `autoEnrollReview` | true | 首条消息触发词自动建对 |
| `reviewTriggerPattern` | 需要审查 | 自定义触发词（正则可用） |
| `idleNudgeMs` / `idleForceReviewMs` | 120000 / 300000 | 未上报兜底：提醒 / 强制送审 |
| `completeSummaryMinChars` | 40 | complete 结论最短长度（反假完成门槛之一） |
| `reviewTurnTimeoutMs` | 2700000（45min） | 评审轮「无进展」时限。起点=**材料真送达**；监督侧任何事件都刷新起点（单通道排队 + 十几项服务端取证的一轮 30~40min 属正常，旧值 30min 会误杀） |
| `maxReviewTimeouts` | 3 | 评审**连续**超时几次就熔断（只有 `supervision_verdict` 真给出结论才清零；投递时不清零） |
| `reviewHardCapMs` | 7200000（2h） | 评审判死用的绝对上限：从送达起无论是否有进展，超了必中止该轮（进展豁免只豁免「慢」，不豁免「永不收敛」） |
| `workerTurnTimeoutMs` | 2700000 | 执行侧**单轮**时限（45min）：超时先 cancel 让它落盘/上报，不再无限静默 |
| `maxWorkerTimeouts` | 2 | 执行侧连续几次单轮超时就熔断 |
| `pairIdleGraceMs` | 5000 | 评审材料构建前的短暂静默宽限；投递闸门本身**不等**（同步判定→入队） |
| `drainRetryMs` | 2500 | 排队条目的后台补发节拍；另有三个即时节拍：会话变空闲、通道变空、有人查状态（面板轮询/`supervision_status`） |
| `channelGuard` | true | 全宿主单通道闸门（本地模型只有一个推理通道）。关掉=只做对内串行 |
| `channelMaxWaitMs` | 600000 | 排队压过此值就**强行投递**（记 `delivery-forced`），监督不会因为一直抢不到通道而永远不动 |
| `channelStaleMs` | 300000 | 通道账本里「running 挂着但早已不动」的僵尸条目过期时间（不清算就会把监督永久饿死） |
| `pendingDeliveryMax` | 6 | 每对待投队列长度上限（超出丢最旧的，保证最新材料一定送达） |
| `deferAfterMs` | 120000 | （遗留）旧「放弃本次投递挂单槽待重投」的等待时长，v3.4 起闸门不再等 |
| `strictPairing` | true | 1:1 复用/去重/硬拒（关掉=回退到旧口径，可能再开多对） |
| `hydratePairs` | true | 重启后从 journal 复原监督对 |
| `stopRetiredSession` | true | 接力/熔断时真的去 `cancel` 会话（关掉=只改名不停） |
| `dormantAfterMs` | 21600000 | 重启后静默超此时的老对转 dormant |
| `reuseCardCooldownMs` | 60000 | 复用对时重送角色卡的最小间隔（防刷） |
| `retiredNoticeMs` | 300000 | 退休会话被再次使用时提示的冷却 |
| `rolloverCooldownMs` | 60000 | 同侧接力冷却（防叠加开会话） |
| `debugEnrollTrace` | false | 打开后写 `session-supervisor\auto-enroll.log` 排障流水 |

### 5. 自检 / 回归（改代码后必跑）

```powershell
cd D:\aipcb\session-supervisor
node .verify\pairing-test.mjs        # 44 项：并发纳入 1 会话、达线只开 1 会话（执行侧+监督侧各自）、老会话停止+退休、
                                     #     接力后补送角色卡、重启复原、真实 journal 去重、dormant 复用
$env:DSH_WEB_URL='http://127.0.0.1:<端口>'; node .verify\live-1to1-check.mjs <pairId>   # 真机在线复核（只读）：活体对 1:1 自检 + 退休会话名单
```

改动生效证据自查：`supervision_status` 里 `pairing.oneToOne` 与 `pairing.conflicts`；`supervision_reports kind=pairing` 看 `reused / duplicate-pair / drop-extra-session / hydrate / retired-session-touched / stop-retired-session` 流水。

### 6. 回滚

1. 代码：`Copy-Item index.js.bak-1to1-20261114 index.js`（`client.js` 同理）→ touch profile 重转。
2. 行为：profile 里加 `strictPairing: false` / `stopRetiredSession: false` / `hydratePairs: false` 单独关掉某条保证。
3. 绑定与历史：`%DSH_PROFILE_DIR%\session-supervisor\bindings.json`（会话归属）与 `reports.json`（审查报告流水）——备份后可裁剪，裁剪即等效清理历史对。

---
## v2：「需要审查」自动纳入 + 不漏审 + 不假完成（2026-11-13）

### 1. 新会话写「需要审查」= 自动建对（不需要模型自己调 supervision_enroll）

- 触发条件：**该会话第一条真实客户消息**含 `需要审查 / 需审查 / 要审查 / 需要监督 / 审查监督 / supervision needed`（`不需要审查`、`无需审查` 这类否定写法先剔除，不算触发）；`config.reviewTriggerPattern` 可加自定义触发词，`autoEnrollReview=false` 可整体关闭。
- 插件当场建对：本会话 = 执行侧，另开一个监督会话；**角色卡排队到本轮空闲点**再送达（不插话当前轮），并把需求里的触发词剔掉后交给监督（防止"需要审查"被当成任务）。
- 判定「首条消息」按事件 seq 比较：**注入型 user/message（记忆快照 / 技能目录 / runtime-context）不是客户消息**，用 `source.kind !== 'user'` + 注入 rpcId 特征排除（实测踩过：mnemon 注入的 `kind:'user'` 记忆快照会把首条判定顶掉）。
- 诊断：`supervision_status` 末尾附「自动纳入监督诊断」（最近 8 条 skip/enroll 原因）；`debugEnrollTrace=true` 时另写 `%DSH_PROFILE_DIR%\session-supervisor\auto-enroll.log`（默认关闭；排障时临时打开）。

### 2. 执行会话忘了上报 → 兜底送审（旧实现会被静默跳过）

- `cardDelivered` 之后，执行侧空闲（`turn/end` 已落）且没有 `supervision_done`：
  - 空闲 `idleNudgeMs`（默认 120s）→ 发【监督系统提示】要求二选一（补上报 / 继续做完）；
  - 再空闲 `idleForceReviewMs`（默认 300s）→ **插件强制送审**，触发语写明「未自证完成」，监督照常被验收清单驳回。
- 整改轮同样记账：`needs_fix` 下发后置 `reportPending='fix'`，执行会话修完不上报也会被兜底。

### 3. 反假完成硬门槛（`supervision_verdict` 由插件校验）

`complete` 必须带 **checklist**：每条 `{item, verified: done|failed|unverified, evidence}`，插件逐条校验并**直接打回**（throw，本轮评审作废，写 journal `review.rejected`）：

| 校验 | 打回原因 |
|---|---|
| 无 checklist | complete 必须逐条给核验条目 |
| 某条 `done` 但证据 <8 字 / 证据不含路径·命令·状态码·输出片段等可复现标记 | 证据太弱，等于没核验 |
| 任一条非 `done`（failed/unverified） | 只能 needs_fix |
| summary < `completeSummaryMinChars`（默认 40） | 结论没写清怎么复现 |
| 上一轮 needs_fix 的缺项在新 checklist 里没有对应 item | 整改没复查 |

needs_fix 还必须给 `fixInstructions`；整改指令带监督逐项核验记录原文下发，并提示执行会话「第 N 项：做了什么 + 真实输出」逐项回证。


## 为什么之前监督没发现 UI 空白页（v4 补的洞）

评审输入只有执行日志，三类故障天然不可见，已全部堵上：

1. **日志外故障**：浏览器崩溃不进会话日志 → Client 全局捕获 `error`/`unhandledrejection` + ErrorBoundary，POST `/api/session-supervisor`（type=ui-error）落持久日志并**自动触发评审**；评审消息带「硬故障证据」段，存在未决记录禁止 complete。
2. **自述不可核**：见上面验收清单；清单同步下发执行会话，杜绝"各自按自己理解验收"。
3. **客户所见无回路**：面板**「反馈给评审」输入框** + `supervision_feedback` 工具，一条文字直接进日志并送审，作为无条件 bug。

## 串行（本地单槽模型）

- 所有插件投递（角色卡、需求、评审、修复指令、通知、nudge、交接卡、错误通知）走一条全局 FIFO；
- 每步先等本对双方都空闲（`agent/status` 驱动），**执行与监督永不同时跑模型**；
- 看门狗：评审轮超过 `reviewTurnTimeoutMs`（默认 30min）→ **先收口**（释放 busy、按未通过通知执行侧、重排评审），连续 `maxReviewTimeouts`(2) 次即 halt；执行侧单轮超过 `workerTurnTimeoutMs`(45min) → cancel 并要求落盘/上报（见「卡死收口」）。

## v3：一个执行只对一个监督 + 达线换会话并停老会话（2026-11-14）

客户症状：**有几率开了很多会话**。四条不变量已硬编码到插件（`验证报告-20261114-一对一配对与接力停会话.md` 有实测证据）：

1. **一个执行只针对一个监督**：`acquirePair()` 是建对唯一入口，会话级串行锁 `serializeWith("pair:"+sessionId)` 覆盖整条 await 链（并发自动纳入 / 重复 `supervision_enroll` 只会有一个真正建对）；已有活体对 → `reusePair()` **复用原监督会话**，0 新开会话。
2. **一个监督只针对一个执行**：建对即 `bindSession(worker/supervisor → pairId)` 落盘 `bindings.json`；`pairView` / `/api/session-supervisor` 带 `pairing`（`oneToOne` / `sharedWith` / `conflicts`）；`enforceOneToOne()` 发现重复对 → 熔断 + 停两侧会话，写 `pairing` 类审查报告。
3. **达线自动匹配新会话**：`handoverIfNeeded()` 同侧单飞（`pair.rolling`）+ 冷却 + 竞态丢弃多开的会话；看门狗在**双方空闲点**、执行侧 `turn/end` 后都会接力（不再只在评审时判水位）；水位口径含「本轮交接卡是否已送达旧会话」，旧会话没清场就不算降级（否则会反复开会话）。
4. **老会话停止运行**：接力后 `stopRetiredSide()` → `markRetired()` + `stopSessionRun()`（`agent.cancel` + `sessionController.cancel`）；`serialDeliver` 投递前 `deliveryBlocker()` 拦住退休/非本侧会话；客户手误在退休会话里输入 → `onRetiredEvent()` 取消运行并只回「请到 <活体会话> 继续」。

重启 / 插件重转不再丢配对：`hydratePairsFromJournal()` 从持久 journal 重放事件重建注册表，重复对当场收口；静默超 `dormantAfterMs`（默认 6h）的老对转 `dormant`（不再自动跑），该执行会话再 `supervision_done` / `supervision_enroll` 即 `reopenPair()` **复用原监督会话**。回归：`node .verify/pairing-test.mjs`（47 项，含用本机真实 `reports.json` 跑的重建 + 去重）。

### 3.1 接力后的会话拿到什么（1.1.1）

- 新会话先收**自包含交接卡**（原始需求 + 对账状态 + 上次结论 + `handoverTailLines`(默认 25) 行日志摘录，整体受 `handoverMaxChars` 约束），紧着再补送**完整角色卡**（执行侧纪律 / 监督评审协议），不会因为「只有一张交接卡」而丢掉「只能调 supervision_verdict / 完成后调 supervision_done」这类硬约束。
- 停止动作全程留痕：接力时 `stop-retired-session`（`stopped: true/false`）、退休会话被再次使用时同样一行；`supervision_status.retiredSessions` 与 `/api/session-supervisor` 都带 `stopped` 字段，客户不用看代码就能确认「老会话真的停了」。

## 上下文接力与防爆（1.2.0）

**水位怎么测**（`pressureOf()`，四路取大）：`tokenMeter.contextPressure().pressureTokens`（provider 报的上一拍）→ `.projectedTokens`（下一拍估值）→ `tokenMeter.measure().totalTokens`（重定价总量，`baseline.kind = estimated` 时也能用）→ 事件流字数估算（`chars/3`，只在前三路全不可用时兜底；它会把被压缩掉的旧 span 也算进去，所以不做常规判据）。**1.1.1 及以前只读第一路**，本地路由 provider 把 usage 报成 `inputTokens/outputTokens/totalTokens = 0` 时，水位恒为 `undefined`，`?? 0` 后阈值永不越线——接力是死的（11-15 事故根因）。

**阈值** = `min(maxContextTokens, contextWindow - contextReserveTokens)`（小窗口再夹到不超过窗口一半）。本机窗口 524288 → 阈值 240000；换 128k 窗口的路由自动降到 68000。

**接力触发点**：执行/监督侧 `turn/end` 空闲点、看门狗空闲扫描、`runReview` 前置、以及**每条投递前**（`serialDeliver` 在链外测水位，撞墙先接力再把料改发活体会话；链内接力会自锁，实测过）。接力同侧单飞 + 冷却 + 竞态丢多开。

**投递预算**：`fitDelivery()` 每条投递先按 `estimateMessage()` 估词元，超过「剩余额度 × `contextSafetyRatio`」就裁（首尾保留、中间丢弃 + 标记），并一律不超过 `deliverMaxChars`；裁剪与撞墙各记一条 journal（`delivery-trim` / `pressure-wall`）。`supervision_worker_log` 返回值也受 `workerLogMaxChars` 约束（1.1.1 里它可以一次吐十几万字，直接进监督会话上下文）。

**溢出专路**：`CONTEXT_WINDOW_EXCEEDED` / `request exceeds the context window` 这类错误由 `relayOnOverflow()` 处理——立刻强制接力（不看水位、不等阈值），写 `overflow` journal 事件，且**不计入**「连续 3 次模型错误」熔断；只有接力本身做不了（接力上限、建会话失败）才回落计入错误预算。旧版这里会把事故判成「本地模型可能断联」并熔断整对。溢出原文里带着真实窗口（本机路由声明 1M，provider 却按 `context (524288)` 拒），`parseWindowCeiling()` 抓到后按 `observedCeilings` 记在会话/监督对上，之后两侧阈值都按它收紧（`context.ceiling` / `contextWindow` 可直接审计）。

审计面：`supervision_status.context` = `{worker, supervisor, limit, window, source, supervisorSource, remaining, handovers, overflowCount}`；`supervision_reports kind=overflow|delivery-trim|pressure-wall` 三种新事件；面板监督对卡片多一行「水位/阈值」。

接力链路仍按 1.1.1 的规矩落地：同 Workspace 自动开**一个**新会话（单飞 + 冷却，绝不叠加），送**自包含交接卡**；**旧会话被停止运行并改名「（已接力）」**（`stop-retired-session` 事件 + `retiredSessions[].stopped` 可直接审计），永久绑在原对上（`retired` 表 + `bindings.json`），不会再被自动纳入；`supervision_status.lineage` / `retiredSessions` 记录链路。接力上限 `maxHandovers`（默认 8），阈值算法见上一节。

## 卡死收口（1.2.1）

事故（2026-11-15 夜，sup-2-vd699）：执行侧一轮跑 2.5 小时（61 步取证），评审轮连续 8 次「15 分钟未结束」被中止，`phase` 永久停在 `reviewing`，客户看到「两小时没动」。四条根因与修法：

1. **超时只 cancel 不收口** → `pair.busy` 永远是 true，`runReview` 的 `if (pair.busy) return` 把之后每次评审都挡在门外。现在超时必先收口：`busy=false / verdictSeen=false / phase='fixing'`，记 `review-timeout`，给执行侧发「按未通过处理」通知，再重排评审。
2. **评审计时被无限重置** → 旧判据 `max(supervisorIdleSince, lastSupervisorHand)`，监督侧每空闲一次就把起点刷新到现在。现在只认 `lastSupervisorHand`（评审材料送达那一刻）。
3. **超时没有上限** → 新增 `maxReviewTimeouts`(2)，连续超时即 halt 并写明「监督侧模型延迟/上下文过大」。
4. **执行侧长轮完全静默 + 投递死等** → 新增 `workerTurnTimeoutMs`(45min)/`maxWorkerTimeouts`(2)：超时 cancel 该轮并通知「落盘 + 上报 + 命令带超时」；串行闸门改为 `deferAfterMs`(2min) 到期就**放弃本次投递并挂成待重投**（`delivery-deferred` → 空闲点 `delivery-retry`），不再死等 30 分钟、也不在长轮中途 splice 打断。

可观测性：`supervision_status.running` = `{workerSeconds, supervisorSeconds, sinceSupervisorHandSeconds, reviewTimeouts, workerTimeouts, deferredDelivery, watchdogSeconds}`——客户不用猜「跑了多久/卡在哪里」。重载/重启后 `hydratePairsFromJournal` 会恢复 `busy` 与评审计时起点（`lastReviewAt`），卡死的对在下一次看门狗扫描就被收口（真机实测：2.4 小时卡死 → `review-timeout waitedMs=8736132` → 3 秒后重排评审 #3）。

## 单通道串行（1.2.2）

本地模型只有**一个推理通道**，同时两路请求只会让所有会话一起变慢、一起超时（2026-11-16 01:00 实测：宿主里 4 个会话同时 `running`）。插件现在除了「同一对内部串行」，还守着**全宿主单通道**：

- 账本 `liveAgents`：`agent/status` 事件记全宿主活跃会话；看门狗每 30s 用宿主 `session/list` 的 `running` 字段校正一次（`channel.source = list|events`）——否则插件重载时「已经在跑的会话」不会重放事件，闸门会误判通道空闲。
- 投递闸门：`waitChannelFree()` —— 除本对两侧之外还有别的会话在跑时，插件**不插队**；等满 `deferAfterMs`(2min) 就把这次投递挂成 `deferredDelivery`（`delivery-deferred gate=channel-busy`，带 `others` 名单），等通道空了由看门狗补发（`delivery-retry`）。**（1.2.3 已改：闸门同步判定 + FIFO 待投队列，见下一节；`waitChannelFree` 已删除。）**
- 建对/建对复用时会直接告诉你「现在还有 N 个别的会话在跑」（`channelAdvice`），`supervision_status.running.channel` 也能随时看 `{others, samples, deferredByChannel, source}`。

这条只管**插件自己**不制造并发；客户同时开多个会话手动干活仍会抢通道——那属于宿主调度，插件只能排队等待。

## 排队不堵链（1.2.3 · 修「会话监督不起作用」）

11-16 客户报「会话监督现在不起作用了」。现场取证（`supervision_reports` + `supervision_status.channel`）：`sup-1-95j9s` 的投递全被 `gate=channel-busy`/`not-idle` 停投，评审材料 30 分钟投不出去 → 评审计时照跑 → 连续 2 次超时 → 整对熔断。根因是 1.2.2 那条闸门自身的三个自锁：

1. **闸门把全局串行链按住**：`serialDeliver` 在链里 `await waitChannelFree(grace 20s)` / `waitPairIdle(deferAfterMs 2min)`。一条投不出去就把**整条 `serialTail`** 按住，所有对的所有投递排在它后面——单通道 + 客户自己的长会话一占就是几十分钟，链等于死锁，看起来就是「监督不起作用」。
   → **v3.4：闸门改成同步判定**（`pairIdle(pair)` / `channelOthers(pair)` 一眼看完），等不到空闲/通道**立刻入队返回**，链上绝不留 await；补发由节拍器做（见下）。`waitChannelFree` 已删除。
2. **单槽 `deferredDelivery` 会被覆盖**：后来的 notice 把先前的**角色卡**挤掉——监督会话拿不到角色卡就永远不调 `supervision_verdict`，于是「评审材料送达→超时→熔断」循环发生。
   → 换成 **FIFO 队列 `pendingDeliveries[]`**：同 `(tag, sessionId)` 只更新文本、**保持先来后到的位置**，条数上限 `pendingDeliveryMax`(6)；`supervision_status.running` = `{deferredDelivery: "requirement/review", queuedDeliveries: N}` 直接看得到压了几条。
3. **补发只有一个看门狗节拍（15~20s）**，而且队列一被取出就重置 `since` → `channelMaxWaitMs` 的「饿死强行放行」永远触发不了。
   → `armDrain()` 四个即时节拍：**会话变空闲**（`agent/status` idle，200ms）、**通道变空**（别人跑完，500ms）、**投递成功后接着投**（300ms）、**有人查状态**（面板轮询 / `supervision_status` → 立刻重试）；`parkDelivery` 的重新入队保留原始 `since`（`hint.since`），饿过 `channelMaxWaitMs` 一定 `delivery-forced` 强投。

顺带三个正确性修口：

- **`pairIdle` 口径**：旧版要求两侧运行位**必须等于 `false`**，而新建对的第一拍、插件重载/hydrate 复原的对是 `undefined` → 一律判成「忙」→ 全部入队且永远排不空。现在 `!== true` 才算空闲。
- **评审判时起点 = 材料真送达**（`serialDeliver` 返回 requestId 那一刻），排队/等通道的分钟数**不计入超时**；同时补了「**停车超时**」兜底：材料压着没送达也照样有 `reviewParkAt`，超过 `reviewTurnTimeoutMs` 未落地 → 记 `review-timeout(starved:true)` 收口释放 `busy` + 丢弃本轮过期材料（`delivery-dropped`），避免 `busy=true` 把对锁死在 reviewing（这是 1.2.1 那次的同类事故）。
- **连续超时计数只在「真给出结论」时清零**（`releaseReview` 里看 `verdictSeen`）。旧版在投递评审材料时清零 = 连续超时永远攒不满 → 该熔断的卡在空转，客户体感「不动了」。

审计面新增：`delivery-deferred{tag,gate,queued,ahead|others}` / `delivery-retry` / `delivery-forced` / `delivery-dropped`；`supervision_status.running.{deferredDelivery,queuedDeliveries,channel.deferredByChannel}`。回归：`node .verify\stall-test.mjs`（27 项，含「排队不丢不乱序」「通道一空就补发」「饿死强行投递」「材料未送达不起计时」「委派会话不建对」；失败会自动吐插件日志 + 投递流水 + prompts 名单）。

## 上下文分段（1.2.4 · 按客户设定的大小自动拆分、按顺序完成）

客户口径：**「发给模型的上下文超过我设置的大小（比如 512K、1M），就自动拆分超出的部分，按顺序依次完成。」**
旧行为只有「整段接力」（一到阈值就换会话，把全部上下文压成一张交接卡塞给新会话）——活多的时候一张卡装不下，也没法保证「先做哪一段」。

- **阈值**：`contextSplitTokens`（0=关闭，回到旧接力）。设了它就是**唯一接力阈值**，但仍被「真实窗口 − `contextReserveTokens`」夹住（窗口 512K + 设 1M → 实际阈值 464288；窗口 1M + 设 1M → 988576），否则永远到不了线、分段一次都不会触发。
- **拆什么**：按「还没做完的活」的优先级收条目 —— ① 上一条 `needs_fix` 的整改项 ② 上一轮 checklist 里 failed/unverified 的项 ③ 验收清单/需求条目；按 `contextSplitPartChars`（缺省 ≈ 阈值×2.4 字/token）切成有序分段，段数上限 `contextSplitMaxParts`（默认 6，尾部合并，宁少不多）。
- **怎么串**：每段一个新执行会话，卡头写明【分段接力 · 第 k/N 段】+ **本段只做这几项** + 「前面 k−1 段已完成，不要重做」+ 「做完立刻 `supervision_done`，插件发下一段」。**只有最后一段完成后才进评审**；段间的 `supervision_done` 只推进分段，不进评审、不计评审预算。
- **手动/预演**：`supervision_split(pairId?, apply?, tokens?)` —— 不带 `apply` 只返回计划（dry-run，落 `context-split{action:plan}`）；`apply:true` 立刻开新会话从第 1 段开始。
- 审计面：`context-split` journal 事件 `{action: plan|part-start|part-done|all-parts-done, part, total, tokens, limit, budget, items}`；`supervision_status.context` 增加 `splitTokens`（客户设定值）与 `split:"2/5"`（当前第 2 段/共 5 段）。
- 同批修掉的死锁：队列里指向**已退休/已换掉会话**的条目原来会永久堵住 FIFO 头（重试只会被 blocker 挡回）——现在按「丢弃并出队」处理并记 `delivery-dropped`。回归 `split-test.mjs` 的 SP3 就是被这个卡住的。

回归：`node .verify\split-test.mjs`（21 项：计划有序 / 超阈值自动分段 / 段间串行不跳段不重做 / 最后一段才进评审 / 未超阈值不拆 / 512K·1M 阈值被窗口夹住 / 关掉开关退回接力卡）。

## 溢出自动续做（1.2.5 · 撞上 no-room 400 就换会话接着做）

客户口径：本地模型的长会话会报
`400 … request exceeds the context window: prompt (524520 tokens) leaves no room to answer in the context (524288); requests are never truncated`。
这种会话**连自己的压缩都救不回来**（provider 直接拒绝），唯一出路是换一个新会话接着做 —— 客户要的就是「碰到这个错误就自动新开会话，接着未完成的任务继续完成」。

- **识别**：`OVERFLOW_RE`（`context window` / `no room to answer` / `CONTEXT_WINDOW_EXCEEDED` / `context_length_exceeded` …）。两处入口都接线：`agent/error`（provider 报错）与 `turn/end.reason.error`（有的路由把溢出挂在轮结束原因里）。
- **真窗口**：`parseWindowCeiling()` 从错误原文抓数字（`context (524288)` → 524288），存进 `observedCeilings`，这一侧的阈值/分段阈值立刻按真实窗口收紧（本机路由声明 1M，实际 524288）。
- **续做**：开一个新会话（同 cwd），投一张**自包含**卡：原错误原文 + 真实窗口 + 「任务没变，接着把没做完的做完」+ **原会话最后一份 todo 快照里未完成的项（照顺序）** + 已完成项（不要重做）+ 原会话最后 N 行执行摘录 + 工作目录 + 规矩（先核对现场、不谎报）。老会话被 `cancel` 停掉并改名 `（已溢出接力→xxxx）`。
- **不炸**：只认 `session-*` 真会话（`mnemon-run-*` 等一次性会话不续）；监督对内的两侧仍走 `relayOnOverflow`（那条路处理 busy/评审预算/上限，绝不两路齐开）；同一会话 `overflowContinueCooldownMs`(30s) 内只续一次；整条续做链上限 `overflowContinueMax`(8)，超限记 `continuation-blocked` 不再开会话。
- 审计：`continuation{sessionId,newId,depth,ceiling,todoPending,reason}` / `continuation-blocked` / `continuation-failed`；配置 `overflowContinue`(true) / `overflowContinueMax`(8) / `overflowContinueCooldownMs`(30000) / `continueCardMaxChars`(9000)。

回归：`node .verify\overflow-test.mjs`（16 项：自动开会话 / 卡带未完成待办+真实窗口 / 老会话停+改名 / journal 记 depth 与待办数 / 冷却内不重复开 / 链封顶 + blocked / 对内的溢出只走 relay 不叠两路 / 委派会话不续），另有 `.verify\overflow-re.mjs` 用客户原文实测「识别 + 524288 解析 + 不误判普通错误」。

## 客户三条硬要求的落地口径（1.3.0 · 2026-11-18）

客户原话：「① 防止会话触发模型的上下文爆满，就是不能大于 500KB；② 执行会话运行完发送给监督会话审查所有修改，审查完有需要改进就发回执行会话修改，执行会话和监督会话不能同时运行；③ 执行或监督过程中插件要一直监视上下文，防止卡死。」

| 要求 | 落点 | 实测口径 |
|---|---|---|
| ① 上下文 ≤ 500KB | `config.contextSplitTokens: 512000`（=500×1024，比原 512K/524288 更保守）；到线自动分段换会话，段间串行、最后一段才评审 | 真机 `supervision_status` 实测 `splitTokens=512000 / limit=512000 / window=1048576`；若某路由窗口只有 524288 → 被夹到 `464288`（`split-test` SP7） |
| ② 跑完送审、有问题打回、两侧不同时跑 | `supervision_done` → 评审 → `needs_fix` 带 `fixInstructions` 串行发回执行会话；`pair.busy` + FIFO 队列保证同一时刻只有一侧在跑 | 本对 3 轮评审即实例：`verdict` 事件 3 条、`fixRounds 2/8`；`serial` 两侧 `running` 从不同时为 true（`pairing-test` 48 项含接力/串行断言） |
| ③ 全程监视上下文、防卡死 | 水位测量 + 达线接力 + 投递裁剪 + idle 看门狗（nudge 一次 → 强制送审）+ 溢出自动续做 | `context-test` 24 项、`stall-test` 27 项；journal `pressure-wall` / `delivery-trim` / `review-timeout` 可查 |

### 文本工具调用守卫（1.3.0 新增，并入「防卡死」）

模型有时把工具调用**写成正文**（`<tool_call><function=exec>…`）。DSH 只执行结构化 tool-call，
于是这一轮 0 工具执行、却以 `completed` 收尾 —— 现象就是「任务没跑完却停了」（真机案例：
`session-8f8e6a80` 连续 3 轮写正文，`exec` 这个工具名在本机根本不存在，shell 工具是 `pwsh`）。
插件层现在补一道（与 dsh-purge #95/#96 同口径，但由监督插件自己执行，不依赖宿主补丁）：

- **判定**：本轮 `assistant/message` 的 text 块命中 `<tool_call` / `<function=xxx`，且本轮**没有任何真实 `tool/call`**。真有工具执行、或只是空轮（只落了排队投递）都不算。
- **纠正**：`serialDeliver(pair, 'text-toolcall', …)` 注入一条提醒，点名「shell 工具名是 pwsh（不存在 exec 工具）」+ 禁止文本标记；第 2 次起升级为「不要再解释、下一步必须立刻产生至少一个真实工具调用」。
- **不炸**：连续上限 `textToolCallGuardMax`(4)，超限记 `text-toolcall{action:'give-up'}` 不再打扰；中间只要有一轮干净（真调了工具或有正常文本），预算立刻回满；`textToolCallGuard:false` 可整体关闭。
- 审计：journal `text-toolcall{role, round, attempts, action: retry|give-up}`，执行侧与监督侧都覆盖。

回归：`node .verify\text-toolcall-test.mjs`（13 项）。

## 防死循环熔断（多重保险）



| 保险 | 默认 |
|---|---|
| `maxFixRounds` 自动修复轮上限 | 3 |
| `maxReviews` 评审总预算 | 12 |
| `maxHandovers` 接力上限 | 8 |
| 连续模型错误（本地模型断联） | 3 次即停；**上下文溢出不计入**，走 `relayOnOverflow()` 紧急接力 |
| 评审轮超时（`reviewTurnTimeoutMs`×`maxReviewTimeouts`，另有 `reviewHardCapMs` 硬上限） | 起点=材料真送达；超时先**收口**（释放 busy + 按未通过通知执行侧 + 重排评审），**连续** 3 次即 halt；材料停投超期同样收口 |
| 执行侧单轮超时（`workerTurnTimeoutMs`×`maxWorkerTimeouts`） | 超时 cancel 该轮并要求落盘/上报，连续 2 次即 halt |
| 角色防自爆：监督/执行会话**禁止**调用 start/enroll/done（跨角色调用） | 代码硬拒 |
| nudge 每评审最多 1 次 + 重评计入评审预算 | 有界 |
| 上报兜底：执行侧空闲未上报 → 提醒（`idleNudgeMs`）→ 强制送审（`idleForceReviewMs`） | 各 1 次，计入评审预算 |

任何一条触发即 `halted` 并通知执行会话，等人工输入。

## UI 面板（Client 半）

侧边栏「会话监督」图标 → 全页面板（`sidebar.panellist` + `main` keyed slot，纯 React.createElement，自带 iOS/苹果分组样式配色，不依赖宿主 token）：

- **外观**：iOS 系统色变量（浅色 `#f2f2f7/#fff`，深色 `#000/#1c1c1e`），深色态跟随宿主标记 `body[data-ds-dark-theme]`；头部「自动/浅色/深色」分段控件可强制覆盖（`localStorage['session-supervisor:ios-theme']`）。所有文字自带成对前景/背景色，实测四档全部 WCAG AA ≥4.5:1（`.verify/probe.ps1`）。
- **监督对卡片**：状态、**阶段 + 上报欠账标记**（`pending-card` / 等完成上报 / 等整改上报）、自动纳入徽标、双方运行位、上下文水位、评审/修复/接力预算比；10s 自动刷新（页面不可见时暂停）+ 手动刷新。
- **审查报告流**：pair / review / verdict / handover / halted / stopped / client-error / user-review / requirement 全类型记录，chip 过滤 + 全文搜索 + 详情全文（verdict 详情含**逐项核验 checklist**）；列表支持键盘（↑/↓ + Enter）与 `listbox/option` 语义。
- **浏览器错误上报区** + **「反馈给评审」输入框**（客户看到的问题一键进评审回路）。
- 模块 inject 声明 `['slots','locale']`（缺 locale 曾致面板空白崩溃，已修复并推上游）。

## 模型侧工具

`supervision_start`（建对+需求+验收清单）、`supervision_enroll`（当前会话转执行/重启后重建）、`supervision_done`（唯一自动评审触发）、`supervision_verdict`（监督唯一结论渠道，**必须带逐项 checklist + 亲自跑出的 evidence**，插件校验不过直接打回）、`supervision_requirement`（补充/查看验收标准）、`supervision_feedback`（问题直送评审回路）、`supervision_review`（人工中途评审）、`supervision_status`（含自动纳入诊断）、`supervision_worker_log`、`supervision_reports`（报告查询）、`supervision_stop`。

## 配置（行 config 原样透传；set_bundle 开关即时热载，实测无需重启）

`maxFixRounds`(3) / `maxReviews`(12) / `strictPairing`(true) / `hydratePairs`(true) / `stopRetiredSession`(true) / `dormantAfterMs`(6h) / `reuseCardCooldownMs`(60000) / `retiredNoticeMs`(300000) / `rolloverCooldownMs`(60000) / `maxHandovers`(8) / `maxContextTokens`(240000) / `contextReserveTokens`(60000) / `minContextTokens`(12000) / `contextSafetyRatio`(0.5) / `deliverMaxChars`(12000) / `reviewMaxChars`(20000) / `handoverMaxChars`(9000) / `requirementMaxChars`(4000) / `checklistNoteMaxChars`(2200) / `fixSummaryMaxChars`(1500) / `fixInstrMaxChars`(3000) / `workerLogMaxChars`(9000) / `handoverTailLines`(25) / `overflowRelay`(true) / `digestMaxChars`(6000) / `serialWaitMs`(1800000) / `reviewTurnTimeoutMs`(1800000) / `maxReviewTimeouts`(2) / `workerTurnTimeoutMs`(2700000) / `maxWorkerTimeouts`(2) / `deferAfterMs`(120000) / `reviewEnabled`(true) / `autoEnrollReview`(true) / `reviewTriggerPattern`('需要审查') / `idleNudgeMs`(120000) / `idleForceReviewMs`(300000) / `completeSummaryMinChars`(40) / `debugEnrollTrace`(false)

> 改 profile `cordis.patch.yml`（加/删 config 覆盖段）触发的重转会**清空内存里的监督对**（journal 与会话不丢）；重转后在存活执行会话里 `supervision_enroll` 重建即可。加 `# touch` 注释行只为了触发重编译加载新代码。

## 已知边界

- 监督对注册表现已从持久 journal 复原（`hydratePairs`），并用 `bindings.json` 记住每个会话的归属；宿主重启后静默超 `dormantAfterMs` 的老对转 dormant，存活执行会话再上报即复用**同一个**监督会话继续（不再新建第二对）。若要把某个历史对彻底清掉：备份后裁剪 `reports.json`。
- 面板配色为**插件自带**的 iOS 系统色（不用宿主 token）：深色态跟随 `body[data-ds-dark-theme]`，可用头部分段控件强制浅色/深色，键 `localStorage['session-supervisor:ios-theme']`。可读性回归：`& .verify\probe.ps1`（四档 WCAG AA ≥4.5:1）、`& .verify\verify.ps1`（语法+token+备份+哈希+对比度+溢出全量）。
- Client 模块改动需**整页刷新**（无 dev watcher 时 HMR 不覆盖 bundle client 构建）。
- 零 `@deepseek-ai/*` import（link 安装解析限制）；`ctx.on`/`ctx.timer.*` 自带 fiber 作用域；`ctx.effect(fn)` 的 fn 立即执行。
- 模块激活失败过一次会进 `unmanaged-plugin` 态，那次必须重启宿主。

## 安装 / 回滚

- 安装：`plugin_manager install_bundle target=D:\aipcb\session-supervisor`（或克隆仓库后本地安装）。
- 停用：`set_bundle @local/dsh-session-supervisor enabled=false`（即时生效）。
- 卸载：`remove_bundle` + 删除目录；代码回滚按仓库 git 历史 revert。
