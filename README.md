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
- 上下文达 `maxContextTokens`(默认 240k) → 自动开**一个**新会话接力：交接卡自包含，**老会话被停止运行并退休**（改名「已接力」，永不再被自动纳入，也不再被投递；客户手误在老会话里输入，会被告知去活体会话继续）。

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
| `maxContextTokens` | 240000 | 达线自动换会话（客户模型上限 254k，留余量） |
| `digestMaxChars` | 10000 | 评审材料里的执行日志摘录上限 |
| `serialWaitMs` | 1800000 | 串行闸门最长等待 |
| `reviewTurnTimeoutMs` | 900000 | 监督轮最长运行（从**交接卡送达**起算，防串行死等） |
| `reviewEnabled` | true | 关掉=只记录不评审 |
| `autoEnrollReview` | true | 首条消息触发词自动建对 |
| `reviewTriggerPattern` | 需要审查 | 自定义触发词（正则可用） |
| `idleNudgeMs` / `idleForceReviewMs` | 120000 / 300000 | 未上报兜底：提醒 / 强制送审 |
| `completeSummaryMinChars` | 40 | complete 结论最短长度（反假完成门槛之一） |
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
- 看门狗：评审轮超过 `reviewTurnTimeoutMs`（默认 15min）自动中止该轮（防死等），中断走 nudge/重评路径（实测已触发并自救成功）。

## v3：一个执行只对一个监督 + 达线换会话并停老会话（2026-11-14）

客户症状：**有几率开了很多会话**。四条不变量已硬编码到插件（`验证报告-20261114-一对一配对与接力停会话.md` 有实测证据）：

1. **一个执行只针对一个监督**：`acquirePair()` 是建对唯一入口，会话级串行锁 `serializeWith("pair:"+sessionId)` 覆盖整条 await 链（并发自动纳入 / 重复 `supervision_enroll` 只会有一个真正建对）；已有活体对 → `reusePair()` **复用原监督会话**，0 新开会话。
2. **一个监督只针对一个执行**：建对即 `bindSession(worker/supervisor → pairId)` 落盘 `bindings.json`；`pairView` / `/api/session-supervisor` 带 `pairing`（`oneToOne` / `sharedWith` / `conflicts`）；`enforceOneToOne()` 发现重复对 → 熔断 + 停两侧会话，写 `pairing` 类审查报告。
3. **达线自动匹配新会话**：`handoverIfNeeded()` 同侧单飞（`pair.rolling`）+ 冷却 + 竞态丢弃多开的会话；看门狗在**双方空闲点**、执行侧 `turn/end` 后都会接力（不再只在评审时判水位）；水位口径含「本轮交接卡是否已送达旧会话」，旧会话没清场就不算降级（否则会反复开会话）。
4. **老会话停止运行**：接力后 `stopRetiredSide()` → `markRetired()` + `stopSessionRun()`（`agent.cancel` + `sessionController.cancel`）；`serialDeliver` 投递前 `deliveryBlocker()` 拦住退休/非本侧会话；客户手误在退休会话里输入 → `onRetiredEvent()` 取消运行并只回「请到 <活体会话> 继续」。

重启 / 插件重转不再丢配对：`hydratePairsFromJournal()` 从持久 journal 重放事件重建注册表，重复对当场收口；静默超 `dormantAfterMs`（默认 6h）的老对转 `dormant`（不再自动跑），该执行会话再 `supervision_done` / `supervision_enroll` 即 `reopenPair()` **复用原监督会话**。回归：`node .verify/pairing-test.mjs`（47 项，含用本机真实 `reports.json` 跑的重建 + 去重）。

### 3.1 接力后的会话拿到什么（1.1.1）

- 新会话先收**自包含交接卡**（原始需求 + 对账状态 + 上次结论 + 最近 40 行日志摘录），紧着再补送**完整角色卡**（执行侧纪律 / 监督评审协议），不会因为「只有一张交接卡」而丢掉「只能调 supervision_verdict / 完成后调 supervision_done」这类硬约束。
- 停止动作全程留痕：接力时 `stop-retired-session`（`stopped: true/false`）、退休会话被再次使用时同样一行；`supervision_status.retiredSessions` 与 `/api/session-supervisor` 都带 `stopped` 字段，客户不用看代码就能确认「老会话真的停了」。

## 上下文接力（默认 240k；客户模型上限 254k，留余量）

双方水位（`tokenMeter.contextPressure`）达 `maxContextTokens` → 同 Workspace 自动开**一个**新会话（单飞 + 冷却，绝不叠加）：送达**自包含交接卡**（角色卡+原始需求+验收清单+对账状态+最近 40 行日志摘录）；**旧会话被停止运行并改名「（已接力）」**（`stop-retired-session` 事件 + `retiredSessions[].stopped` 可直接审计），永久绑在原对上（`retired` 表 + `bindings.json`），不会再被自动纳入；`supervision_status.lineage` / `retiredSessions` 记录链路。接力上限 `maxHandovers`（默认 8）。

## 防死循环熔断（多重保险）

| 保险 | 默认 |
|---|---|
| `maxFixRounds` 自动修复轮上限 | 3 |
| `maxReviews` 评审总预算 | 12 |
| `maxHandovers` 接力上限 | 8 |
| 连续模型错误（本地模型断联） | 3 次即停 |
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

`maxFixRounds`(3) / `maxReviews`(12) / `strictPairing`(true) / `hydratePairs`(true) / `stopRetiredSession`(true) / `dormantAfterMs`(6h) / `reuseCardCooldownMs`(60000) / `retiredNoticeMs`(300000) / `rolloverCooldownMs`(60000) / `maxHandovers`(8) / `maxContextTokens`(240000) / `digestMaxChars`(10000) / `serialWaitMs`(1800000) / `reviewTurnTimeoutMs`(900000) / `reviewEnabled`(true) / `autoEnrollReview`(true) / `reviewTriggerPattern`('需要审查') / `idleNudgeMs`(120000) / `idleForceReviewMs`(300000) / `completeSummaryMinChars`(40) / `debugEnrollTrace`(false)

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
