/**
 * Session supervisor: pairs an executor session (serves the customer requirement)
 * with a supervisor session (an LLM judge).
 *
 * Review timing (strict, per customer spec): the review only runs when the
 * executor finishes ALL of its work and calls supervision_done. Intermediate
 * turns, tool errors, and stalls never trigger a review — they are recorded for
 * the next done-triggered review. A manual supervision_review tool exists for
 * when a human explicitly wants a mid-flight check.
 *
 * Serial mode (local single-slot model): ALL plugin-driven deliveries run
 * through one global FIFO gate; each gate step waits until both sessions of the
 * pair are idle. The executor and the supervisor never run against the model at
 * the same time.
 *
 * Anti-runaway backstops (any one can stop the loop):
 *   - supervision_verdict is the only review exit; a missing verdict gets ONE
 *     nudge, then at most one re-review, all counted against maxReviews.
 *   - maxFixRounds caps needs_fix dispatches (then state=halted).
 *   - maxReviews caps total review rounds (then halted).
 *   - maxHandovers caps context rollovers (then halted).
 *   - consecutive model errors (agent errors + review interruptions) reaching
 *     3 halts the pair and notifies instead of retrying.
 *   - supervision_start/enroll refuse to run from a session already inside any
 *     pair, so neither role can fork new pairs.
 *
 * Context rollover (v3.1, rewritten after the 2026-11-15 blow-up): pressure is
 * read from four sources — provider-reported pressureTokens, projectedTokens,
 * tokenMeter.measure().totalTokens (works even when the provider reports zero
 * usage, which is exactly what silently disabled this guard before), and a last
 * resort surface estimate from the durable events. The threshold follows the
 * route's real contextWindow (window - contextReserveTokens, capped by
 * maxContextTokens). Rollover triggers at idle turn ends, the watchdog, before
 * each review, and BEFORE every delivery (checked outside the serial chain, so
 * it cannot self-lock). Every message the plugin pushes is measured against the
 * target's remaining budget and trimmed to fit (journal: delivery-trim /
 * pressure-wall). A CONTEXT_WINDOW_EXCEEDED error relays immediately through
 * relayOnOverflow() instead of being counted as a model error, so a saturated
 * session is replaced rather than halted.
 *
 * Auto-enrollment (customer spec, v2): a NEW session whose first real customer
 * message says 「需要审查」 is enrolled automatically — the plugin creates the
 * supervisor session, hands the executor its role card at the first idle point,
 * and the whole review/fix loop runs without the model having to call
 * supervision_enroll. If the executor ends its turn WITHOUT reporting done, the
 * idle watchdog nudges it once and then force-triggers a review, so supervision
 * cannot be silently skipped.
 *
 * Anti-fake-complete (customer spec, v2): supervision_verdict(complete) must
 * carry a per-item checklist where every item names concrete evidence
 * (command output / file path / URL). The plugin rejects complete when the
 * checklist is missing, unverified, evidence-free, or when the previous fix
 * round has no matching item — a bare "everything is done" reply cannot close
 * a pair.
 *
 * Row config (raw passthrough, no schema):
 * { maxFixRounds: 3, reviewEnabled: true, digestMaxChars: 6000,
 *   maxContextTokens: 240000, contextReserveTokens: 60000, minContextTokens: 12000,
 *   contextSafetyRatio: 0.5, deliverMaxChars: 12000, reviewMaxChars: 20000,
 *   handoverMaxChars: 9000, requirementMaxChars: 4000, checklistNoteMaxChars: 2200,
 *   fixSummaryMaxChars: 1500, fixInstrMaxChars: 3000, workerLogMaxChars: 9000,
 *   handoverTailLines: 25, overflowRelay: true,
 *   maxHandovers: 8, maxReviews: 12,
 *   serialWaitMs: 1800000, reviewTurnTimeoutMs: 900000,
 *   autoEnrollReview: true, reviewTriggerPattern: '需要审查',
 *   idleNudgeMs: 120000, idleForceReviewMs: 300000, completeSummaryMinChars: 40 }
 * Pair state is process-local; sessions/logs stay durable, supervision_enroll
 * re-arms a pair after a host restart.
 *
 * Linked-directory bundle: imports no @deepseek-ai packages; plain JSON-schema tools.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const inject = ['tools', 'agents', 'sessions', 'sessionController', 'sessionQuery', 'workspaceRegistry', 'timer', 'tokenMeter']

const pickNumber = (value, fallback, min = 0) =>
  typeof value === 'number' && Number.isFinite(value) && value >= min ? Math.floor(value) : fallback

const pickRatio = (value, fallback, min = 0.01, max = 0.99) =>
  typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max ? value : fallback

export function apply(ctx, rawConfig = {}) {
  const config = {
    maxFixRounds: pickNumber(rawConfig?.maxFixRounds, 3, 1),
    reviewEnabled: rawConfig?.reviewEnabled !== false,
    digestMaxChars: pickNumber(rawConfig?.digestMaxChars, 6000, 500),
    maxContextTokens: pickNumber(rawConfig?.maxContextTokens, 240000, 1000),
    maxHandovers: pickNumber(rawConfig?.maxHandovers, 8, 1),
    maxReviews: pickNumber(rawConfig?.maxReviews, 12, 2),
    serialWaitMs: pickNumber(rawConfig?.serialWaitMs, 1800000, 5000),
    // 串行闸门最多等多久就放弃这次投递（挂成待重投）。旧版死等 serialWaitMs(30min)：
    // 执行侧一跑长轮，后面所有投递（包括超时通知）全被堵在单链上，实测 2 小时没动静。
    deferAfterMs: pickNumber(rawConfig?.deferAfterMs, 120000, 1000),
    // v3.3 投递排队（修「监督不起作用」）：闸门只给短暂宽限期，等不到就【入库排队】，
    // 不占用全局串行链；排队不许丢；长时间抢不到通道就强行放行（宿主本来会自己排队）。
    // v3.4：宽限期只用于「评审材料构建前的短暂静默」；投递闸门改成【立刻判定、不等】，
    // 所以这里默认压到 5s（旧 20s：闸门在链里死等，整条链被吃死，实测就是「监督不起作用」）。
    pairIdleGraceMs: pickNumber(rawConfig?.pairIdleGraceMs, 5000, 500),
    // 排队条目的补发节拍：parking 后自己挂一个定时器，不再等看门狗（看门狗 15~20s 才扫一遍）
    drainRetryMs: pickNumber(rawConfig?.drainRetryMs, 2500, 250),
    channelGraceMs: pickNumber(rawConfig?.channelGraceMs, 20000, 2000),
    channelMaxWaitMs: pickNumber(rawConfig?.channelMaxWaitMs, 600000, 1000),
    channelStaleMs: pickNumber(rawConfig?.channelStaleMs, 300000, 30000),
    pendingDeliveryMax: pickNumber(rawConfig?.pendingDeliveryMax, 6, 1),
    // 全宿主单通道闸门：默认【开】。客户口径（2026-11-16 01:00）：本地模型只有一个推理通道，
    // 两个会话同时调用会把两边一起拖死，所以监督的投递必须串行排队。
    // v3.4 起「排队」不再等于「停摆」：闸门同步判定→立刻入 FIFO 队列（不占全局串行链、不丢、不乱序），
    // 通道一空（agent/status 空闲事件）或后台节拍（drainRetryMs）就补发；压过 channelMaxWaitMs 强行放行。
    // 关掉（channelGuard=false）= 只做对内串行，跨会话不排队。
    channelGuard: rawConfig?.channelGuard !== false,
    reviewTurnTimeoutMs: pickNumber(rawConfig?.reviewTurnTimeoutMs, 2700000, 30000),
    // v3.2 卡死收口（2026-11-15 实测事故：sup-2-vd699 评审轮超时 8 次 / 卡在 reviewing 2 小时）：
    // 评审超时必须收口释放 busy，且次数有上限；执行侧单轮也要有超时（旧版 worker running 时完全静默）。
    // 默认放宽到 45min×3：单通道本机实测一轮评审要 30~40min（排队 + 十几项服务端取证），
    // 旧值 30min×2 会把正常在跑的评审误杀成 halted（11-16 客户报「监督不起作用」就是这个）。
    maxReviewTimeouts: pickNumber(rawConfig?.maxReviewTimeouts, 3, 1),
    workerTurnTimeoutMs: pickNumber(rawConfig?.workerTurnTimeoutMs, 2700000, 60000),
    maxWorkerTimeouts: pickNumber(rawConfig?.maxWorkerTimeouts, 2, 1),
    // 绝对上限：从评审材料送达算起，无论是否有进展，超过这个时长一定中止该轮
    // （进展豁免只该豁免「慢」，不该豁免「永远不收敛」）。
    reviewHardCapMs: pickNumber(rawConfig?.reviewHardCapMs, 7200000, 60000),
    // 首条客户消息含「需要审查」→ 自动纳入监督
    autoEnrollReview: rawConfig?.autoEnrollReview !== false,
    reviewTriggerPattern: typeof rawConfig?.reviewTriggerPattern === 'string' ? rawConfig.reviewTriggerPattern : '需要审查',
    idleNudgeMs: pickNumber(rawConfig?.idleNudgeMs, 120000, 0),
    idleForceReviewMs: pickNumber(rawConfig?.idleForceReviewMs, 300000, 0),
    completeSummaryMinChars: pickNumber(rawConfig?.completeSummaryMinChars, 40, 0),
    // v3 一执行<->一监督 唯一性 + 接力即停旧会话（行 config 原样透传，可热载覆盖）
    strictPairing: rawConfig?.strictPairing !== false,
    hydratePairs: rawConfig?.hydratePairs !== false,
    stopRetiredSession: rawConfig?.stopRetiredSession !== false,
    forwardRetiredInput: rawConfig?.forwardRetiredInput !== false,
    dormantAfterMs: pickNumber(rawConfig?.dormantAfterMs, 21600000, 60000),
    reuseCardCooldownMs: pickNumber(rawConfig?.reuseCardCooldownMs, 60000, 0),
    rolloverCooldownMs: pickNumber(rawConfig?.rolloverCooldownMs, 60000, 0),
    // v1.2.4 客户设置的上下文大小（512K / 1M 这类）与「超限即分段」：
    // >0 时它成为**唯一接力阈值**（仍受真实窗口 − 预留量夹住）；超过它就把剩余的活拆成有序分段，
    // 每段换一个新会话逐段做，最后一段做完才进评审。0 = 关闭分段，退回旧的整段接力。
    // （测试注意：pickNumber 的 min 是 1000，写低于 1000 的值会被判非法并回落成 0＝关闭。）
    contextSplitTokens: pickNumber(rawConfig?.contextSplitTokens, 0, 1000),
    contextSplitMaxParts: pickNumber(rawConfig?.contextSplitMaxParts, 6, 2),
    contextSplitPartChars: pickNumber(rawConfig?.contextSplitPartChars, 0, 0),
    // v1.3.0 文本工具调用守卫：模型有时把工具调用写成正文（<tool_call><function=…>），
    // DSH 只执行结构化 tool-call → 这一轮 0 工具执行、却以 completed 收尾，表现就是
    // 「任务没做完就停了」。插件层补一道：本侧注入纠正（点名真实 shell 工具 pwsh），
    // 连续上限 textToolCallGuardMax(4)，干净一轮即清零。
    textToolCallGuard: rawConfig?.textToolCallGuard !== false,
    textToolCallGuardMax: pickNumber(rawConfig?.textToolCallGuardMax, 4, 1),
    retiredNoticeMs: pickNumber(rawConfig?.retiredNoticeMs, 300000, 0),
    // v3.1 上下文防爆（2026-11-15 事故修复）：水位阈值跟随路由真实窗口，
    // 投递前按剩余预算裁剪，溢出错误自动接力而不是熔断。
    contextReserveTokens: pickNumber(rawConfig?.contextReserveTokens, 60000, 2000),
    minContextTokens: pickNumber(rawConfig?.minContextTokens, 12000, 2000),
    contextSafetyRatio: pickRatio(rawConfig?.contextSafetyRatio, 0.5),
    deliverMaxChars: pickNumber(rawConfig?.deliverMaxChars, 12000, 1500),
    reviewMaxChars: pickNumber(rawConfig?.reviewMaxChars, 20000, 3000),
    handoverMaxChars: pickNumber(rawConfig?.handoverMaxChars, 9000, 1500),
    requirementMaxChars: pickNumber(rawConfig?.requirementMaxChars, 4000, 500),
    checklistNoteMaxChars: pickNumber(rawConfig?.checklistNoteMaxChars, 2200, 200),
    fixSummaryMaxChars: pickNumber(rawConfig?.fixSummaryMaxChars, 1500, 200),
    fixInstrMaxChars: pickNumber(rawConfig?.fixInstrMaxChars, 3000, 200),
    workerLogMaxChars: pickNumber(rawConfig?.workerLogMaxChars, 9000, 1000),
    handoverTailLines: pickNumber(rawConfig?.handoverTailLines, 25, 5),
    overflowRelay: rawConfig?.overflowRelay !== false,
    // v1.2.5 溢出自动续做：任何真会话撞上 `no room to answer` 这类 400，就自动开新会话接着做。
    // 链深有上限（overflowContinueMax），同一会话有冷却，避免「一直溢出→一直开会话」。
    overflowContinue: rawConfig?.overflowContinue !== false,
    overflowContinueMax: pickNumber(rawConfig?.overflowContinueMax, 8, 1),
    overflowContinueCooldownMs: pickNumber(rawConfig?.overflowContinueCooldownMs, 30000, 0),
    continueCardMaxChars: pickNumber(rawConfig?.continueCardMaxChars, 9000, 1500),
  }

  // 触发词：需要审查/需审查/要审查/需要监督/审查监督 + 英文说法。
  // 先剔除「不需要审查/无需审查/不用审查/不要审查」这类否定说法，再判命中。
  const TRIGGER_NEGATE_RE = /(?:不|无|不用|不要|没)(?:需要|需|要|用)?审查|(?:不|无)(?:需要|需)?监督/g
  const TRIGGER_HIT_RE = /需要审查|需审查|要审查|需要监督|接受监督|交给监督|开启监督|审查监督|监督审查|supervision\s*needed|needs?\s+supervision/i

  const pairs = new Map()
  const byWorker = new Map()
  const bySupervisor = new Map()
  let rpcSeq = 0
  let pairSeq = 0
  let handoverSeq = 0
  let enrollTrace = []
  // v3: 1:1 pairing registry. retired = 接力下来的旧会话（仍绑在原对上，永不再建第二对）。
  const retired = new Map()
  const pairingIssues = []
  let createSessionFailures = 0

  const warn = (message, error) => { try { ctx.logger?.warn?.(`[session-supervisor] ${message}${error ? `: ${String(error?.stack ?? error)}` : ''}`) } catch {} }
  const schedule = (callback, ms) => ctx.timer.timeout(callback, ms)
  const sleep = (ms) => ctx.timer.timeout(ms).catch(() => {})

  // ------------------------------------------------------------ report store
  // Durable review-report journal: every pair/review/verdict/handover/state
  // change appends one event; queried by the supervision_reports tool and the
  // /api/session-supervisor route consumed by the UI panel.
  const storeDir = path.join(process.env.DSH_PROFILE_DIR || path.join(os.homedir(), '.dsh'), 'session-supervisor')
  const storeFile = path.join(storeDir, 'reports.json')
  let journal = { version: 1, seq: 0, events: [] }
  let journalTimer = null
  try {
    fs.mkdirSync(storeDir, { recursive: true })
    if (fs.existsSync(storeFile)) {
      const parsed = JSON.parse(fs.readFileSync(storeFile, 'utf8'))
      if (parsed && Array.isArray(parsed.events)) journal = { version: 1, seq: 0, events: [], ...parsed }
    }
  } catch (error) { warn('report store load failed', error) }
  const writeStore = () => {
    // atomic: a crash during writeFileSync would truncate the durable review
    // journal, which is the one thing reviews are replayed from
    const tmp = `${storeFile}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(journal))
    fs.renameSync(tmp, storeFile)
  }
  const persistJournal = () => {
    if (journalTimer) return
    journalTimer = setTimeout(() => {
      journalTimer = null
      try { writeStore() } catch (error) { warn('report store write failed', error) }
    }, 300)
    if (journalTimer.unref) journalTimer.unref()
  }
  let touchJournal = () => {}
  const recordReport = (kind, pair, data) => {
    const event = { id: (journal.seq += 1), at: Date.now(), kind, pairId: pair?.id ?? null, pairName: pair?.name ?? null, data: data ?? {} }
    if (pair) { pair.lastEventAt = event.at; touchJournal(pair, event.at) }
    journal.events.push(event)
    if (journal.events.length > 5000) journal.events = journal.events.slice(-4000)
    persistJournal()
    return event
  }
  ctx.effect(() => () => { if (journalTimer) { clearTimeout(journalTimer); journalTimer = null } try { writeStore() } catch {} })
  // ---------------------------------------------------- v3 1:1 配对登记表
  // 规则：一个执行会话 <-> 一个监督会话。绑定关系落盘（bindings.json），宿主重启 /
  // 插件重转后依然有效；上下文达线接力换下来的旧会话记入 retired，且仍绑在原对上：
  // 它不会再接收插件投递、也不会再被自动纳入监督，从根上杜绝「一个任务开出很多会话」。
  const bindingFile = path.join(storeDir, "bindings.json")
  const bindingState = new Map()
  let bindingTimer = null
  try {
    if (fs.existsSync(bindingFile)) {
      const parsed = JSON.parse(fs.readFileSync(bindingFile, "utf8"))
      for (const [key, value] of Object.entries(parsed?.sessions ?? {})) if (value?.pairId) bindingState.set(key, value)
    }
  } catch (error) { warn("pair bindings load failed", error) }
  const flushBindings = () => {
    const tmp = bindingFile + ".tmp"
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, sessions: Object.fromEntries(bindingState) }))
    fs.renameSync(tmp, bindingFile)
  }
  const persistBindings = () => {
    if (bindingTimer) return
    bindingTimer = setTimeout(() => { bindingTimer = null; try { flushBindings() } catch (error) { warn("pair bindings write failed", error) } }, 300)
    if (bindingTimer.unref) bindingTimer.unref()
  }
  const bindSession = (sessionId, pair, role, isRetired = false) => {
    if (!sessionId || !pair) return
    bindingState.set(sessionId, { pairId: pair.id, role, retired: !!isRetired, name: pair.name ?? null, at: Date.now() })
    persistBindings()
  }
  const markRetired = (sessionId, pair, role) => {
    if (!sessionId) return
    retired.set(sessionId, { pairId: pair.id, role, at: Date.now() })
    if (role === "worker") { if (byWorker.get(sessionId) === pair) byWorker.delete(sessionId); pair.workerRunning = false }
    else { if (bySupervisor.get(sessionId) === pair) bySupervisor.delete(sessionId); pair.supervisorRunning = false }
    bindSession(sessionId, pair, role, true)
  }
  const livePairOf = (sessionId) => (byWorker.get(sessionId) ?? bySupervisor.get(sessionId) ?? null)
  const boundPairOf = (sessionId) => {
    if (!sessionId) return null
    const live = livePairOf(sessionId)
    if (live) return live
    const info = retired.get(sessionId) ?? bindingState.get(sessionId)
    return info?.pairId ? pairs.get(info.pairId) ?? null : null
  }
  const boundPairId = (sessionId) => {
    if (!sessionId) return null
    const live = livePairOf(sessionId)
    if (live) return live.id
    const info = retired.get(sessionId) ?? bindingState.get(sessionId)
    return info?.pairId ?? null
  }
  const roleOfSide = (sessionId) => (byWorker.get(sessionId) ? "worker" : bySupervisor.get(sessionId) ? "supervisor" : (retired.get(sessionId) ?? bindingState.get(sessionId))?.role ?? null)
  const retiredSides = (pair) => (pair.lineage ?? []).filter((row) => row?.previousId).map((row) => ({ sessionId: row.previousId, side: row.side, relayedTo: row.newId ?? null, at: row.at ?? null, stopped: row.stopped ?? false }))
  const pairingSummary = (pair) => {
    const ids = new Set([pair.workerId, pair.supervisorId])
    const active = [...pairs.values()].filter((other) => other.state === "active")
    const sharedWith = active.filter((other) => other.id !== pair.id && [other.workerId, other.supervisorId].some((id) => ids.has(id))).map((other) => other.id)
    const workerPairCount = active.filter((other) => other.workerId === pair.workerId).length
    const supervisorPairCount = active.filter((other) => other.supervisorId === pair.supervisorId).length
    return { oneToOne: sharedWith.length === 0 && workerPairCount <= 1 && supervisorPairCount <= 1, sharedWith, workerPairCount, supervisorPairCount, conflicts: pairingConflicts() }
  }
  const recordPairing = (pair, data) => { recordReport("pairing", pair, data); return data }
  /** 自检：当前是否还存在「一个执行挂多个监督 / 一个监督挂多个执行」的活体重叠。 */
  function pairingConflicts() {
    const alive = [...pairs.values()].filter((pair) => pair.state === 'active' || pair.state === 'dormant')
    const byWorkerSide = new Map()
    const bySupervisorSide = new Map()
    for (const pair of alive) {
      if (pair.workerId) byWorkerSide.set(pair.workerId, [...(byWorkerSide.get(pair.workerId) ?? []), pair.id])
      if (pair.supervisorId) bySupervisorSide.set(pair.supervisorId, [...(bySupervisorSide.get(pair.supervisorId) ?? []), pair.id])
    }
    return [
      ...[...byWorkerSide.entries()].filter(([, ids]) => ids.length > 1).map(([key, ids]) => ({ kind: 'worker-shared', sessionId: key, pairIds: ids })),
      ...[...bySupervisorSide.entries()].filter(([, ids]) => ids.length > 1).map(([key, ids]) => ({ kind: 'supervisor-shared', sessionId: key, pairIds: ids })),
    ]
  }
  const isCurrentSide = (pair, sessionId) => !!sessionId && (pair.workerId === sessionId || pair.supervisorId === sessionId)
  /** 停止一个会话当前正在跑的这一轮（接力、退休、熔断、去重后用）。 */
  async function stopSessionRun(sessionId, reason) {
    if (!sessionId) return false
    let stopped = false
    try {
      const agent = ctx.agents.get(sessionId)
      if (agent) { agent.cancel({ kind: "user", reason: "session-supervisor: " + snippet(reason, 120) }); stopped = true }
    } catch (error) { warn("agent cancel failed (" + sessionId + ")", error) }
    try { await ctx.sessionController.cancel({ sessionId }); stopped = true } catch (error) { if (!stopped) warn("session cancel failed (" + sessionId + ")", error) }
    if (stopped) warn("stopped session run: " + sessionId + " (" + snippet(reason, 140) + ")")
    return stopped
  }
  function stopPairSides(pair, reason) {
    if (!config.stopRetiredSession) return
    stopSessionRun(pair.workerId, reason).catch(() => {})
    stopSessionRun(pair.supervisorId, reason).catch(() => {})
    pair.workerRunning = false
    pair.supervisorRunning = false
  }
  /** 投递前的归属检查：退休会话 / 已被替换的一侧 / 不属于本对 -> 直接丢弃这次投递。 */
  function deliveryBlocker(pair, sessionId, tag) {
    if (!sessionId) return "no-session-id"
    const info = retired.get(sessionId)
    // 例外：退休会话只允许「换会话提示」，仍走串行队列，不与模型槽位抢跑
    if (info && tag !== "retired-notice") return "retired-by-" + info.role + "-handover-" + info.pairId
    if (isCurrentSide(pair, sessionId)) return ""
    const owner = livePairOf(sessionId)
    if (owner && owner.id !== pair.id) return "session-now-belongs-to-" + owner.id
    return "not-a-side-of-" + pair.id
  }
  /** 同一 key 串行化（建对/接力）：并发请求里只有一个真正创建会话。 */
  const keyChains = new Map()
  function serializeWith(key, fn) {
    const previous = keyChains.get(key) ?? Promise.resolve()
    const settled = previous.then(fn, fn)
    const barrier = settled.then(() => {}, () => {})
    keyChains.set(key, barrier)
    barrier.then(() => { if (keyChains.get(key) === barrier) keyChains.delete(key) })
    return settled
  }
  touchJournal = (pair, at) => {
    pair.lastTouchAt = at ?? Date.now()
    pair.supervisorIdleSince = pair.supervisorRunning ? 0 : (pair.supervisorIdleSince || pair.lastTouchAt)
    pair.workerIdleSince = pair.workerRunning ? 0 : (pair.workerIdleSince || pair.lastTouchAt)
  }
  ctx.effect(() => () => { if (bindingTimer) { clearTimeout(bindingTimer); bindingTimer = null; try { flushBindings() } catch {} } })

  // ---------------------------------------------------------------- utilities

  const isSupRpc = (value) => typeof value === 'string' && value.startsWith('sup:')
  const snippet = (value, max) => {
    let text
    if (typeof value === 'string') text = value
    else { try { text = JSON.stringify(value) } catch { text = String(value) } }
    text = (text ?? 'null').replace(/\s+/g, ' ').trim()
    return text.length > max ? `${text.slice(0, max)}…` : text
  }
  const contentText = (content, max) => {
    if (!Array.isArray(content)) return ''
    const parts = []
    for (const block of content) {
      if (!block || typeof block !== 'object') continue
      if (block.type === 'text' && block.text) parts.push(block.text)
      else if (block.type === 'tool-call') parts.push(`[调用 ${block.name} ${snippet(block.arguments ?? block.input ?? {}, 160)}]`)
    }
    return snippet(parts.join(' '), max)
  }
  const kTokens = (value) => (typeof value === 'number' && Number.isFinite(value) ? `${Math.round(value / 1000)}k` : '?')

  // ------------------------------------------------ context pressure (v3.1 防爆)
  // 事故根因（2026-11-15 18:27，sup-1-9c6ry 执行侧）：provider 把 usage 全报成 0
  // （assistant/attempt 里 `"usage":{"inputTokens":0,"outputTokens":0,"totalTokens":0}`），
  // 于是 tokenMeter.contextPressure().pressureTokens 恒为 undefined，旧代码
  // `contextTokens() ?? 0` 永远小于阈值 —— 达线接力形同虚设，会话一路涨到
  // 536837 tokens，被 provider 以 CONTEXT_WINDOW_EXCEEDED 永久拒（DSH 自带压缩
  // 也因为同样的 400 救不回来），最后插件只是把它记成「连续 3 次模型错误」熔断。
  // 现在：provider 报的 → 投影(next-prompt)估值 → measure() 重定价总量 → 事件流字数估算，
  // 四路取最大值；任何一路活着都能测出水位，全都没有才判未知。
  const OVERFLOW_RE = /CONTEXT_WINDOW_EXCEEDED|context_length_exceeded|context window|too many(?: input)? tokens|maximum context length|prompt is too long|no room (?:to|for)/i
  const isOverflow = (value) => {
    if (!value) return false
    const text = value instanceof Error ? `${value.name} ${value.message}` : typeof value === 'object' ? `${value.code ?? ''} ${value.name ?? ''} ${value.message ?? ''}` : String(value)
    return OVERFLOW_RE.test(text)
  }
  /** 中英/代码混合码点近似：~3 字符/词元（保守取整）。 */
  const charsToTokens = (chars) => Math.ceil((chars || 0) / 3)
  const contentChars = (content) => {
    if (typeof content === 'string') return content.length
    if (!Array.isArray(content)) return 0
    return content.reduce((sum, block) => sum + (block?.type === 'text' ? (block.text?.length ?? 0) : 0), 0)
  }
  /** 兜底估算：直接扫会话事件（provider 报 0 usage 且 measure() 也不在时的最后防线）。 */
  function surfaceEstimate(session) {
    let chars = 0
    for (const event of session?.events ?? []) {
      const data = event?.data ?? {}
      chars += contentChars(data.content) + contentChars(data.message?.content)
      if (event?.type === 'tool/call') chars += typeof data.arguments === 'string' ? data.arguments.length : (JSON.stringify(data.arguments ?? {}).length)
      chars += 12 // 每条事件的角色框/序号开销
    }
    return charsToTokens(chars)
  }
  const meter = () => { try { return ctx.get('tokenMeter') } catch { return undefined } }
  /**
   * 宿主公开的路由窗口可能比 provider 实际吃的要大（本机：声明 1M，实跑到 524288 就被拒）。
   * provider 的 400 里带着真数字，抓到就当作这一侧的硬上限用。
   */
  const observedCeilings = new Map()
  function parseWindowCeiling(detail) {
    const text = String(detail ?? '')
    const patterns = [
      /prompt \((\d+) tokens?\)[^)]*?context[^\d(]*(\d{4,})/i,
      /context \((\d{4,})\)/i,
      /(?:context window|max(?:imum)? context(?: length)?)[^\d]{0,12}(\d{5,})\s*(?:tokens?|k\b)?/i,
    ]
    for (const re of patterns) {
      const m = text.match(re)
      const n = m ? Number(m[2] ?? m[1]) : NaN
      if (Number.isFinite(n) && n >= 1000) return n
    }
    return undefined
  }
  const ceilingOf = (sessionId) => observedCeilings.get(sessionId)
  const windowOf = (sessionId, declared) => {
    const ceiling = ceilingOf(sessionId)
    if (declared === undefined) return ceiling
    if (ceiling === undefined) return declared
    return Math.min(declared, ceiling)
  }
  function messageTokens(text) {
    if (!text) return 0
    try {
      const n = meter()?.estimateMessage?.({ role: 'user', content: [{ type: 'text', text }] })
      if (typeof n === 'number' && Number.isFinite(n) && n > 0) return n
    } catch {}
    return charsToTokens(text.length)
  }
  /** 一侧会话的上下文水位：tokens/window/source/limit/remaining/room/over。 */
  function pressureOf(sessionId) {
    const unknown = { tokens: undefined, window: undefined, source: 'none', limit: limitFor(), remaining: 0, room: 0, over: false }
    if (!sessionId) return unknown
    let session
    try { session = ctx.sessions.get(sessionId) } catch { return unknown }
    if (session === undefined) return unknown
    let cp = {}
    try { cp = meter()?.contextPressure?.(session) ?? {} } catch { cp = {} }
    let measured
    try { measured = meter()?.measure?.(session) } catch { measured = undefined }
    const declaredWindow = typeof cp.contextWindow === 'number' && cp.contextWindow > 0 ? cp.contextWindow : undefined
    const window = windowOf(sessionId, declaredWindow)
    const provider = typeof cp.pressureTokens === 'number' ? cp.pressureTokens : undefined
    const projected = typeof cp.projectedTokens === 'number' ? cp.projectedTokens : undefined
    const measuredTotal = typeof measured?.totalTokens === 'number' ? measured.totalTokens : undefined
    // 权威读数优先：provider 报的 / 下一拍投影 / measure() 的重定价总量。measure() 在 provider
    // 不报 usage 时会给 estimated 基线，并且尊重压缩后的 surface —— 这是它优于字数估算之处。
    // 三者全都拿不到才退回事件流字数估算：扫原始事件会把已被压缩掉的旧 span 也算进去，
    // 长期会话会高估，所以它只当最后防线，不参与取最大值。
    const guess = surfaceEstimate(session)
    const authoritative = [provider, projected, measuredTotal].filter((n) => typeof n === 'number' && Number.isFinite(n))
    if (authoritative.length === 0) {
      if (!(guess > 0)) return { ...unknown, window, limit: limitFor(window) }
      const limit0 = limitFor(window)
      return { tokens: guess, window, source: 'heuristic', limit: limit0, baselineKind: measured?.baseline?.kind ?? null, remaining: Math.max(0, limit0 - guess), room: Math.max(0, Math.floor((limit0 - guess) * config.contextSafetyRatio)), over: guess >= limit0 }
    }
    const tokens = Math.max(...authoritative)
    const source = tokens === measuredTotal ? 'measured'
      : tokens === projected ? 'projected'
      : tokens === provider ? 'provider' : 'measured'
    const limit = limitFor(window)
    return {
      tokens, window, source, limit, declaredWindow, ceiling: ceilingOf(sessionId) ?? null,
      baselineKind: measured?.baseline?.kind ?? null,
      heuristicTokens: guess,
      remaining: Math.max(0, limit - tokens),
      room: Math.max(0, Math.floor((limit - tokens) * config.contextSafetyRatio)),
      over: tokens >= limit,
    }
  }
  /** 阈值跟随真实窗口：窗口 − 预留量 与配置上限取小；小窗口下再兜一半的下限。
   *  v1.2.4：`contextSplitTokens` 一旦设置（512K/1M 这类客户设定），它就是那个「配置上限」，
   *  但仍然不许超过「窗口 − 预留量」——否则永远到不了阈值，分段一次都不会触发。 */
  function limitFor(window) {
    const cap = config.contextSplitTokens > 0 ? config.contextSplitTokens : config.maxContextTokens
    if (typeof window !== 'number' || window <= 0) return cap
    const floor = Math.min(config.minContextTokens, Math.max(1000, Math.floor(window * 0.5)))
    const capped = Math.max(floor, window - config.contextReserveTokens)
    return Math.max(1000, Math.min(cap, capped))
  }
  const pressureText = (p) => `≈${kTokens(p.tokens)}（${p.source}${p.window ? `/窗 ${kTokens(p.window)}` : ''}/线 ${kTokens(p.limit)}）`
  /** 建对时提醒客户：本地模型单通道，别的会话还在跑就会互相拖慢。 */
  const channelAdvice = (pair) => {
    const others = channelOthers(pair)
    if (others.length === 0) return '\n模型通道：当前没有其他会话在跑，串行无冲突。'
    return `\n模型通道：现在还有 ${others.length} 个别的会话在跑（${others.slice(0, 3).join(', ')}…）——本地模型单通道，它们跑着时插件不会插队（投递会排队/延后），要快就先把无关会话停掉。`
  }
  /** 角色卡/评审头一行给会话看的水位描述（水位测不出时给出明确原因，不假装正常）。 */
  const sidePressureLine = (pair, role) => {
    const p = pressureOf(role === 'worker' ? pair.workerId : pair.supervisorId)
    return p.tokens === undefined
      ? `水位未知（会话未载入或无读数），接力阈值 ${kTokens(p.limit)}`
      : `水位 ${kTokens(p.tokens)}（读数来源 ${p.source}），接力阈值 ${kTokens(p.limit)}${p.window ? `，窗口 ${kTokens(p.window)}` : ''}`
  }

  /** 中间裁掉、首尾保留：评审/交接材料最有用的是开头结论与最近现场。 */
  function capMiddle(text, maxChars, label) {
    const s = typeof text === 'string' ? text : text == null ? '' : String(text)
    if (s.length <= maxChars) return s
    const mark = `\n…〔${label ?? '内容'}按上下文预算裁掉 ${s.length - maxChars} 字，原 ${s.length} 字；全文可用 supervision_worker_log / supervision_reports 取〕…\n`
    const head = Math.max(200, Math.floor((maxChars - mark.length) * 0.65))
    const tail = Math.max(0, maxChars - mark.length - head)
    return s.slice(0, head) + mark + (tail > 0 ? s.slice(s.length - tail) : '')
  }
  /**
   * 投递闸门：插件塞进会话的每一条消息都先量一遍，装不下就裁到剩余额度内。
   * 单这一条就能杜绝「一次送审把会话顶爆」；水位未知时只做硬上限，不做比例裁剪。
   */
  function fitDelivery(pair, sessionId, tag, text) {
    let out = capMiddle(text, config.deliverMaxChars, `投递 ${tag}`)
    const p = pressureOf(sessionId)
    if (p.tokens === undefined || messageTokens(out) <= p.room) return out
    const targetChars = Math.max(900, Math.floor(p.room * 3))
    if (out.length > targetChars) {
      const before = out.length
      out = capMiddle(out, targetChars, `${tag}(上下文预算 ${kTokens(p.tokens)}/${kTokens(p.limit)})`)
      warn(`delivery ${tag} shrunk ${before}->${out.length} chars for ${sessionId} ${pressureText(p)}`)
      if (pair) recordReport('delivery-trim', pair, { tag, sessionId, from: before, to: out.length, tokens: p.tokens, limit: p.limit, source: p.source, window: p.window ?? null })
    }
    return out
  }

  async function workerEvents(pair) {
    try {
      const live = ctx.sessions.get(pair.workerId)
      if (live && Array.isArray(live.events)) return live.events
    } catch {}
    try {
      const snapshot = await ctx.sessionQuery.readSession(pair.workerId)
      return snapshot?.events ?? []
    } catch (error) {
      warn(`read worker log failed (${pair.id})`, error)
      return []
    }
  }

  const toolResultError = (data) => {
    if (!data || typeof data !== 'object') return undefined
    if (data.error && typeof data.error === 'object') return data.error
    if (data.isError === true) return {}
    const status = data.status ?? data.result?.status
    return status === 'error' || status === 'failure' ? {} : undefined
  }

  /** Fold one worker event into a compact review line; empty string = skip. */
  function digestLine(event, toolNames) {
    const data = event?.data ?? {}
    switch (event?.type) {
      case 'turn/start': return '—— 执行轮开始 ——'
      case 'user/message': {
        const rpc = data.source?.rpcId
        const parts = Array.isArray(data.content) ? data.content : []
        if (isSupRpc(rpc)) {
          const prefix = rpc.startsWith('sup:fix:') ? '[监督者修复指令]'
            : rpc.startsWith('sup:requirement:') ? '[客户要求(下发)]'
            : rpc.startsWith('sup:notice:') ? '[监督系统通知]'
            : rpc.startsWith('sup:handover:') ? '[接力交接]'
            : '[监督系统消息]'
          return `${prefix} ${contentText(parts, 320)}`
        }
        const noise = /^(Current runtime context|<system-reminder>|Time sampled|\[MNEMON\]|MNEMON RUNTIME MEMORY)/i
        const real = parts.filter((b) => b?.type === 'text' && b.text && !noise.test(b.text.trim()))
        if (real.length === 0) return ''
        return `[客户输入] ${contentText(real, 400)}`
      }
      case 'assistant/message': return `执行会话回复: ${contentText(data.message?.content, 400)}`
      case 'tool/call': return `调用工具 ${String(data.name ?? '?')} ${snippet(data.arguments ?? {}, 140)}`
      case 'tool/result': {
        const error = toolResultError(data)
        if (error) return `工具失败: ${error.name ?? ''} ${error.code ?? ''} ${snippet(error.message ?? contentText(data.message?.content, 200), 220)}`.trim()
        const callId = data.message?.toolCallId ?? data.toolCallId ?? data.callId
        const name = (callId != null && toolNames?.get(callId)) || toolNames?.get('__last__') || '?'
        return `✓ ${name} 成功`
      }
      case 'todo/write': {
        const todos = Array.isArray(data.todos) ? data.todos : []
        const count = (status) => todos.filter((todo) => todo?.status === status).length
        return `TODO 快照: 已完成 ${count('completed')}, 进行中 ${count('in_progress')}, 待办 ${count('pending')}`
      }
      case 'turn/end': {
        const reason = data.reason ?? {}
        return reason.kind === 'error' ? `轮结束·错误: ${snippet(reason.error?.message ?? reason.error ?? '', 300)}` : `轮结束·${reason.kind ?? '未知'}`
      }
      default: return ''
    }
  }

  function collectToolNames(events, uptoIndex) {
    const names = new Map()
    for (let index = 0; index <= uptoIndex && index < events.length; index += 1) {
      const event = events[index]
      if (event?.type !== 'tool/call') continue
      const data = event.data ?? {}
      const id = data.id ?? data.toolCallId ?? data.callId
      if (id != null) names.set(id, String(data.name ?? '?'))
      names.set('__last__', String(data.name ?? '?'))
    }
    return names
  }

  function digestLinesOf(events) {
    const lines = []
    for (let index = 0; index < events.length; index += 1) {
      const event = events[index]
      const line = digestLine(event, collectToolNames(events, index))
      if (line) lines.push(`#${event.seq ?? index} ${line}`)
    }
    return lines
  }

  function buildDigest(events, sinceSeq, maxChars) {
    const lines = []
    let maxSeq = sinceSeq
    for (let index = 0; index < events.length; index += 1) {
      const event = events[index]
      if (typeof event?.seq === 'number' && event.seq > maxSeq) maxSeq = event.seq
      if (typeof event?.seq === 'number' && event.seq <= sinceSeq) continue
      const line = digestLine(event, collectToolNames(events, index))
      if (line) lines.push(`#${event.seq ?? index} ${line}`)
    }
    const kept = []
    let budget = maxChars
    let dropped = 0
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      budget -= lines[index].length + 1
      if (budget < 0) { dropped = index + 1; break }
      kept.unshift(lines[index])
    }
    const text = (dropped ? `…(更早 ${dropped} 行省略, 可用 supervision_worker_log 查看)\n` : '') + kept.join('\n')
    return { text, maxSeq }
  }

  // ---------------------------------------------------------------- serial gate

  let serialTail = Promise.resolve()
  let watchdogAt = 0
  /** 全宿主活跃会话（sessionId -> since）。本地模型单通道：同时只允许一个在跑。 */
  const liveAgents = new Map()
  let channelSource = 'events'

  // v3.4：只有【明确在跑】才算忙。旧口径 `=== false` 把「运行位还没被 agent/status 更新过」
  // （undefined：新建对的第一拍、插件重载/hydrate 复原的对）当成忙 —— 结果每一条投递都被
  // 判成 not-idle 入队，而队列排空的判据同样是「不在 idle」，永远排不空 ——
  // 客户看到的就是「会话监督不起作用」（11-16 实测：sup-1-95j9s 投递全被 gate=channel-busy/not-idle 停投）。
  const pairIdle = (pair) => pair.workerRunning !== true && pair.supervisorRunning !== true

  /**
   * 等这一对完全空闲。超时后默认「放弃这次投递」而不是硬塞：worker 单轮可能连着跑
   * 很久（实测 2.5 小时 / 61 步的取证轮），硬塞会在轮中途 splice inbox 打断它，
   * 客户看到的就是「跑到一半被打断/白跑」。放弃的投递由看门狗在空闲点重投。
   */
  async function waitPairIdle(pair, opts = {}) {
    const deadline = Date.now() + (opts.waitMs ?? config.serialWaitMs)
    while (!pairIdle(pair)) {
      if (pair.state === 'stopped') return false
      if (Date.now() > deadline) {
        warn(`serial gate timed out (${pair.id}); ${opts.defer ? 'deferring delivery' : 'delivering anyway'} (worker=${pair.workerRunning}, supervisor=${pair.supervisorRunning})`)
        return opts.defer ? false : true
      }
      await sleep(2000)
    }
    return true
  }

  /**
   * 本对以外正在占用模型通道的会话（本地模型单通道，它们跑着时插件不许插队）。
   * 只认「最近真的在动」的会话：running 挂着但 updatedAt 早于 channelStaleMs 的算僵尸条目，
   * 否则一个卡住的会话就能把监督永久饿死（v3.2 实测踩过）。
   */
  const channelOthers = (pair, now = Date.now()) => [...liveAgents.entries()]
    .filter(([id, entry]) => id !== pair.workerId && id !== pair.supervisorId
      && (typeof entry !== 'object' || !entry.updatedAt || now - entry.updatedAt <= config.channelStaleMs))
    .map(([id]) => id)
  /**
   * 用宿主 session/list 校正通道账本：agent/status 事件只覆盖「插件加载之后」的状态，
   * 重载时已经在跑的会话不会重放事件 —— 那会让闸门误判成「通道空闲」。
   * 真实宿主可按 running 字段重建；桩/异常（拿不到清单）时保留事件账本不动。
   */
  async function syncChannelRoster() {
    let value
    try { value = await ctx.sessionController.list?.({}, AbortSignal.timeout(10000)) } catch { return }
    const items = value?.items ?? value?.sessions
    if (!Array.isArray(items) || items.length === 0) return
    const now = Date.now()
    const next = new Map()
    const seen = new Set()
    for (const row of items) {
      const id = row?.sessionId ?? row?.id
      if (!id) continue
      seen.add(id)
      if (row?.running === true) {
        const previous = liveAgents.get(id)
        const updated = typeof row.updatedAt === 'number' ? row.updatedAt : now
        next.set(id, { since: previous?.since ?? updated, updatedAt: updated, seenAt: now })
      }
    }
    // 事件刚入账、清单还没反映的（30s 内）保留
    for (const [id, entry] of liveAgents) if (!seen.has(id) && now - (entry?.seenAt ?? now) < 30000) next.set(id, entry)
    liveAgents.clear()
    for (const [id, entry] of next) liveAgents.set(id, entry)
    channelSource = 'list'
  }
  /**
   * 排队（v3.3）：同一 (tag, sessionId) 只留最新一份文本，但保持先来后到的位置，
   * 这样角色卡/评审/整改指令不会因为「通道一直忙」而被静默丢掉 —— 丢卡就是「监督不起作用」。
   */
  function parkDelivery(pair, tag, sessionId, text, gate, extra = {}, hint = {}) {
    const queue = pair.pendingDeliveries ?? (pair.pendingDeliveries = [])
    const existing = queue.findIndex((row) => row.tag === tag && row.sessionId === sessionId)
    // hint.since：从队列里取出来又被重新排队的条目，必须保留原始排队时刻，
    // 否则「饿死计时」每轮重置 → channelMaxWaitMs 强行放行永远触发不了。
    const since = hint.since ?? Date.now()
    const tries = hint.tries ?? 0
    const previousGate = existing >= 0 ? queue[existing].gate : null
    const row = { tag, sessionId, text, since: existing >= 0 ? queue[existing].since : since, tries: existing >= 0 ? (queue[existing].tries ?? 0) + 1 : tries, gate }
    if (existing >= 0) queue[existing] = row
    else queue.push(row)
    while (queue.length > config.pendingDeliveryMax) queue.splice(0, queue.length - config.pendingDeliveryMax)
    // 只在「首次入队」或「闸门换了」时记 journal + 日志：补发节拍每 2.5s 重来一次的话，
    // 同一条卡住的材料会把 journal 刷成几百条，还会拖慢同步落盘（实测把回归测试拖到 60s+）。
    if (existing < 0 || previousGate !== gate) {
      recordReport('delivery-deferred', pair, { tag, sessionId, gate, queued: queue.length, tries: row.tries, ...extra })
      warn(`${tag} delivery parked (${pair.id}); gate=${gate} queued=${queue.length}`)
    }
    // 排队后自己挂补发节拍：看门狗 15~20s 才扫一遍，不能让客户等这么久（更靠不住的是它没扫到）。
    armDrain(pair, config.drainRetryMs)
  }
  /** 每个对只挂一个补发定时器（合并重复），到点排空队列。 */
  function armDrain(pair, delayMs) {
    const waitMs = Math.max(delayMs, 50)
    if (pair.drainAt > Date.now()) return
    pair.drainAt = Date.now() + waitMs
    schedule(() => {
      pair.drainAt = 0
      if (pair.state !== 'active') { pair.pendingDeliveries = []; return }
      drainPendingDeliveries(pair, Date.now())
    }, waitMs)
  }
  /**
   * 有人在看着（面板轮询 / supervision_status 查询）：把压着的待投队列立刻重试一次。
   * 后台节拍（drainRetryMs）负责自动补发；客户手动查状态的这一刻不该还得等下一拍才动。
   */
  function nudgeQueuedDrains() {
    for (const p of pairs.values()) if ((p.pendingDeliveries ?? []).length > 0) armDrain(p, 0)
  }
  /** 看门狗排空队列：通道 + 这一对都空才发；饿太久就强行放行（宿主本来会自己排队）。 */
  function drainPendingDeliveries(pair, now) {
    const queue = pair.pendingDeliveries
    if (!queue || queue.length === 0) return
    if (pair.state !== 'active') { pair.pendingDeliveries = []; return }
    // 抖动闸门：状态轮询 / 空闲事件都会催补发，200ms 内只真正试一次，别把链与 journal 刷爆
    if (now - (pair.lastDrainAt ?? 0) < 200) { armDrain(pair, 220); return }
    pair.lastDrainAt = now
    const row = queue.find((item) => !item.inFlight)
    if (!row) return
    const starved = now - row.since > config.channelMaxWaitMs
    if (!starved && (!pairIdle(pair) || channelOthers(pair, now).length > 0)) { armDrain(pair, config.drainRetryMs); return }
    if (starved) warn(`forcing parked ${row.tag} delivery (${pair.id}) after ${Math.round((now - row.since) / 1000)}s of channel contention`)
    // v3.4.1：原地重试 —— 条目【留在队列里】只打 inFlight 标记，投成功了才摘掉。
    // 旧写法先 shift 再投：闸门一变忙就 parkDelivery 重新 push（existing<0）→ 于是
    // ① 每次重试都算「首次入队」→ journal 每 2.5s 刷一条 delivery-deferred（真机实测刷了 30+ 条）；
    // ② since/tries 被重置 → 饿死计时与 tries 计数全废。
    row.inFlight = true
    serialDeliver(pair, row.tag, row.sessionId, row.text, { fromQueue: true, forced: starved, queueRow: row })
      .then((requestId) => {
        row.inFlight = false
        if (!requestId) return
        const index = (pair.pendingDeliveries ?? []).indexOf(row)
        if (index >= 0) pair.pendingDeliveries.splice(index, 1)
      })
      .catch((error) => { row.inFlight = false; warn('queued delivery failed', error) })
  }

  /** The turnstile: one plugin delivery at a time, pair fully idle, never concurrent model use. */
  function serialDeliver(pair, tag, sessionId, text, opts = {}) {
    // v3.1 投递前水位闸门。这段必须留在串行链【外面】：链内 await 接力会自锁
    // （接力自己也要经这条链投递交接卡），实测症状就是投递永不落地。
    // 接力是异步换会话；下面的 run 只负责把料改发给届时的活体会话。
    const side = pair.workerId === sessionId ? "worker" : pair.supervisorId === sessionId ? "supervisor" : null
    if (side && pair.state === "active") {
      const wall = pressureOf(sessionId)
      if (wall.over) {
        warn(`${tag} -> ${sessionId} hit pressure wall (${pair.id} ${side} ${pressureText(wall)}); relaying first`)
        recordReport("pressure-wall", pair, { tag, role: side, sessionId, tokens: wall.tokens ?? null, limit: wall.limit, window: wall.window ?? null, source: wall.source })
        pushError(pair, `${side === "worker" ? "执行" : "监督"}侧投递 ${tag} 前撞上水位 ${pressureText(wall)}，先接力再投递（绝不往快爆的会话里塞料）`)
        handoverIfNeeded(pair, side, { reason: `投递 ${tag} 前${side === "worker" ? "执行" : "监督"}侧${pressureText(wall)}已过阈值` })
          .catch((error) => warn("pre-delivery rollover failed", error))
      }
    }
    const run = async () => {
      if (pair.state === 'stopped' && tag !== 'notice') return
      // 接力可能已经把本侧换到新会话：改发届时的活体会话，避免投给退休会话被 deliveryBlocker 丢掉
      const target = side ? (side === "worker" ? pair.workerId : pair.supervisorId) : sessionId
      // v3 投递前一致性检查：会话已被接力退休 / 已不属于本对（重复对）时不再投递，
      // 避免旧会话被唤醒 —— 这是「老会话停止运行」的硬保证。
      const why = deliveryBlocker(pair, target, tag)
      if (why) {
        warn(`skip ${tag} delivery -> ${target} (${why})`)
        // v1.2.4 真正的死锁源：队列里指向【已退休/已换掉】会话的条目，重试永远只会被 blocker 挡回。
        // 不把它从队列摘掉，FIFO 头就永久堵住，后面所有分段卡/角色卡都发不出去（实测：第 2 段卡被
        // 一个发给旧会话的 worker-card 堵死）。这里按「丢弃并出队」处理，并留 audit。
        if (opts.queueRow) {
          const index = (pair.pendingDeliveries ?? []).indexOf(opts.queueRow)
          if (index >= 0) pair.pendingDeliveries.splice(index, 1)
          recordReport('delivery-dropped', pair, { tag, sessionId: target, reason: why, queued: (pair.pendingDeliveries ?? []).length })
        }
        return
      }
      const queue = pair.pendingDeliveries ?? (pair.pendingDeliveries = [])
      // v3.3 先来后到：队里还有更早的料没投出去，这条也只能入库排队（保持顺序，角色卡不被 notice 抢跑）。
      // 关键变化：闸门只给短暂宽限，等不到就【入库并立刻返回】，绝不把全局串行链按住 ——
      // 旧版死等 deferAfterMs(2min)：19 个对每来一条就占链 2 分钟，整条链被吃死；
      // 而旧版单槽 deferredDelivery 还会被后来的 notice 覆盖，【角色卡直接丢失】
      // （监督会话拿不到角色卡 → 永远不调 supervision_verdict → 超时熔断 → 「监督不起作用」）。
      const starvedMs = queue.length > 0 ? Date.now() - queue[0].since : 0
      const starved = starvedMs > config.channelMaxWaitMs
      if (!opts.fromQueue && queue.length > 0) {
        if (!starved) { parkDelivery(pair, tag, target, text, 'queue-ahead', { ahead: queue.map((row) => row.tag) }, opts.hint); return undefined }
        // 队列头饿得太久：先把它强行投出去（当前这条继续排队），监督不能永远不动
        const head = queue.shift()
        recordReport('delivery-forced', pair, { tag: head.tag, sessionId: head.sessionId, waitedMs: starvedMs, others: channelOthers(pair).length })
        warn(`forcing queued ${head.tag} delivery (${pair.id}) after ${Math.round(starvedMs / 1000)}s`)
        serialDeliver(pair, head.tag, head.sessionId, head.text, { fromQueue: true, forced: true, hint: { since: head.since, tries: head.tries } }).catch((error) => warn('forced delivery failed', error))
        parkDelivery(pair, tag, target, text, 'queue-ahead', { ahead: ['<forced>'] }, opts.hint)
        return undefined
      }
      // v3.4 空闲闸门：同步判定，绝不在这条全局串行链里 await。
      const ok = pairIdle(pair)
      if (!ok) { parkDelivery(pair, tag, target, text, 'not-idle', {}, opts.hint); return undefined }
      // v3.4 全局单通道闸门：本地模型只有一个推理通道，别的会话在跑时插件绝不插队。
      // 判定改为【同步、立刻】：旧版在这里 await waitChannelFree(grace) —— 闸门把全局串行链
      // 按住 20s/条，19 个对一拥上来整条链就死了（客户看到「会话监督不起作用」）。
      if (config.channelGuard && !opts.forced) {
        const others = channelOthers(pair)
        if (others.length > 0) {
          pair.deferredByChannel = (pair.deferredByChannel ?? 0) + 1
          parkDelivery(pair, tag, target, text, 'channel-busy', { others: others.slice(0, 4), othersCount: others.length })
          return undefined
        }
      } else if (config.channelGuard && opts.forced) {
        const others = channelOthers(pair)
        if (others.length > 0) warn(`forcing ${tag} delivery (${pair.id}) despite ${others.length} other session(s) on the channel`)
      }
      const requestId = await deliver(target, tag, fitDelivery(pair, target, tag, text))
      // 排队材料的补发流水在【真送达】这一刻记。旧写法在取出时就记：一取出算一次「补发」，
      // 随后又被闸门退回队列 → 每 2.5s 刷一条 delivery-retry/deferred，journal 被刷爆（真机实测 30+ 条）。
      if (opts.queueRow) {
        recordReport(opts.forced ? 'delivery-forced' : 'delivery-retry', pair, {
          tag, sessionId: target, waitedMs: Date.now() - (opts.queueRow.since ?? Date.now()),
          tries: opts.queueRow.tries ?? 0, forced: !!opts.forced,
        })
      }
      // 评审材料落地的这一刻才起算评审时限（排队/通道等待的时间不计）
      if (tag === 'review') { pair.lastSupervisorHand = Date.now(); pair.reviewParkAt = 0 }
      // 入队投递的 requestId 只能在真送达时才知道（.then 里那次可能是「入队」而不是「送达」）
      if (tag === 'fix') pair.fixRequestId = requestId
      // 队里还有货：立刻接着投（别等下一个 2.5s 节拍），保持排队后进先出也准时。
      if ((pair.pendingDeliveries ?? []).length > 0) armDrain(pair, 300)
      await sleep(1500)
      return requestId
    }
    serialTail = serialTail.then(run, run)
    return serialTail
  }

  async function deliver(sessionId, tag, text) {
    const requestId = `sup:${tag}:${Date.now().toString(36)}:${(rpcSeq += 1)}`
    // sessionController's Remote facade builds the durable user-rpc source itself; 2nd arg is the caller signal.
    await ctx.sessionController.prompt({ sessionId, content: [{ type: 'text', text }], requestId }, AbortSignal.timeout(30000))
    return requestId
  }

  async function createSession(cwd) {
    const created = await ctx.sessionController.create(cwd ? { cwd } : {})
    createSessionFailures = 0
    if (cwd) {
      try {
        const workspace = await ctx.workspaceRegistry.resolveByPath(cwd)
        if (workspace && !workspace.sessionIds?.includes(created.sessionId)) await workspace.attachSession(created.sessionId)
      } catch (error) { warn(`workspace attach failed for ${created.sessionId}`, error) }
    }
    return created.sessionId
  }

  function setTitle(sessionId, title) {
    try {
      const titles = ctx.get('sessionTitle')
      const session = ctx.sessions.get(sessionId)
      if (titles && session) titles.rename(session, title)
    } catch (error) { warn(`title rename failed for ${sessionId}`, error) }
  }

  // ---------------------------------------------------------------- role cards

  const workerCard = (pair) => [
    `【会话监督·角色卡】你是监督对 ${pair.id}「${pair.name}」中的执行会话。另有一个监督会话在你全部完成后评审你的工作。`,
    '纪律：',
    '1. 按客户输入正常干活；中间轮次、单个步骤完成时【不要】惊动监督，也不要反复自查。',
    `2. 只有当客户需求【全部】做完并实际验证后，调用一次 supervision_done（附完成摘要与真实命令输出证据）；插件会串行排队通知监督评审，之后你保持空闲等待结论。`,
    `3. 监督判定 needs_fix 时，插件会自动把修复指令发回本会话；修完验证完再调用一次 supervision_done（最多 ${config.maxFixRounds} 轮，超限自动熔断等待人工）。`,
    `4. 禁止调用 supervision_start / supervision_enroll 制造新监督对；你的任务归本监督对管辖。`,
    `5. 上下文约定：本执行会话${sidePressureLine(pair, 'worker')}，达线插件自动把你接力到新的执行会话（交接卡自包含，本会话同时停止运行），你无需整理上下文；若 provider 先拒了请求（上下文溢出），插件会立刻紧急接力，任务不会丢。本监督对始终只有你一个活体执行会话，监督会话也只有一个。`,
    `5b. 省力约定：不要把大段日志/文件原文贴进回复（工具输出本身已在会话上下文里，再贴一遍等于双倍烧）；引用请写路径 + 关键行。`,
    `6. 【禁止假完成】supervision_done 之前必须自己先跑一遍验收（读文件/跑命令/请求 API/开页面），摘要里贴真实输出；做不到的项直接写明「未做+原因」，谎报会被监督逐项复核驳回并进入整改轮。`,
    `7. 【必须上报】本轮任务做完但不调 supervision_done，监督永远不会启动：插件会在你空闲 ${Math.round(config.idleNudgeMs / 1000)}s 后提醒你上报，${Math.round(config.idleForceReviewMs / 1000)}s 内仍不上报就强制送监督评审（届时你的工作会被判为「未自证完成」）。`,
    pair.auto
      ? `8. 本对由客户首条消息中的「审查触发词」自动建立：客户没有单独给验收清单，监督会按原始需求逐条拆解核验，请按需求条目完成并自证。`
      : '',
  ].filter(Boolean).join('\n')

  const supervisorCard = (pair) => [
    '【会话监督·角色卡】你是监督会话，只负责评审，绝不亲自写代码或执行任务。',
    `监督对：${pair.id}「${pair.name}」`,
    `执行会话 sessionId：${pair.workerId}`,
    '评审时机（重要）：执行会话【全部完成】并调用 supervision_done 后，插件才会把评审材料发来；中间步骤不会触发评审，你也不要在等待期间反复查询。',
    `串行约定：本地模型一次只跑一个会话。你给出结论（调用 supervision_verdict）并结束本轮后，插件才会把整改指令串行发回执行会话。`,
    '客户原始需求：\n' + capMiddle(pair.requirement, config.requirementMaxChars, '原始需求'),
    '评审协议：',
    '1. 收到 [监督评审] 消息时，结合内嵌的执行日志摘录判断完成情况；需要更多上下文用 supervision_worker_log。',
    '2. 评审对象必须是【交付物本身与运行时证据】，不是执行会话的自述：验收清单逐项由你亲自复现（读文件、跑命令、请求 API、查注册）；凡日志里说成功而你无法复核、或复核不过的，一律 needs_fix。',
    '3. 评审材料里的【硬故障证据】（浏览器上报错误/客户直接反馈）是无条件 bug：只要存在未解决记录，禁止 complete。',
    '4. 【反假完成·硬门槛】supervision_verdict 必须带 checklist：把需求/验收清单拆成条目，每条给你【亲自执行过的】核验命令或路径与核验结果（verified: done/failed/unverified + evidence）。',
     '   - 证据必须是你自己跑出来的（命令输出、文件真实内容与行数、HTTP 状态码、页面截图路径），不是执行会话的原话；照抄对方摘要 = 该条未核验。',
    `   - 【长度纪律】每条 evidence ≤ 200 字：写「命令 + 最关键的一行输出」，不要贴整段日志/整个文件/整个 diff；summary ≤ ${config.fixSummaryMaxChars} 字。监督会话的上下文比执行会话更容易炸，一炸整对就停摆（插件会裁掉超长内容，但请你本来就写短）。`,
    `   - 插件会校验：complete 时缺 checklist、有条目未核验或没有证据、summary 少于 ${config.completeSummaryMinChars} 字、上一轮整改项没有对应结论 —— 都会被直接打回，本轮评审作废。`,
    '5. 每条核验要么 done 附证据，要么 failed/unverified 并写清怎么复现的失败；只要有一条不是 done，结论只能是 needs_fix。',
    '6. 每轮评审必须调用一次 supervision_verdict 收尾，这是你的唯一结论渠道：',
    '   - complete：需求全部满足且有验证证据；summary 写验收依据。',
    '   - needs_fix：存在 bug/未完成/验证缺失；summary 写症状，fixInstructions 写给执行会话的具体修复指令（逐条对应 checklist 里失败的项）。',
    '7. 客户中途补充要求（[新客户要求] 标注）属正常输入，并入验收范围；除此以外执行会话的自查轮询不算 bug。',
    `8. 验收清单与浏览器/客户上报错误的来源：客户随时可经 UI 面板「反馈给客户/评审」或监督对补充要求，插件自动注入评审——你不需要等执行会话转述。`,
    '9. 允许的调用只有：supervision_verdict、supervision_worker_log、supervision_status。禁止 supervision_start / supervision_enroll / supervision_done（那是执行会话的上报渠道）。',
    pair.auto
      ? `10. 本对由客户首条消息中的「审查触发词」自动建立：请把原始需求按语义拆成验收条目（宁细勿粗），逐条核验后再给结论。`
      : '',
  ].filter(Boolean).join('\n')

  const handoverCard = (pair, side, summaryText, opts = {}) => [
    `【接力交接】监督对 ${pair.id}「${pair.name}」。${opts.reason ?? '上下文水位到达接力阈值'}，插件开启本会话接替上一${side === 'worker' ? '执行' : '监督'}会话（旧会话改名「已接力」保留追溯，其内容不必读取，以下材料已自包含）。`,
    opts.pressure ? `旧会话交接时水位：${pressureText(opts.pressure)}（这就是插件判断「该换会话」的依据）。` : '',
    '串行约定：本地模型一次只跑一个会话，插件按队列自动协调双方，你只需完成自己这一轮并正常结束。',
    side === 'worker'
      ? '你的职责：继续完成客户需求。先核对现场文件再动手，避免重做已完成部分；全部完成并验证后调用 supervision_done（附真实输出证据）；不上报监督永远不会启动。禁止调用 supervision_start / supervision_enroll。'
      : '你的职责：接替监督评审。只评审不执行；只有执行会话全部完成（supervision_done）后插件才会送评审材料，每轮评审必须以 supervision_verdict（带逐项 checklist 与亲自核验证据）收尾。禁止调用 supervision_start / supervision_enroll / supervision_done。',
    '——— 交接材料 ———',
    `原始需求：\n${capMiddle(pair.requirement, config.requirementMaxChars, '原始需求')}`,
    `对账状态：已评审 ${pair.reviews} 轮，自动修复 ${pair.fixRounds}/${config.maxFixRounds} 轮，上一次结论 ${pair.lastVerdict ?? '（无）'}${pair.lastSummary ? `\n上次结论摘要：${snippet(pair.lastSummary, 1200)}` : ''}`,
    side === 'worker' && pair.lastDoneSummary ? `上次完成上报摘要：${snippet(pair.lastDoneSummary, 800)}` : '',
    side === 'worker' ? `工作目录：${pair.cwd ?? '（默认）'}` : `执行会话 sessionId：${pair.workerId}`,
    '——— 最近执行日志摘录 ———',
    summaryText,
  ].filter(Boolean).join('\n')

  // ------------------------------------------------------ context split (1.2.4)
  // 客户要求：上下文超过【客户设置的窗口大小】（512K / 1M）时，自动把超出的部分拆成
  // 有序分段，按顺序逐段完成（每段一个新执行会话，绝不硬撑一个会话）。
  const splitItemLine = (text) => String(text ?? '').replace(/^\s*(?:[-*·]|\d+[.)、])\s*/, '').trim()

  /** 把「还没做完的活」按优先级收成有序条目：整改项 → 核验缺口 → 验收清单 → 整段需求。 */
  function splitItems(pair) {
    const items = []
    const push = (text, source) => { const line = splitItemLine(text); if (line) items.push({ text: line, source }) }
    if (pair.lastVerdict === 'needs_fix') {
      for (const line of String(pair.lastFixInstructions ?? '').split(/\r?\n/)) if (line.trim()) push(line, 'fix')
    }
    for (const row of checklistRows(pair.lastChecklist)) {
      if (String(row?.verified ?? '') !== 'done') push(`${row?.item ?? ''}（证据缺口：${snippet(row?.evidence ?? '未提供', 160)}）`, 'checklist')
    }
    if (items.length === 0) {
      const source = pair.currentRequirement || pair.requirement || ''
      const lines = String(source).split(/\r?\n/).map((line) => splitItemLine(line)).filter(Boolean)
      for (const line of lines) push(line, 'requirement')
    }
    if (items.length === 0) push(`完成需求：${snippet(pair.requirement ?? '（需求为空）', 400)}`, 'requirement')
    return items
  }

  /** 每段的字数预算：按客户设定的大小折算（≈2.4 字/token，留出卡头/证据/回复的余量）。 */
  function splitBudget(tokens) {
    if (config.contextSplitPartChars > 0) return config.contextSplitPartChars
    const capacity = (tokens ?? config.contextSplitTokens) || config.maxContextTokens
    return Math.max(600, Math.floor(capacity * 2.4))
  }

  /** 阈值展示：小于 1k 别显示成「0k」（dry-run 传 400 这种小预算时会出现）。 */
  const tokenLabel = (n) => (typeof n === 'number' && n > 0 && n < 1000 ? `${n} tok` : kTokens(n))

  /** 生成分段计划（纯函数，dry-run 也用它）：parts[0] 是第 1 段。 */
  function planSplit(pair, pressure, tokenBudget) {
    const items = splitItems(pair)
    const limit = tokenBudget ?? (config.contextSplitTokens || limitFor(pressure?.window))
    const budget = splitBudget(limit)
    const parts = []
    let current = []
    let size = 0
    for (const item of items) {
      const cost = item.text.length + 24
      if (current.length > 0 && size + cost > budget) { parts.push(current); current = []; size = 0 }
      current.push(item); size += cost
    }
    if (current.length) parts.push(current)
    // 段数封顶：太碎反而更慢，尾部并成最后一段（宁少不多）
    if (parts.length > config.contextSplitMaxParts) {
      const head = parts.slice(0, config.contextSplitMaxParts - 1)
      const tail = parts.slice(config.contextSplitMaxParts - 1).flat()
      head.push(tail)
      return { parts: head, items, budget, limit, tokens: pressure?.tokens ?? null, index: 1, planAt: Date.now() }
    }
    return { parts, items, budget, limit, tokens: pressure?.tokens ?? null, index: 1, planAt: Date.now() }
  }

  /** 第 k/N 段的自包含卡片：本段只做这几项，前段结果不重做，做完立刻上报。 */
  function splitCard(pair, plan, partIndex, opts = {}) {
    const part = plan.parts[partIndex - 1] ?? []
    const total = plan.parts.length
    const done = plan.parts.slice(0, partIndex - 1).flat()
    return [
      `【分段接力 · 第 ${partIndex}/${total} 段】监督对 ${pair.id}「${pair.name}」：上一段会话已到上下文上限（${opts.reason ?? '超过客户设置的窗口大小'}），插件把剩余的活拆成 ${total} 段按顺序做，本会话只做第 ${partIndex} 段。`,
      opts.pressure ? `旧会话交接时水位：${pressureText(opts.pressure)}（分段阈值 ${tokenLabel(plan.limit)}）。` : '',
      `原始需求（自包含，不必去读旧会话）：\n${capMiddle(pair.requirement, config.requirementMaxChars, '原始需求')}`,
      done.length ? `前面 ${partIndex - 1} 段已完成，不要重做：\n${done.map((item) => `- ${snippet(item.text, 200)}`).join('\n')}` : '',
      `【本段只做这 ${part.length} 项（按顺序做，逐项自证）】\n${part.map((item, i) => `${i + 1}. ${snippet(item.text, 600)}`).join('\n')}`,
      partIndex < total
        ? `本段做完立刻调用 supervision_done（摘要写清本段做了什么 + 真实命令输出）。插件会把第 ${partIndex + 1}/${total} 段发到新会话继续；不要提前做后面的段，也不要重做前面的段。`
        : '这是最后一段。做完并自证后调用 supervision_done，插件随即送监督评审。',
      `工作目录：${pair.cwd ?? '（默认）'}；禁止调用 supervision_start / supervision_enroll。`,
      '串行约定：本地模型一次只跑一个会话，你只需完成本段并正常结束。',
    ].filter(Boolean).join('\n')
  }

  /** 段与段之间的推进：本段上报 → 起新会话投下一段（间隔给上一段收尾，不让两段抢通道）。 */
  function scheduleSplitPart(pair, delay = 800) {
    schedule(() => {
      if (pair.state !== 'active') return
      handoverIfNeeded(pair, 'worker', { force: true, split: true, reason: `分段接力（第 ${pair.splitPlan?.index ?? '?'} 段续接）` })
        .catch((error) => warn('split part dispatch failed', error))
    }, delay)
  }

  // ---------------------------------------------------------------- rollover

  function halt(pair, reason) {
    if (pair.state !== 'active') return
    pair.state = 'halted'
    pair.phase = 'halted'
    pair.busy = false
    recordReport('halted', pair, { reason })
    recordPairing(pair, { action: 'halted', reason: snippet(reason, 300) })
    stopPairSides(pair, `熔断：${snippet(reason, 120)}`)
    pushError(pair, `熔断：${reason}`)
    serialDeliver(pair, 'notice', pair.workerId, `【监督熔断】${reason}。自动流程已停止，等待客户/人工输入。`).catch(() => {})
    warn(`pair ${pair.id} halted: ${reason}`)
  }

  const retiredNoticeAt = new Map()
  /** 退休一侧会话：标记 retired + 取消在跑的这一轮（老会话停止运行），并把结果写进 journal 可审计。 */
  async function stopRetiredSide(pair, role, previousId, reason) {
    markRetired(previousId, pair, role)
    let stopped = false
    if (config.stopRetiredSession) stopped = await stopSessionRun(previousId, reason)
    else warn("stop retired session skipped by config: " + previousId)
    recordPairing(pair, { action: "stop-retired-session", role, sessionId: previousId, stopped, reason: snippet(reason, 120) })
    if (!stopped) warn("retired " + role + " session NOT stopped: " + previousId + " (pair " + pair.id + ")")
    else warn("retired " + role + " session stopped: " + previousId + " (pair " + pair.id + ")")
    return stopped
  }

  async function handoverIfNeeded(pair, side, opts = {}) {
    if (pair.state !== "active") return false
    const role = side === "worker" ? "worker" : "supervisor"
    const previousId = role === "worker" ? pair.workerId : pair.supervisorId
    const pressure = pressureOf(previousId)
    // force：上下文溢出后的紧急接力。provider 已经把这个会话的请求拒了，继续留在旧会话
    // 里必然什么都做不了（DSH 自带压缩也会撞同一个 400），只能换会话。
    if (!opts.force && (pressure.tokens === undefined || !pressure.over)) return false
    pair.rolling = pair.rolling ?? new Set()
    if (pair.rolling.has(role)) { warn("handover already in flight (" + pair.id + " " + role + ")"); return false }
    if (pair.handovers >= config.maxHandovers) {
      halt(pair, `上下文接力次数达到上限（${config.maxHandovers} 次），${role === 'worker' ? '执行' : '监督'}侧 ${pressureText(pressure)}仍未回落。请人工清理该会话，或调大 maxContextTokens / contextReserveTokens。`)
      return false
    }
    pair.rolling.add(role)
    const number = (handoverSeq += 1)
    try {
      let newId
      try {
        newId = await createSession(pair.cwd ?? undefined)
      } catch (error) {
        createSessionFailures += 1
        warn("handover create failed (" + pair.id + " " + role + ")", error)
        pushError(pair, "接力新会话创建失败 " + snippet(error?.message ?? error, 160))
        if (createSessionFailures >= 3) halt(pair, "连续创建接力会话失败，自动流程停止（避免重复开会话）")
        return false
      }
      createSessionFailures = 0
      // 竞态保护：创建期间本侧已被另一处接力换掉 -> 丢掉刚多开的会话，绝不叠加
      const currentId = role === "worker" ? pair.workerId : pair.supervisorId
      if (currentId !== previousId || retired.has(newId)) {
        recordPairing(pair, { action: "drop-extra-session", role, kept: currentId, dropped: newId, reason: "racing-handover" })
        stopSessionRun(newId, "duplicate rollover guard").catch(() => {})
        return false
      }
      const previousEvents = role === "worker" ? await workerEvents(pair) : []
      const tail = capMiddle(
        digestLinesOf(previousEvents).slice(-config.handoverTailLines).join("\n"),
        Math.floor(config.handoverMaxChars * 0.55),
        "交接摘录",
      )
      pair.handovers += 1
      // v1.2.4 分段：执行侧换会话时，如果客户设了 contextSplitTokens（512K/1M），
      // 交接卡就不再是「整段活 + 摘录」，而是【第 k/N 段】——只做本段，做完上报换下一段。
      // 已有计划（段间续接）就沿用它的 index，绝不重新从第 1 段开始。
      let split = null
      if (role === 'worker' && config.contextSplitTokens > 0) {
        split = pair.splitPlan && pair.splitPlan.index <= pair.splitPlan.parts.length ? pair.splitPlan : planSplit(pair, pressure)
        if (split.parts.length <= 1) split = null            // 只剩一段＝没什么可拆，退回普通接力
        else pair.splitPlan = split
      }
      if (split) {
        recordReport('context-split', pair, {
          action: 'part-start', part: split.index, total: split.parts.length,
          tokens: pressure.tokens ?? null, limit: split.limit, budget: split.budget,
          reason: opts.reason ?? '超过客户设置的上下文大小',
          items: split.parts[split.index - 1]?.map((item) => snippet(item.text, 160)) ?? [],
        })
      }
      const lineageRow = { side: role, number, previousId, newId, at: Date.now(), stopped: false }
      pair.lineage.push(lineageRow)
      recordReport("handover", pair, {
        side: role, number, previousId, newId,
        reason: opts.reason ?? "水位达线",
        tokens: pressure.tokens ?? null, limit: pressure.limit, window: pressure.window ?? null, source: pressure.source,
      })
      if (role === "worker") {
        byWorker.delete(previousId)
        pair.workerId = newId
        pair.cursor = 0
        byWorker.set(newId, pair)
        setTitle(newId, "执行#" + number + "｜" + pair.name)
      } else {
        bySupervisor.delete(previousId)
        pair.supervisorId = newId
        bySupervisor.set(newId, pair)
        pair.lastSupervisorHand = Date.now()
        setTitle(newId, "监督#" + number + "｜" + pair.name)
      }
      bindSession(newId, pair, role)
      lineageRow.stopped = await stopRetiredSide(pair, role, previousId, "上下文接力：旧会话停止运行")
      setTitle(previousId, (role === "worker" ? "执行#" : "监督#") + number + "（已接力）｜" + pair.name)
      pair.lastHandoverAt = Date.now()
      if (role === "worker") pair.lastWorkerHandoverAt = pair.lastHandoverAt
      else pair.lastSupervisorHandoverAt = pair.lastHandoverAt
      const cardText = split
        ? splitCard(pair, split, split.index, { previousId, pressure, reason: opts.reason ?? '超过客户设置的上下文大小' })
        : handoverCard(pair, role, tail || "（无摘录）", { reason: opts.reason ?? "上下文水位到达接力阈值", pressure })
      const delivered = await serialDeliver(pair, "handover", newId, cardText)
      if (split) warn(`split part ${split.index}/${split.parts.length} dispatched (${pair.id}) -> ${newId}`)
      if (!delivered) warn("handover card parked (" + pair.id + " " + role + ")；角色卡照样排队")
      // 接力会话同时补送完整角色卡（执行纪律 / 监督评审协议），否则新会话只有一张交接卡，
      // 拿不到「只能调 supervision_verdict / 完成后调 supervision_done」这类硬约束。
      // v3.4：不再「只有交接卡当场送达才补角色卡」—— 投递现在会入队（返回 undefined 而不是失败），
      // 旧写法等于把角色卡整个丢掉：新会话只拿到交接卡 → 不知道上报/结论的规矩（实测 T4b 挂死）。
      // FIFO 队列保证顺序：交接卡先、角色卡后，两条都不许丢。
      serialDeliver(pair, role === "worker" ? "worker-card" : "supervisor-card", newId, role === "worker" ? workerCard(pair) : supervisorCard(pair))
        .then((ok) => { if (!ok) warn("role card after handover parked (" + pair.id + " " + role + ")") })
        .catch((error) => warn("role card after handover failed (" + pair.id + " " + role + ")", error))
      warn("handover #" + number + " (" + role + ") " + previousId + " -> " + newId)
      return true
    } finally {
      pair.rolling.delete(role)
    }
  }

  /** 退休会话又被使用（客户手误 / 迟到的投递）：停掉运行 + 一次性告知去哪个会话继续。 */
  function onRetiredEvent(session, event) {
    const info = retired.get(session?.id)
    if (!info || event?.type !== "user/message") return false
    const pair = pairs.get(info.pairId)
    if (!pair) return false
    const requestId = String(event?.data?.source?.rpcId ?? "")
    if (requestId.startsWith("sup:retired")) return false
    const lastNotice = retiredNoticeAt.get(session.id)
    if (lastNotice && Date.now() - lastNotice < config.retiredNoticeMs) return true
    const liveId = info.role === "worker" ? pair.workerId : pair.supervisorId
    const roleText = info.role === "worker" ? "执行" : "监督"
    recordPairing(pair, { action: "retired-session-touched", role: info.role, sessionId: session.id, live: liveId, text: snippet(contentText(event?.data?.content, 200), 200) })
    warn("retired " + roleText + " session touched again: " + session.id + " (pair " + pair.id + ")")
    if (config.stopRetiredSession) {
      stopSessionRun(session.id, "retired session touched")
        .then((stopped) => {
          recordPairing(pair, { action: "stop-retired-session", role: info.role, sessionId: session.id, stopped, reason: "retired session touched" })
          if (!stopped) warn("retired " + roleText + " session still running (cancel failed): " + session.id)
        })
        .catch((error) => warn("stop retired session failed", error))
    }
    retiredNoticeAt.set(session.id, Date.now())
    serialDeliver(pair, "retired-notice", session.id, [
      "【会话监督】本会话是监督对 " + pair.id + " 的旧" + roleText + "会话，上下文达线后已接力并停止运行。",
      "客户请改到活体" + roleText + "会话继续：" + liveId + "（标题：" + roleText + "｜" + pair.name + "）。",
      "你只需要回复一句：请改到 " + liveId + " 继续本监督对的任务。不要执行任何任务内容。",
    ].join("\n")).catch((error) => warn("retired notice failed", error))
    return true
  }
  // ---------------------------------------------------------------- reviews

  function scheduleReview(pair, trigger, delay = 1500) {
    if (pair.state !== 'active' || !config.reviewEnabled) return
    pair.pendingTriggers = [...(pair.pendingTriggers ?? []), trigger].slice(-6)
    if (pair.reviewTimerOn) { pair.recheckAfterBusy = true; return }
    pair.reviewTimerOn = true
    schedule(() => {
      pair.reviewTimerOn = false
      runReview(pair).catch((error) => {
        pair.busy = false
        pushError(pair, `评审调度失败: ${error?.message ?? error}`)
        warn(`review failed (${pair.id})`, error)
      })
    }, delay)
  }

  async function runReview(pair) {
    if (pair.state !== 'active' || !config.reviewEnabled) return
    warn(`runReview enter (${pair.id}) busy=${pair.busy} timer=${pair.reviewTimerOn}`)
    if (pair.busy) { pair.recheckAfterBusy = true; return }
    if (pair.reviews >= config.maxReviews) {
      halt(pair, `评审轮次达到上限（${config.maxReviews} 轮），自动流程停止。请人工检查执行结果后继续。`)
      return
    }
    pair.busy = true
    pair.verdictSeen = false
    pair.nudges = 0
    pair.recheckAfterBusy = false
    pair.nudgeAt = 0
    pair.forcedReviewAt = 0
    const trigger = pair.pendingTriggers.map((item) => item.detail).join('; ')
    pair.pendingTriggers = []

    // Serial: measure / build / hand over only while both sessions are idle.
    // v3.3：只给短暂宽限（pairIdleGraceMs）；等不到空闲也继续往下走 —— 材料会在
    // serialDeliver 里入库排队，绝不会打断正在跑的轮，也不会占住任何东西。
    await waitPairIdle(pair, { defer: true, waitMs: config.pairIdleGraceMs })
    if (pair.state !== 'active') { pair.busy = false; return }

    // Digest FIRST from the current worker session, so a rollover never loses
    // the turn that triggered this review.
    const events = await workerEvents(pair)
    const digest = buildDigest(events, pair.cursor, config.digestMaxChars)
    pair.cursor = digest.maxSeq
    const reviewWorkerId = pair.workerId

    let handoverNote = ''
    if (await handoverIfNeeded(pair, 'worker')) handoverNote += `执行会话已接力至 ${pair.workerId}，本摘录来自旧执行会话 ${reviewWorkerId}。`
    if (pair.state !== 'active') { pair.busy = false; return }
    if (await handoverIfNeeded(pair, 'supervisor')) handoverNote += `监督会话已接力，交接卡已先行送达本会话。`
    if (pair.state !== 'active') { pair.busy = false; return }

    pair.reviews += 1
    pair.phase = 'reviewing'
    const errorNote = pair.recentErrors.length ? `近期错误（仅记录，未评审）：\n${pair.recentErrors.map((line) => `- ${line}`).join('\n')}` : ''
    pair.recentErrors = []
    const workerPressure = pressureOf(pair.workerId)
    const supervisorPressure = pressureOf(pair.supervisorId)
    const workerTokens = workerPressure.tokens
    const supervisorTokens = supervisorPressure.tokens
    pair.lastWorkerTokens = workerTokens
    pair.lastSupervisorTokens = supervisorTokens
    pair.lastWorkerPressure = workerPressure
    pair.lastSupervisorPressure = supervisorPressure
    // 未决浏览器错误（UI 崩溃这类日志外的故障由 client 上报回评审回路）
    let errorScanAt = pair.lastErrorScanAt
    const uiErrors = journal.events
      .filter((event) => (event.kind === 'client-error' || event.kind === 'user-review') && event.at > errorScanAt && (!event.pairId || event.pairId === pair.id))
      .slice(-6)
    pair.lastErrorScanAt = Date.now()
    const uiErrorNote = uiErrors.length
      ? `【硬故障证据·必须处理】未解决的上报错误（浏览器/客户直接反馈，属于必须评审的 bug，逐条在 verdict summary 回应）：\n${uiErrors.map((event) => `- [${new Date(event.at).toLocaleString()}] ${snippet(event.kind === 'user-review' ? event.data?.text : `${event.data?.message} @ ${event.data?.pageUrl || ''}\n${event.data?.stack || ''}`, 500)}`).join('\n')}`
      : ''
    const acceptanceText = capMiddle(pair.currentRequirement, config.requirementMaxChars, '验收标准')
    const acceptanceNote = pair.requirements.length > 1 || pair.currentRequirement.includes('【验收清单】')
      ? `验收标准（逐项实际复现核验：文件真实存在/命令输出一致/API 返回正常/页面可打开，跳过任何一项都判 needs_fix）：\n${acceptanceText}`
      : (pair.auto
        ? `原始需求（自动纳入监督：请先把它拆成可核验的验收条目，再逐条实际复现——文件真实存在/命令输出一致/API 返回正常/页面可打开；凡是复现不了或复现不过的都判 needs_fix）：\n${acceptanceText}`
        : '')
    const forcedNote = pair.forcedReviewAt
      ? `【强制送审】执行会话空闲后没有调用 supervision_done，插件按现有现场强制送审。请把「没有自证完成」本身当成一条未通过项，逐项复现交付物后给结论；不要接受任何口头完成声明。`
      : ''
    const previousFixNote = pair.lastVerdict === 'needs_fix' && pair.lastFixInstructions
      ? `【上一条整改 #${pair.lastFixRound ?? pair.fixRounds} 必须复查】\n症状：${snippet(pair.lastFixSummary, 800)}\n要求：${snippet(pair.lastFixInstructions, 1500)}\n上一轮核验记录：\n${capMiddle(checklistText(pair.lastChecklist) || '（无）', config.checklistNoteMaxChars, '上一轮核验记录')}（超出部分是裁掉的旧证据；本轮 checklist 只覆盖验收清单，不要重贴旧证据）\n本轮 checklist 必须逐条给出这些项的最新结论（item 文案保持一致，插件会据此校验覆盖率）。`
      : ''
    const checklistNote = [
      `【逐项核验硬门槛】supervision_verdict 必须带 checklist：每条 = {item, verified: done|failed|unverified, evidence}。`,
      `证据只能来自你自己执行的核验（命令+真实输出片段、文件路径+实际内容、HTTP 状态、截图/日志路径）；照抄执行会话的「已完成」= 该条 unverified。`,
      `complete 的前置条件：${config.completeSummaryMinChars} 字以上的结论 + checklist 全部 done 且都有证据；做不到的项只能 needs_fix（插件会打回不合格结论）。`,
      `【长度】每条 evidence ≤ 200 字（命令 + 最关键一行输出），summary ≤ ${config.fixSummaryMaxChars} 字；长材料写路径/文件引用，不要整段贴进结论。`,
    ].join('\n')
    const text = capMiddle([
      `[监督评审 #${pair.reviews}] 监督对 ${pair.id}「${pair.name}」`,
      `触发：${trigger || '人工触发评审'}`,
      `执行会话当前：${pair.workerRunning ? '运行中' : '空闲'}；累计自动修复 ${pair.fixRounds}/${config.maxFixRounds} 轮；评审预算 ${pair.reviews}/${config.maxReviews}。`,
      `上下文互审：执行侧 ${sidePressureLine(pair, 'worker')}，监督侧 ${sidePressureLine(pair, 'supervisor')}（${pair.handovers > 0 ? `已接力 ${pair.handovers} 次；` : ''}达阈值即自动接力到新会话，绝不硬撑）。`,
      handoverNote,
      forcedNote,
      acceptanceNote,
      previousFixNote,
      checklistNote,
      uiErrorNote,
      errorNote,
      '--- 执行日志摘录（自上次评审）---',
      digest.text || '（无新增记录）',
      '--- 摘录结束 ---',
      `请按角色卡协议评审（先自己跑核验，再下结论），并必须调用 supervision_verdict(pairId="${pair.id}") 给出 complete 或 needs_fix：complete 需要 checklist 逐项 verified=done 且每条附你亲自跑出的证据；needs_fix 必须填写 fixInstructions（逐条对应没过的项）。需要更早历史用 supervision_worker_log(pairId="${pair.id}")。不要自己执行任务，不要创建新监督对。`,
    ].filter(Boolean).join('\n'), config.reviewMaxChars, '评审材料')
    // 评审计时起点：等材料【真送达】才开表（下面 serialDeliver 返回 requestId 才算）。
    // 被排队/通道挡住的分钟绝不该算进「评审轮超时」，否则单通道下一慢就熔断。
    // 但排队本身也不能无限期吊着本轮（busy=true 会把这对锁死在 reviewing —— v3.4 补的
    // 「停车超时」兜底：材料停投超过 reviewTurnTimeoutMs 未送达 → 收口 + 计一次超时）。
    pair.lastSupervisorHand = 0
    pair.supervisorLastEventAt = 0
    pair.supervisorIdleSince = 0
    pair.reviewParkAt = Date.now()
    pair.reviewRequestId = await serialDeliver(pair, 'review', pair.supervisorId, text)
    if (pair.reviewRequestId) pair.lastSupervisorHand = Date.now()
    else warn(`review #${pair.reviews} material parked (${pair.id}); review clock not started; 停车超时 ${Math.round(config.reviewTurnTimeoutMs / 60000)} 分钟兜底`)
    recordReport('review', pair, {
      review: pair.reviews, delivered: !!pair.reviewRequestId, trigger, digestChars: (digest.text || '').length, reviewChars: text.length,
      workerId: pair.workerId, supervisorId: pair.supervisorId,
      workerTokens: workerTokens ?? null, supervisorTokens: supervisorTokens ?? null,
      workerSource: workerPressure.source, supervisorSource: supervisorPressure.source,
      workerLimit: workerPressure.limit, supervisorLimit: supervisorPressure.limit,
      window: workerPressure.window ?? supervisorPressure.window ?? null,
    })
  }

  function releaseReview(pair) {
    pair.busy = false
    pair.reviewParkAt = 0
    // v3.4：只有「本轮真给出了结论」才清零连续超时计数。旧版在投递评审材料时清零，
    // 等于把「连续超时」永久重置，熔断永远触发不了 —— 卡死的对就一直挂着不动。
    if (pair.verdictSeen) pair.reviewTimeoutCount = 0
    if (pair.recheckAfterBusy) { pair.recheckAfterBusy = false; scheduleReview(pair, { detail: '评审期间执行会话又有新的完成上报' }, 600) }
  }

  function pushError(pair, line) {
    pair.recentErrors = [...pair.recentErrors, snippet(line, 300)].slice(-8)
  }

  function noteModelError(pair) {
    pair.consecutiveErrors += 1
    if (pair.consecutiveErrors >= 3) halt(pair, `连续 ${pair.consecutiveErrors} 次模型错误（本地模型可能断联），自动流程停止，恢复后人工继续`)
  }

  /**
   * 溢出错误专用回路（v3.1）。provider 已经拒绝请求（CONTEXT_WINDOW_EXCEEDED）时，
   * 这个会话连同它自己的压缩都救不回来 —— 唯一有效的动作是立刻换会话接着干，
   * 而不是把它当成「模型掉线」计入错误预算然后熔断（11-15 事故就是这么把监督对判死的）。
   */
  function relayOnOverflow(pair, role, detail) {
    pair.overflowAt = Date.now()
    pair.overflowCount = (pair.overflowCount ?? 0) + 1
    // provider 在错误里把真实窗口报给我们（本机路由声明的是 1M，实际只吃到 524288）。
    // 记下它：这一侧后续阈值立刻按真实窗口收紧，不再信宿主公开的 contextWindow。
    const ceiling = parseWindowCeiling(detail)
    if (ceiling) {
      const sessionId = role === 'worker' ? pair.workerId : pair.supervisorId
      const previous = observedCeilings.get(sessionId)
      observedCeilings.set(sessionId, previous ? Math.min(previous, ceiling) : ceiling)
      pair.observedWindow = Math.min(pair.observedWindow ?? Infinity, ceiling)
    }
    pushError(pair, `上下文溢出（${role === 'worker' ? '执行' : '监督'}侧第 ${pair.overflowCount} 次）：${snippet(detail, 200)}`)
    recordReport('overflow', pair, {
      role,
      sessionId: role === 'worker' ? pair.workerId : pair.supervisorId,
      detail: snippet(detail, 300),
      handovers: pair.handovers,
      observedCeiling: ceiling ?? null,
      limit: pressureOf(role === 'worker' ? pair.workerId : pair.supervisorId).limit,
      pressure: { worker: pair.lastWorkerTokens ?? null, supervisor: pair.lastSupervisorTokens ?? null },
    })
    warn(`context overflow on ${role} side (${pair.id}); forcing handover instead of halting${ceiling ? ` (ceiling ${kTokens(ceiling)})` : ''}`)
    // 评审轮被溢出打断：先解锁，否则 busy 会把新会话的评审永远卡住。
    if (role === 'supervisor' && pair.busy) { pair.busy = false; pair.verdictSeen = false }
    if (!config.overflowRelay) { noteModelError(pair); return }
    handoverIfNeeded(pair, role, { force: true, reason: `上下文溢出（provider 拒绝：${snippet(detail, 120)}）` })
      .then((ok) => {
        if (!ok) {
          // 接力本身做不了（接力上限 / 建会话失败）才按老逻辑计入错误预算。
          warn(`overflow relay produced no new session (${pair.id} ${role}); counting as model error`)
          noteModelError(pair)
          return
        }
        // 真实窗口上限跟着搬到新会话：上限属于这条路由，不属于某个会话。
        if (ceiling) {
          const newId = role === 'worker' ? pair.workerId : pair.supervisorId
          const previous = observedCeilings.get(newId)
          observedCeilings.set(newId, previous ? Math.min(previous, ceiling) : ceiling)
        }
        const other = role === 'worker' ? pair.supervisorId : pair.workerId
        if (ceiling && other) {
          const previous = observedCeilings.get(other)
          observedCeilings.set(other, previous ? Math.min(previous, ceiling) : ceiling)
        }
      })
      .catch((error) => { warn('overflow relay failed', error); noteModelError(pair) })
  }

  // ---------------------------------------------- 溢出自动续做（1.2.5）
  // 客户口径：长会话会报 `400 request exceeds the context window: prompt (524520 tokens)
  // leaves no room to answer in the context (524288); requests are never truncated`。
  // 那种会话**连自己的压缩都救不回来**（provider 直接拒绝），唯一出路是换一个新会话接着干。
  // 监督对里的两侧走 relayOnOverflow；这里管「散会话」（客户自己的长会话、没建对的会话）。
  const continuations = new Map()   // 旧 sessionId -> { newId, at, depth }；新会话也带 depth 以便限链

  /** 从会话事件里捞最后一次 todo 快照：续做卡靠它告诉新会话「还剩哪些没做」。 */
  function lastTodoSnapshot(events) {
    for (let i = (events?.length ?? 0) - 1; i >= 0; i -= 1) {
      const event = events[i]
      if (event?.type !== 'tool/call') continue
      if (!/todo/i.test(String(event.data?.name ?? ''))) continue
      let args = event.data?.arguments
      if (typeof args === 'string') { try { args = JSON.parse(args) } catch { args = null } }
      const rows = Array.isArray(args?.todos) ? args.todos : []
      if (!rows.length) continue
      return {
        pending: rows.filter((row) => row && row.status !== 'completed').map((row) => String(row.content ?? row.item ?? '')).filter(Boolean),
        done: rows.filter((row) => row && row.status === 'completed').map((row) => String(row.content ?? row.item ?? '')).filter(Boolean),
      }
    }
    return null
  }

  async function eventsOfSession(sessionId) {
    try {
      const live = ctx.sessions.get(sessionId)
      if (live && Array.isArray(live.events)) return live.events
    } catch {}
    try {
      const snapshot = await ctx.sessionQuery.readSession(sessionId)
      return snapshot?.events ?? []
    } catch { return [] }
  }

  function continueCard(session, detail, ceiling, events) {
    const todo = lastTodoSnapshot(events)
    const tail = digestLinesOf(events).slice(-config.handoverTailLines)
    return capMiddle([
      `【溢出接力 · 自动续做】上一个会话 \`${session?.id}\` 因为上下文超过模型窗口被 provider 直接拒绝，已经无法再继续：`,
      `  ${snippet(detail, 400)}`,
      ceiling ? `（provider 报的真实窗口：${ceiling} tokens；本会话的水位阈值已按这个数字收紧）` : '',
      '插件已开本会话接替它。**任务没变：接着把没做完的做完**，不要从头重做已完成的部分。',
      todo?.pending?.length ? `原会话还没做完的待办（照这个顺序继续）：\n${todo.pending.map((t, i) => `${i + 1}. ${snippet(t, 200)}`).join('\n')}` : '',
      todo?.done?.length ? `原会话已完成（不要重做）：\n${todo.done.map((t) => `- ${snippet(t, 160)}`).join('\n')}` : '',
      tail.length ? '——— 原会话最后一段执行摘录 ———' : '',
      ...tail,
      '——— 摘录结束 ———',
      `工作目录：${session?.cwd ?? '（沿用原会话）'}。`,
      '规矩：先核对现场（文件/进程/日志/接口）再动手；做不完的项如实写「未做 + 原因」，不要谎报完成。',
    ].filter(Boolean).join('\n'), config.continueCardMaxChars, '溢出续做卡')
  }

  /**
   * 散会话溢出 → 自动开新会话接着做。
   * 防炸：只认 session-* 真会话（mnemon-run-* 等一次性会话不续）、监督对内的交给 relayOnOverflow、
   * 同一会话一个冷却窗口内只续一次、整条续做链有上限（overflowContinueMax）。
   */
  async function continueSession(session, detail) {
    if (!config.overflowContinue) return false
    const id = session?.id
    if (!id) return false
    if (!/^session-/.test(String(id))) return false
    if (byWorker.has(id) || bySupervisor.has(id)) return false
    if (retired.has(id)) return false
    const known = continuations.get(id)
    if (known && Date.now() - known.at < config.overflowContinueCooldownMs) return false
    const depth = (known?.depth ?? 0) + 1
    if (depth > config.overflowContinueMax) {
      recordReport('continuation-blocked', null, { sessionId: id, depth, reason: `自动续做达到上限（${config.overflowContinueMax} 次），可能一直在溢出` })
      warn(`overflow continuation blocked (${id}) after ${depth - 1} hops`)
      return false
    }
    const ceiling = parseWindowCeiling(detail)
    const events = await eventsOfSession(id)
    let newId
    try {
      newId = await createSession(session?.cwd ?? undefined)
    } catch (error) {
      warn(`overflow continuation create failed (${id})`, error)
      recordReport('continuation-failed', null, { sessionId: id, reason: snippet(error?.message ?? error, 200) })
      return false
    }
    continuations.set(id, { newId, at: Date.now(), depth })
    continuations.set(newId, { newId: null, at: 0, depth })   // 新会话继承链深
    if (ceiling) observedCeilings.set(newId, ceiling)          // 真实窗口跟着搬到新会话
    const note = continueCard(session, detail, ceiling, events)
    const title = `续做#${depth}｜${snippet(String(session?.title ?? '') || id.slice(-8), 40)}`
    try { setTitle(newId, title) } catch {}
    recordReport('continuation', null, {
      sessionId: id, newId, depth, ceiling: ceiling ?? null,
      reason: snippet(detail, 300),
      todoPending: lastTodoSnapshot(events)?.pending?.length ?? 0,
    })
    // 新会话先拿到料（它还没跑，直接投），再停老会话：顺序反过来会先丢现场。
    try {
      await deliver(newId, 'continue', note)
    } catch (error) {
      warn(`overflow continuation delivery failed (${id} -> ${newId})`, error)
      recordReport('continuation-failed', null, { sessionId: id, newId, reason: snippet(error?.message ?? error, 200) })
    }
    setTitle(id, `（已溢出接力→${String(newId).slice(-8)}）${snippet(String(session?.title ?? ''), 30)}`)
    await stopSessionRun(id, '上下文溢出：provider 拒绝请求，已换新会话续做').catch(() => {})
    warn(`overflow continuation: ${id} -> ${newId} (depth ${depth}${ceiling ? `, ceiling ${ceiling}` : ''})`)
    return true
  }

  // ---------------------------------------------------------------- events

  // ---- v1.3.0 文本工具调用守卫 -------------------------------------------
  // 只认「正文里写了调用标记」= <tool_call> / <function=xxx>；结构化 tool-call 不会出现在 text 块里。
  const TEXT_CALL_RE = /<tool_call[\s>]|<function\s*=\s*[a-zA-Z_]/
  const textCallReminder = (role, attempts, max, escalate) => [
    `【工具调用写成了正文】你上一步把工具调用写成了正文（<tool_call> / <function=…>），DSH 只执行结构化 tool-call，这一轮没有任何工具被执行，任务实际上停在这一步。`,
    `本机 shell 工具名是 pwsh（不存在 exec 工具）：要跑命令就直接发 pwsh 的结构化 tool-call，把命令放进 command 参数；不要再写 <tool_call>/<function=…>/<parameter=…> 这类文本标记。`,
    escalate
      ? `这是第 ${attempts}/${max} 次纠正：不要再解释、不要复述计划，下一步必须立刻产生至少一个真实工具调用；若你认为任务已完成，就直接给出结论并列出已完成项。`
      : `（第 ${attempts}/${max} 次纠正）请立刻用真实工具调用把该做的动作重发一遍。`,
  ].join('\n')

  /**
   * 每来一个事件喂一次：assistant/message 认标记、tool/call 记本轮真实调用数、
   * turn/end 收口判定并注入纠正。串行走 serialDeliver，因此不会和监督轮抢通道。
   */
  function noteTextCall(pair, role, event) {
    if (!config.textToolCallGuard) return
    const side = ((pair.textCallSide ??= {})[role] ??= { pending: false, calls: 0, rounds: 0 })
    if (event?.type === 'assistant/message') {
      side.saw = true
      const blocks = event.data?.message?.content
      if (!Array.isArray(blocks)) return
      const text = blocks.filter((b) => b?.type === 'text').map((b) => String(b.text ?? '')).join('\n')
      if (text && TEXT_CALL_RE.test(text)) { side.pending = true; side.at = Date.now() }
      return
    }
    if (event?.type === 'tool/call') { side.saw = true; side.calls += 1; return }
    if (event?.type !== 'turn/end') return
    const flagged = side.pending === true
    const hadCalls = side.calls > 0
    const sawAnything = side.saw === true
    const round = event.data?.turn ?? null
    side.pending = false
    side.calls = 0
    side.saw = false
    // 空轮（既没有 assistant 消息也没有工具调用，例如只剩一条排队投递落地）不参与计数、也不清零
    if (!sawAnything && !hadCalls) return
    if (!flagged || hadCalls) { side.rounds = 0; return }  // 干净一轮（无标记，或真有工具执行）→ 预算回满
    side.rounds += 1
    if (side.rounds > config.textToolCallGuardMax) {
      recordReport('text-toolcall', pair, { role, round, attempts: side.rounds, action: 'give-up' })
      return
    }
    recordReport('text-toolcall', pair, { role, round, attempts: side.rounds, action: 'retry' })
    const sessionId = role === 'worker' ? pair.workerId : pair.supervisorId
    if (!sessionId) return
    serialDeliver(pair, 'text-toolcall', sessionId, textCallReminder(role, side.rounds, config.textToolCallGuardMax, side.rounds >= 2))
      .catch((error) => warn('text tool-call reminder failed', error))
  }

  function onWorkerEvent(pair, event) {
    if (pair.state !== 'active') return
    pair.lastActivity = Date.now()
    noteTextCall(pair, 'worker', event)
    if (event?.type === 'turn/end') {
      const reason = event.data?.reason ?? {}
      pair.lastTurnEndAt = Date.now()
      touchJournal(pair)
      if (reason.kind === 'error' && isOverflow(reason.error)) {
        relayOnOverflow(pair, 'worker', reason.error?.message ?? reason.error)
        return
      }
      // 上下文达线：不等上报，也在空闲点把执行会话接力到新会话（老会话随即停止运行）
      const pressure = pressureOf(pair.workerId)
      if (pressure.over && pairIdle(pair)) {
        handoverIfNeeded(pair, 'worker').catch((error) => warn('post-turn handover failed', error))
      }
      if (reason.kind === 'error') {
        // Record only: no review before supervision_done. A dead model repeated
        // enough times still deserves a halt.
        pushError(pair, `轮结束·错误 ${reason.error?.message ?? ''}`)
        noteModelError(pair)
      }
      return
    }
    if (event?.type === 'tool/call') {
      if (String(event.data?.name ?? '') === 'supervision_done') pair.reportPending = null
      return
    }
    if (event?.type === 'tool/result') {
      const error = toolResultError(event.data)
      if (error) pushError(pair, `工具失败 ${error.name ?? ''} ${error.code ?? ''} ${error.message ?? ''}`)
    }
  }

  function onSupervisorEvent(pair, event) {
    pair.supervisorLastEventAt = Date.now()
    noteTextCall(pair, 'supervisor', event)
    if (event?.type !== 'turn/end') return
    pair.supervisorIdleSince = Date.now()
    if (!pair.busy) return
    const reason = event.data?.reason ?? {}
    if (reason.kind === 'error' && !pair.verdictSeen) {
      if (isOverflow(reason.error)) {
        relayOnOverflow(pair, 'supervisor', reason.error?.message ?? reason.error)
        return
      }
      pushError(pair, `监督评审轮自身错误: ${reason.error?.message ?? ''}`)
      noteModelError(pair)
      return
    }
    if (pair.verdictSeen) { releaseReview(pair); return }
    if (pair.nudges < 1) {
      pair.nudges += 1
      serialDeliver(pair, 'nudge', pair.supervisorId, `[监督系统提示] 你在评审 #${pair.reviews} 结束前没有调用 supervision_verdict。请立即基于上面的评审材料调用 supervision_verdict(pairId="${pair.id}") 给出 complete/needs_fix 结论。`).catch((error) => warn('nudge failed', error))
      return
    }
    // Second time-up: the review round failed to conclude; keep it to at most one retry per review budget via runReview's own guard.
    scheduleReview(pair, { detail: '上一轮监督评审未给出结论，重新评审' }, 1500)
  }

  const enrollLog = (line) => {
    if (config.debugEnrollTrace !== true) return
    try { fs.appendFileSync(path.join(storeDir, 'auto-enroll.log'), `${new Date().toISOString()} ${line}\n`) } catch {}
  }

  ctx.on('session/event', function (session, event) {
    if (event?.type === 'user/message') {
      // 新会话首条消息里的「需要审查」→ 自动建对。必须脱出事件循坏：
      // 建对会同步创建会话并再发 session/event，重入会把宿主搞炸。
      const kind = event.data?.source?.kind ?? '?'
      const rpc = event.data?.source?.rpcId ?? '-'
      const bound = boundPairId(session?.id)
      if (bound) enrollLog(`event ${session?.id} already-in-pair=${bound} source=${kind} rpc=${rpc}`)
      else Promise.resolve().then(() => autoEnrollFromMessage(session, event.data, event.seq)).catch((error) => {
        enrollLog(`event ${session?.id} FAILED source=${kind} rpc=${rpc} ${error?.message ?? error}`)
        warn('auto enroll failed', error)
      })
    }
    if (retired.has(session?.id) && onRetiredEvent(session, event)) return
    let pair = byWorker.get(session?.id)
    if (pair) { onWorkerEvent(pair, event); return }
    pair = bySupervisor.get(session?.id)
    if (pair) { onSupervisorEvent(pair, event); return }
    // v1.2.5 散会话溢出（有的路由把溢出报在 turn/end 的 reason.error 里，不是 agent/error）
    if (event?.type === 'turn/end') {
      const reason = event.data?.reason ?? {}
      if (reason.kind === 'error' && isOverflow(reason.error)) {
        continueSession(session, reason.error?.message ?? reason.error).catch((error) => warn('overflow continuation failed', error))
      }
    }
  })

  ctx.on('agent/status', function (payload) {
    const running = payload?.status === 'running'
    // 全局单通道账本：本地模型只有一个推理通道，任何时刻只该有一个会话在跑。
    // 这里记录【全宿主】的活跃会话（不只本对），投递前用它排队（见 waitChannelFree）。
    const liveId = payload?.agent?.id
    if (liveId) {
      if (running) { if (!liveAgents.has(liveId)) liveAgents.set(liveId, { since: Date.now(), updatedAt: Date.now(), seenAt: Date.now() }); else liveAgents.get(liveId).updatedAt = Date.now() }
      else liveAgents.delete(liveId)
      // 通道刚空出来：所有压着排队投递的对立刻重试（这是「别人在干活 → 一干完就补发」的关键节拍）
      if (!running) for (const p of pairs.values()) if ((p.pendingDeliveries ?? []).length > 0) armDrain(p, 500)
    }
    const worker = byWorker.get(payload?.agent?.id)
    if (worker) {
      if (running && !worker.workerRunning) worker.workerRunningSince = Date.now()
      worker.workerRunning = running
      if (running) worker.lastActivity = Date.now()
      // 变空闲的那一刻是补发排队投递的最佳时机（看门狗要 15~20s 才扫一遍）
      if (!running && (worker.pendingDeliveries ?? []).length > 0) armDrain(worker, 200)
      return
    }
    const supervisor = bySupervisor.get(payload?.agent?.id)
    if (supervisor) {
      if (running && !supervisor.supervisorRunning) supervisor.supervisorRunningSince = Date.now()
      supervisor.supervisorRunning = running
      if (!running && (supervisor.pendingDeliveries ?? []).length > 0) armDrain(supervisor, 200)
    }
  })

  ctx.on('agent/error', function (payload) {
    const message = payload?.error?.message ?? payload?.error ?? ''
    const worker = byWorker.get(payload?.agent?.id)
    if (worker && worker.state === 'active') {
      pushError(worker, `agent/error turn=${payload.turn} step=${payload.step} ${message}`)
      if (isOverflow(payload?.error) || isOverflow(message)) { relayOnOverflow(worker, 'worker', message); return }
      noteModelError(worker)
      return
    }
    const supervisor = bySupervisor.get(payload?.agent?.id)
    if (supervisor && supervisor.state === 'active' && (isOverflow(payload?.error) || isOverflow(message))) {
      pushError(supervisor, `agent/error(监督侧) ${message}`)
      relayOnOverflow(supervisor, 'supervisor', message)
      return
    }
    // v1.2.5 散会话（没建对的客户会话）溢出：自动开新会话接着做未完成的活
    if (isOverflow(payload?.error) || isOverflow(message)) {
      const sessionId = payload?.agent?.id
      if (sessionId) {
        let session
        try { session = ctx.sessions.get(sessionId) } catch {}
        if (session) continueSession(session, message).catch((error) => warn('overflow continuation failed', error))
      }
    }
  })

  // Watchdog: unstick a hung review turn (single-slot model must not be held forever),
  // and make sure an executor that stops talking without reporting done still gets
  // reviewed: nudge once, then force a review after idleForceReviewMs.
  ctx.timer.interval(() => {
    const now = Date.now()
    watchdogAt = now
    // 每轮扫描顺带校正一次单通道账本（事件只覆盖加载之后的会话状态）
    syncChannelRoster().catch(() => {})
    for (const pair of pairs.values()) {
      if (pair.state !== 'active') continue
      // v3 空闲点接力：任一侧水位达线且双方都不在跑模型，就换会话（评审期间的接力在 runReview 内）
      if (config.reviewEnabled && !pair.busy && !pair.reviewTimerOn && pairIdle(pair)
        && (!pair.lastHandoverAt || now - pair.lastHandoverAt > config.rolloverCooldownMs)) {
        const workerPressure = pressureOf(pair.workerId)
        const supervisorPressure = pressureOf(pair.supervisorId)
        if (workerPressure.over || supervisorPressure.over) {
          handoverIfNeeded(pair, workerPressure.over ? 'worker' : 'supervisor')
            .catch((error) => warn('idle rollover failed', error))
        }
      }
      // 待重投队列（v3.3）：每轮最多补发一条，且不占用串行链；饿死超时就强行放行。
      drainPendingDeliveries(pair, now)
      // 评审计时（v3.3）：起点 = 材料送达，之后【监督侧任何进展】都刷新起点。
      // 旧口径（固定 15/30 分钟就砍）在本机是误杀：监督侧要在单通道排队 + 自己跑十几项
      // 服务端取证，一轮 30~40 分钟很正常（11-16 实测：连续 3 次超时把整对打成 halted，
      // 客户因此看到「会话监督不起作用」）。现在只有「完全没进展」才算卡死。
      const handAt = Math.max(pair.lastSupervisorHand || 0, pair.supervisorIdleSince || 0, pair.supervisorLastEventAt || 0)
      // 软超时：监督侧毫无进展超过 reviewTurnTimeoutMs；硬上限：从送达起超过 reviewHardCapMs 一定中止
      // （进展豁免只豁免「慢」，不豁免「永不收敛」）。
      const softOverdue = handAt > 0 && pair.supervisorRunning !== true && now - handAt > config.reviewTurnTimeoutMs
      const hardOverdue = pair.lastSupervisorHand > 0 && now - pair.lastSupervisorHand > config.reviewHardCapMs
      // 材料还压在待投队列里（没送达就不起评审计时）—— 但也不能永远压着：
      // v3.4 停车超时：压过 reviewTurnTimeoutMs 就当本轮「未通过」收口，否则 pair.busy 永不释放。
      const parkedOverdue = !pair.lastSupervisorHand && pair.reviewParkAt > 0 && now - pair.reviewParkAt > config.reviewTurnTimeoutMs
      if (config.reviewTurnTimeoutMs > 0 && pair.busy && (softOverdue || hardOverdue || parkedOverdue)) {
        const timedOutFrom = parkedOverdue ? pair.reviewParkAt : hardOverdue && !softOverdue ? pair.lastSupervisorHand : handAt
        const reason = parkedOverdue ? '评审材料停投' : hardOverdue ? '硬上限' : '无进展'
        pair.supervisorRunningSince = 0
        pair.reviewTimeoutCount = (pair.reviewTimeoutCount ?? 0) + 1
        const waitedMin = Math.round((now - timedOutFrom) / 60000)
        pushError(pair, `监督评审轮 ${waitedMin} 分钟未给结论（第 ${pair.reviewTimeoutCount}/${config.maxReviewTimeouts} 次，${reason}），插件已中止该轮并收口`)
        recordReport('review-timeout', pair, { review: pair.reviews, waitedMs: now - timedOutFrom, count: pair.reviewTimeoutCount, hard: hardOverdue, starved: parkedOverdue })
        if (parkedOverdue) {
          // 本轮材料作废：收口后再补投会让监督对着已过期的现场重评一遍
          const before = (pair.pendingDeliveries ?? []).length
          pair.pendingDeliveries = (pair.pendingDeliveries ?? []).filter((row) => row.tag !== 'review')
          if (before !== pair.pendingDeliveries.length) recordReport('delivery-dropped', pair, { tag: 'review', reason: '评审轮因材料停投超时收口' })
        }
        try { ctx.agents.get(pair.supervisorId)?.cancel({ kind: 'user', reason: 'session-supervisor review timeout' }) } catch (error) { warn('supervisor cancel failed', error) }
        // 关键（2026-11-15 事故根因）：超时只 cancel 不收口，pair.busy 就永远是 true，
        // runReview 的 `if (pair.busy) return` 会把之后每一次评审都挡在门外 —— 这对就整轮空转。
        pair.busy = false
        pair.verdictSeen = false
        pair.nudges = 0
        pair.forcedReviewAt = 0
        pair.phase = 'fixing'
        pair.reviewParkAt = 0
        if (pair.reviewTimeoutCount >= config.maxReviewTimeouts) {
          halt(pair, `评审连续 ${pair.reviewTimeoutCount} 次未在 ${Math.round(config.reviewTurnTimeoutMs / 60000)} 分钟内给出结论（监督侧模型延迟/上下文过大），自动流程停止：请人工检查监督会话后继续`)
        } else {
          serialDeliver(pair, 'notice', pair.workerId, [
            `【监督系统提示】监督评审 #${pair.reviews} 超过 ${Math.round(config.reviewTurnTimeoutMs / 60000)} 分钟没给结论，插件已中止该轮并按「未通过」处理（第 ${pair.reviewTimeoutCount}/${config.maxReviewTimeouts} 次）。`,
            '你要做的只有一件事：把当前进展与真实证据直接写进 supervision_done 摘要（做不完的项写明「未做 + 原因」），不要空等评审结论。',
          ].join('\n')).catch((error) => warn('review timeout notice failed', error))
          scheduleReview(pair, { detail: `上一轮评审超时被中止（第 ${pair.reviewTimeoutCount} 次），重新评审` }, 3000)
        }
      }
      // 执行侧单轮超时：旧版 workerRunning=true 时插件完全静默，客户看到的就是「几小时没动」。
      if (
        config.workerTurnTimeoutMs > 0 && pair.workerRunning && pair.workerRunningSince
        && now - pair.workerRunningSince > config.workerTurnTimeoutMs
      ) {
        pair.workerTimeoutCount = (pair.workerTimeoutCount ?? 0) + 1
        const ranMin = Math.round((now - pair.workerRunningSince) / 60000)
        pushError(pair, `执行会话单轮已跑 ${ranMin} 分钟未收口（第 ${pair.workerTimeoutCount}/${config.maxWorkerTimeouts} 次），插件已中止该轮`)
        recordReport('worker-timeout', pair, { turnMs: now - pair.workerRunningSince, count: pair.workerTimeoutCount, review: pair.reviews })
        try { ctx.agents.get(pair.workerId)?.cancel({ kind: 'user', reason: 'session-supervisor worker turn timeout' }) } catch (error) { warn('worker cancel failed', error) }
        pair.workerRunningSince = 0
        if (pair.workerTimeoutCount >= config.maxWorkerTimeouts) {
          halt(pair, `执行会话连续 ${pair.workerTimeoutCount} 次单轮超过 ${Math.round(config.workerTurnTimeoutMs / 60000)} 分钟仍未收口，自动流程停止：请人工确认它是否卡在无超时的命令上（ssh/长任务）`)
        } else {
          serialDeliver(pair, 'notice', pair.workerId, [
            `【监督系统提示】你这一轮已经连续跑了 ${ranMin} 分钟仍未结束，插件已中止本轮（第 ${pair.workerTimeoutCount}/${config.maxWorkerTimeouts} 次）。`,
            '接下来三条硬要求：',
            '1) 任何 `ssh`/长任务必须带超时（pwsh 用 `-TimeoutSec`，命令内 `curl -m`，别裸 ssh 等密码提示）；',
            '2) 先把已完成的部分落盘（脚本/日志/证据文件），别只在脑内推演；',
            '3) 立刻继续剩余工作，或直接调用 supervision_done 如实上报当前进展（做不完的项写「未做 + 原因」）。',
          ].join('\n')).catch((error) => warn('worker timeout notice failed', error))
        }
      }
      if (!config.reviewEnabled) continue
      // 上报兜底：执行侧自己停了（或收到了整改指令）但没调 supervision_done
      if (
        pair.cardDelivered && !pair.busy && pair.reportPending && pair.workerRunning === false
        && pair.lastTurnEndAt > (pair.reportAt ?? 0)
      ) {
        const idle = now - pair.lastTurnEndAt
        const forceAfter = config.idleForceReviewMs || config.idleNudgeMs * 3
        if (config.idleNudgeMs > 0 && !pair.nudgeAt && idle > config.idleNudgeMs) {
          pair.nudgeAt = now
          pushError(pair, `执行会话空闲 ${Math.round(idle / 1000)}s 未上报完成，插件已提醒其调用 supervision_done`)
          serialDeliver(pair, 'notice', pair.workerId, [
            `【监督系统提示】监督对 ${pair.id} 已经建立，但你本轮结束时没有调用 supervision_done，监督评审因此一直不会启动。`,
            '立即二选一：',
            '1) 全部任务确实做完并验证过 → 现在调用 supervision_done（摘要必须带你亲自跑出的真实输出证据，不得凭记忆或凭“应该没问题”）。',
            '2) 还有没做完的 → 现在就继续把剩余需求做完，再做完后调用 supervision_done。',
            `禁止只回复「已完成」而上报；${Math.round(forceAfter / 1000)}s 内仍不上报，插件会强制把当前现场送监督评审，届时会被判为未自证完成。`,
          ].join('\n')).catch((error) => warn('idle nudge failed', error))
        } else if (forceAfter > 0 && pair.nudgeAt && now - pair.nudgeAt > forceAfter) {
          pair.nudgeAt = 0
          pair.forcedReviewAt = now
          warn(`force review (${pair.id}) after idle without supervision_done`)
          scheduleReview(pair, {
            detail: `执行会话空闲 ${Math.round((now - pair.lastTurnEndAt) / 1000)}s 仍未调用 supervision_done（插件强制送审：${pair.reportPending === 'fix' ? '整改轮' : '完成轮'}），请逐项核验交付物，凡无真实证据一律 needs_fix`,
          }, 200)
        }
      }
    }
  }, 30000)

  // ---------------------------------------------------------------- pair ops

  function assertNotInAnyPair(agent) {
    if (!agent) return
    const owner = boundPairOf(agent.id)
    if (owner && owner.state === 'active') {
      throw new Error(`本会话已经属于监督对 ${owner.id}（1 执行 <-> 1 监督）：不要建第二对，用 supervision_status / supervision_review 查这一对`)
    }
    const boundId = boundPairId(agent.id)
    if (boundId) throw new Error(`本会话曾属于监督对 ${boundId}（已 ${pairs.get(boundId)?.state ?? 'unknown'}）：请在新会话里重开，或用 supervision_enroll 重新纳入该对`)
    for (const pair of pairs.values()) {
      if (pair.workerId === agent.id || pair.supervisorId === agent.id) throw new Error('this session belongs to a supervision pair; roles must not create new pairs')
    }
  }

  /** 统一构造监督对对象：所有字段（含 v3 的接力/交接记账位）都在这里初始化。 */
  function newPairShell(fields) {
    const acceptanceList = fields.acceptanceList ?? []
    const requirement = fields.requirement
    return {
      id: fields.id ?? `sup-${(pairSeq += 1)}-${Date.now().toString(36).slice(-5)}`,
      name: fields.name,
      requirement,
      auto: !!fields.auto,
      cardDelivered: !fields.deferWorkerCard,
      currentRequirement: acceptanceList.length
        ? `${requirement}\n\n【验收清单】\n${acceptanceList.map((line) => `- ${line}`).join('\n')}`
        : requirement,
      requirements: [{ at: Date.now(), source: 'start', text: acceptanceList.length ? `${requirement}\n验收清单: ${acceptanceList.join(' | ')}` : requirement }],
      // v3: 不再保留只写不读的 reviewers 死字段；监督侧的全部历史（含接力/重开）统一由 lineage 记账，
      // 1:1 约束由 bySupervisor / pairingConflicts / enforceOneToOne 三处共同把守。
      lastErrorScanAt: Date.now(),
      cwd: fields.cwd ?? null,
      workerId: fields.workerId,
      supervisorId: fields.supervisorId,
      state: 'active',
      phase: fields.deferWorkerCard ? 'pending-card' : 'working',
      fixRounds: 0,
      reviews: 0,
      cursor: 0,
      recentErrors: [],
      pendingTriggers: [],
      busy: false,
      reviewTimerOn: false,
      verdictSeen: false,
      nudges: 0,
      recheckAfterBusy: false,
      workerRunning: false,
      workerRunningSince: 0,
      supervisorRunning: false,
      supervisorRunningSince: 0,
      lastActivity: Date.now(),
      createdAt: fields.createdAt ?? Date.now(),
      lastVerdict: null,
      lastSummary: null,
      lastDoneSummary: null,
      lastWorkerTokens: undefined,
      lastSupervisorTokens: undefined,
      handovers: 0,
      lineage: [],
      consecutiveErrors: 0,
      reportPending: null,
      lastTurnEndAt: 0,
      nudgeAt: 0,
      forcedReviewAt: 0,
      // v3.2 卡死收口记账
      reviewTimeoutCount: 0,
      workerTimeoutCount: 0,
      pendingDeliveries: [],
      drainAt: 0,
      lastDrainAt: 0,
      // v1.2.4 上下文分段：{ parts, index, limit, budget, planAt, partDoneAt }
      splitPlan: null,
      deferredByChannel: 0,
      lastFixRound: 0,
      lastFixSummary: null,
      lastFixInstructions: null,
      // v3 接力 / 交接 / 配对唯一性记账
      reviewRequestId: undefined,
      fixRequestId: undefined,
      supervisorIdleSince: 0,
      lastSupervisorHand: 0,
      reviewParkAt: 0,
      rolling: new Set(),
      lastHandoverAt: 0,
      lastWorkerHandoverAt: 0,
      lastSupervisorHandoverAt: 0,
      lastEventAt: Date.now(),
      lastTouchAt: Date.now(),
      workerIdleSince: 0,
      hydrated: false,
      reviewsUsed: 0,
      reopenings: 0,
      reusedFrom: 0,
      lastCardDeliverAt: 0,
      lastAcquire: null,
    }
  }

  function installPair(pair) {
    pairs.set(pair.id, pair)
    byWorker.set(pair.workerId, pair)
    bySupervisor.set(pair.supervisorId, pair)
    bindSession(pair.workerId, pair, 'worker')
    bindSession(pair.supervisorId, pair, 'supervisor')
    touchJournal(pair)
    return pair
  }

  const pairRequirementText = (pair) => `${workerCard(pair)}\n\n【客户原始需求】\n${pair.requirement}`

  /** 送角色卡（监督卡 + 需求卡）；deferWorkerCard = 触发建对的那一轮还在跑，排到空闲点再送。 */
  function deliverPairCards(pair, { deferWorkerCard = false } = {}) {
    pair.lastCardDeliverAt = Date.now()
    serialDeliver(pair, 'card', pair.supervisorId, supervisorCard(pair)).catch((error) => warn('supervisor card delivery failed', error))
    const text = pairRequirementText(pair)
    if (deferWorkerCard) {
      pair.phase = 'pending-card'
      serialDeliver(pair, 'requirement', pair.workerId, text)
        .then(() => {
          pair.cardDelivered = true
          if (pair.phase === 'pending-card') pair.phase = 'working'
          pair.lastTurnEndAt = pair.lastTurnEndAt || Date.now()
          // 触发建对的那条消息本身就是任务：角色卡送达后，完成上报就算欠账，
          // 否则执行会话「本轮已经做完」时看门狗没资格提醒，监督会被静默跳过。
          if (!pair.reportPending) { pair.reportPending = 'done'; pair.reportAt = 0 }
        })
        .catch((error) => warn('deferred requirement delivery failed', error))
    } else {
      pair.cardDelivered = true
      serialDeliver(pair, 'requirement', pair.workerId, text).catch((error) => warn('requirement delivery failed', error))
      if (!pair.reportPending) { pair.reportPending = 'done'; pair.reportAt = pair.reportAt ?? 0 }
    }
  }

  /** 新建一对：一个全新执行会话 + 一个全新监督会话（1:1）。 */
  async function startPair({ name, requirement, acceptance, cwd, workerSessionId, auto = false, deferWorkerCard = false }) {
    const workerId = workerSessionId ?? await createSession(cwd)
    const supervisorId = await createSession(cwd)
    const acceptanceList = Array.isArray(acceptance) ? acceptance.filter((line) => typeof line === 'string' && line.trim()) : []
    const pair = newPairShell({ name: snippet(name || requirement, 40), requirement, auto, deferWorkerCard, cwd, workerId, supervisorId, acceptanceList })
    installPair(pair)
    recordReport('pair', pair, { cwd: pair.cwd, workerId, supervisorId, requirement: snippet(requirement, 2000), acceptance: acceptanceList, auto: !!auto })
    setTitle(workerId, `执行｜${pair.name}`)
    setTitle(supervisorId, `监督｜${pair.name}`)
    deliverPairCards(pair, { deferWorkerCard })
    pair.lastAcquire = { reused: false, reason: 'created', at: Date.now() }
    enforceOneToOne('create')
    return pair
  }

  /**
   * 拿到（至于是新建/复用/重开）：1:1 的唯一入口。
   * 会话串行锁保证同一会话的并发建对请求只有一个真正建对；
   * 已有活体对 -> 复用（不再开监督会话）；老对已终态且执行会话就是它的活体一侧 -> 重开。
   */
  function acquirePair(opts) {
    const workerSessionId = opts.workerSessionId
    if (!workerSessionId || !config.strictPairing) return startPair(opts)
    return serializeWith('pair:' + workerSessionId, async () => {
      const existing = boundPairOf(workerSessionId)
      if (existing && existing.state === 'active') return reusePair(existing, opts, existing.hydrated ? 'hydrated-active-pair' : 'active-pair')
      if (existing && existing.workerId === workerSessionId && existing.supervisorId) return reopenPair(existing, opts)
      if (existing) recordPairing(existing, { action: 'stale-binding', bound: existing.id, state: existing.state, sessionId: workerSessionId })
      return startPair(opts)
    })
  }

  /** 复用已有对：绝不新建会话；只补送角色卡/需求，并把需求并进来。 */
  function reusePair(pair, opts, reason) {
    pair.reusedFrom += 1
    const acceptanceList = Array.isArray(opts.acceptance) ? opts.acceptance.filter((line) => typeof line === 'string' && line.trim()) : []
    const requirement = typeof opts.requirement === 'string' ? opts.requirement.trim() : ''
    if (requirement && requirement !== pair.requirement) {
      pair.requirement = requirement
      pair.currentRequirement = acceptanceList.length
        ? `${requirement}\n\n【验收清单】\n${acceptanceList.map((line) => `- ${line}`).join('\n')}`
        : requirement
      pair.requirements.push({ at: Date.now(), source: 'reuse', acceptance: acceptanceList, text: requirement })
    }
    pair.nudgeAt = 0
    if (!pair.reportPending) { pair.reportPending = 'done'; pair.reportAt = pair.reportAt ?? 0 }
    pair.lastAcquire = { reused: true, reason, at: Date.now(), supervisorId: pair.supervisorId, workerId: pair.workerId }
    recordPairing(pair, { action: 'reused', reason, workerId: pair.workerId, supervisorId: pair.supervisorId, count: pair.reusedFrom })
    warn(`pair ${pair.id} reused for worker ${pair.workerId} (${reason}) — no new session created`)
    // 复用不再重复刷角色卡（并发/重复纳入只送一次，冷却 ${config.reuseCardCooldownMs}ms）
    if (Date.now() - (pair.lastCardDeliverAt ?? 0) > config.reuseCardCooldownMs) deliverPairCards(pair, { deferWorkerCard: !!opts.deferWorkerCard })
    else pair.cardDelivered = true
    return pair
  }

  /** 把已终态的老对重新激活（同一执行会话重开，监督会话若没了才补开一个，始终 1:1）。 */
  async function reopenPair(pair, opts) {
    const previousState = pair.state
    pair.reopenings += 1
    if (pair.reopenings > 3) {
      halt(pair, `同一执行会话重开监督次数达到上限（${pair.reopenings} 次），请人工检查后再继续`)
      pair.lastAcquire = { reused: false, reason: 'reopen-capped', at: Date.now() }
      return pair
    }
    pair.state = 'active'
    pair.phase = 'working'
    pair.busy = false
    pair.reviewTimerOn = false
    pair.reviews = 0
    pair.fixRounds = 0
    pair.consecutiveErrors = 0
    pair.recentErrors = []
    pair.reportPending = null
    pair.nudgeAt = 0
    pair.forcedReviewAt = 0
    pair.lastTurnEndAt = Date.now()
    pair.lastVerdict = null
    pair.lastFixInstructions = null
    const requirement = typeof opts.requirement === 'string' ? opts.requirement.trim() : ''
    if (requirement) {
      pair.requirement = requirement
      pair.currentRequirement = requirement
      pair.requirements.push({ at: Date.now(), source: 'reopen', text: requirement })
    }
    const alive = await sessionKnown(pair.supervisorId)
    if (!alive) {
      const previousSupervisorId = pair.supervisorId
      try {
        const newSupervisorId = await createSession(pair.cwd ?? undefined)
        pair.supervisorId = newSupervisorId
        bySupervisor.set(newSupervisorId, pair)
        bindSession(newSupervisorId, pair, 'supervisor')
        pair.lineage.push({ side: 'supervisor', number: (handoverSeq += 1), previousId: previousSupervisorId, newId: newSupervisorId, at: Date.now(), reason: 'reopen' })
        setTitle(newSupervisorId, `监督（重开）｜${pair.name}`)
        if (previousSupervisorId) markRetired(previousSupervisorId, pair, 'supervisor')
      } catch (error) { warn('reopen supervisor create failed', error) }
    }
    pair.cardDelivered = false
    recordReport('pair', pair, { reopened: pair.reopenings, cwd: pair.cwd, workerId: pair.workerId, supervisorId: pair.supervisorId, requirement: snippet(pair.requirement, 2000), acceptance: [], auto: !!pair.auto })
    recordPairing(pair, { action: 'reopened', previousState, workerId: pair.workerId, supervisorId: pair.supervisorId, count: pair.reopenings })
    pair.lastAcquire = { reused: true, reason: 'reopened', at: Date.now(), previousState, supervisorId: pair.supervisorId, workerId: pair.workerId }
    deliverPairCards(pair, { deferWorkerCard: !!opts.deferWorkerCard })
    enforceOneToOne('reopen')
    return pair
  }

  async function sessionKnown(sessionId) {
    if (!sessionId) return false
    try { if (ctx.sessions.get(sessionId)) return true } catch {}
    try { const snapshot = await ctx.sessionQuery.readSession(sessionId); return !!snapshot } catch { return false }
  }


  // ------------------------------------------------------- auto enrollment (需要审查)
  // 客户在新会话的第一条真实消息里写「需要审查」→ 插件自动建监督对：
  // 该会话 = 执行侧，另开一个监督会话；不需要模型自己调 supervision_enroll。
  const noiseText = /^(Current runtime context|<system-reminder>|Time sampled|\[MNEMON\]|MNEMON RUNTIME MEMORY|MNEMON VIEW|MNEMON GENERAL)/i
  // 注入型上下文（记忆快照等）也走 kind:'user' 的 user/message，按 rpcId 特征排除，避免把「首条消息」判成注入。
  const INJECTED_CONTEXT_RE = /mnemon|memory[-_]?inject|dsh-mnemon|context[-_]?inject|openviking/i

  const realCustomerBlocks = (content) => (Array.isArray(content) ? content : [])
    .filter((block) => block?.type === 'text' && block.text && !noiseText.test(block.text.trim()))

  /** 本轮之前的日志里有没有真实客户消息（用于把「首条消息」判定干净）。 */
  function hasEarlierCustomerMessage(events, selfSeq) {
    return (Array.isArray(events) ? events : []).some((event) => {
      if (event?.type !== 'user/message') return false
      const seq = event.seq
      if (typeof selfSeq === 'number' && typeof seq === 'number' && seq >= selfSeq) return false
      const data = event.data ?? {}
      if (isSupRpc(data.source?.rpcId)) return false
      if (data.source?.kind && data.source.kind !== 'user') return false
      const blocks = realCustomerBlocks(data.content)
      if (blocks.length === 0) return false
      // 注入型上下文也是 kind:'user' 的 user/message（如记忆快照）：按来源 rpcId/正文特征排除
      if (INJECTED_CONTEXT_RE.test(String(data.source?.rpcId ?? ''))) return false
      enrollLog(`earlier-candidate seq=${seq} rpc=${data.source?.rpcId ?? '-'} ${snippet(blocks.map((block) => block.text).join(' '), 90)}`)
      return true
    })
  }

  /** 把触发词从句子里剔掉（剔不干净就整个丢掉，防止监督把「需要审查」当成任务）。 */
  function buildRequirement(text) {
    let cleaned = String(text ?? '')
    if (TRIGGER_NEGATE_RE.test(cleaned)) cleaned = cleaned.replace(TRIGGER_NEGATE_RE, ' ')
    cleaned = cleaned.replace(TRIGGER_HIT_RE, ' ')
    const pattern = String(config.reviewTriggerPattern ?? '').trim()
    if (pattern) cleaned = cleaned.split(pattern).join(' ')
    cleaned = cleaned
      .replace(/[（(]\s*[)）]/g, ' ')
      .replace(/[，,、;；:：\s]{2,}/g, ' ')
      .trim()
    if (!cleaned || cleaned.length < 4) cleaned = String(text ?? '').trim()
    return cleaned
  }

  function matchesReviewTrigger(text) {
    const raw = String(text ?? '')
    if (!raw.trim()) return false
    const positive = raw.replace(TRIGGER_NEGATE_RE, ' ')
    if (TRIGGER_HIT_RE.test(positive)) return true
    const pattern = String(config.reviewTriggerPattern ?? '').trim()
    if (!pattern) return false
    try {
      return new RegExp(pattern, 'i').test(positive)
    } catch {
      return positive.includes(pattern)
    }
  }

  async function autoEnrollFromMessage(session, data, seq) {
    const trace = (step, detail = '') => {
      const line = `${new Date().toISOString()} auto ${session?.id ?? '?'} ${step}${detail ? ` ${detail}` : ''}`
      enrollTrace = [enrollTrace[enrollTrace.length - 1], line].filter(Boolean)
      if (enrollTrace.length > 12) enrollTrace.shift()
      warn(line)
      if (config.debugEnrollTrace === true) { try { fs.appendFileSync(path.join(storeDir, 'auto-enroll.log'), line + '\n') } catch {} }
    }
    if (!config.autoEnrollReview || !config.reviewEnabled) return trace('skip', 'disabled')
      // 一次性/委派会话（mnemon-run-*、无 session- 前缀的 worker 会话）不建对：
      // 它们跑完就没了，建对只会留下一个永远不动的「幽灵监督对」（11-16 实测 sup-1-ures6）。
      if (!/^session-/.test(String(session?.id ?? ''))) return trace('skip', `ephemeral-session=${session?.id}`)
    if (byWorker.get(session?.id) || bySupervisor.get(session?.id)) return trace('skip', 'already-in-pair')
    if (retired.has(session?.id)) return trace('skip', 'retired-session')
    if (boundPairId(session?.id)) return trace('skip', `bound-pair=${boundPairId(session?.id)}`)
    if (isSupRpc(data?.source?.rpcId)) return trace('skip', `sup-rpc ${data?.source?.rpcId}`)
    if (data?.source?.kind && data.source.kind !== 'user') return trace('skip', `source=${data.source.kind}`)
    const blocks = realCustomerBlocks(data?.content)
    if (blocks.length === 0) return trace('skip', 'no-real-text-block')
    const text = blocks.map((block) => block.text).join('\n')
    if (!matchesReviewTrigger(text)) return trace('skip', 'no-trigger')
    let events = []
    try {
      events = ctx.sessions.get(session.id)?.events ?? (await ctx.sessionQuery.readSession(session.id))?.events ?? []
    } catch (error) { warn('auto enroll read log failed', error) }
    if (hasEarlierCustomerMessage(events, seq)) return trace('skip', 'not-first-message')
    const requirement = buildRequirement(text)
    const cwd = (() => {
      try { return ctx.get('workingDirectory')?.get?.(session) ?? undefined } catch { return undefined }
    })()
    trace('enroll', snippet(requirement, 80))
    const pair = await acquirePair({
      name: `审查｜${snippet(requirement, 24)}`,
      requirement,
      cwd,
      workerSessionId: session.id,
      auto: true,
      deferWorkerCard: true,
    })
    const reused = !!pair.lastAcquire?.reused
    recordReport('requirement', pair, {
      acceptance: [],
      note: reused
        ? `客户首条消息含「审查触发词」：已有监督对 ${pair.id}，复用同一个监督会话（未新建会话）`
        : `客户首条消息含「审查触发词」，自动纳入监督（执行会话 ${session.id}）`,
      by: 'auto',
    })
    if (reused) trace('reuse-pair', `pair=${pair.id} supervisor=${pair.supervisorId} (未新建会话)`)
    warn(`auto-${reused ? 'reuse' : 'enrolled'} ${session.id} -> ${pair.id}: ${snippet(requirement, 120)}`)
  }

  /**
   * 1:1 硬校验（v3）：同一执行链路（含接力历史）同时只允许一个活体监督对。
   * 最近活动的那一对保留，其余重复对立即熔断 + 停止它两侧的会话，
   * 这就是「有几率开了很多会话」的收口：重复建对不会留下第二个活体监督/执行。
   */
  function enforceOneToOne(trigger) {
    if (!config.strictPairing) return 0
    const active = [...pairs.values()].filter((pair) => pair.state !== 'complete' && pair.state !== 'stopped' && pair.state !== 'halted')
    if (active.length < 2) return 0
    const ordered = active.slice().sort((a, b) => (b.lastEventAt ?? b.createdAt) - (a.lastEventAt ?? a.createdAt))
    const claim = new Map()
    const duplicates = []
    for (const pair of ordered) {
      const keys = new Set([pair.workerId, pair.supervisorId])
      for (const row of pair.lineage ?? []) { if (row?.previousId) keys.add(row.previousId); if (row?.newId) keys.add(row.newId) }
      let hit = null
      for (const key of keys) {
        if (!key) continue
        const owner = claim.get(key)
        if (!owner) claim.set(key, pair)
        else if (owner !== pair && !hit) hit = { key, kept: owner.id }
      }
      if (hit) duplicates.push({ pair, hit })
    }
    for (const { pair, hit } of duplicates) {
      const victims = [pair.workerId, pair.supervisorId].filter(Boolean)
      halt(pair, `重复监督对已合并：同一执行链路已有活体对 ${hit.kept}，本对的会话已全部停止运行`)
      for (const id of victims) {
        const owner = livePairOf(id)
        if (owner && owner.id === pair.id) markRetired(id, pair, id === pair.workerId ? 'worker' : 'supervisor')
      }
      if (pairingIssues.length > 40) pairingIssues.shift()
      pairingIssues.push({ at: Date.now(), action: 'duplicate-pair', dropped: [pair.id], kept: hit.kept, sharedKey: hit.key, stopped: victims, trigger })
      recordPairing(pair, { action: 'duplicate-pair', trigger, dropped: pair.id, kept: hit.kept, sharedKey: hit.key, stopped: victims })
      warn(`duplicate pair ${pair.id} halted (kept ${hit.kept}; stopped ${victims.join(', ')})`)
    }
    return duplicates.length
  }

  /**
   * 重启 / 插件重转后从持久 journal 复原监督对：内存注册表不再凭空丢失，
   * 老执行会话重开时命中已有的那个监督会话（复用），不再重复开会话。
   */
  function hydratePairsFromJournal() {
    const records = new Map()
    for (const event of journal.events) {
      const pairId = event?.pairId
      if (!pairId) continue
      const data = event.data ?? {}
      if (event.kind === 'pair') {
        if (!records.has(pairId)) {
          records.set(pairId, {
            id: pairId, name: event.pairName ?? pairId, requirement: data.requirement ?? '', auto: !!data.auto, cwd: data.cwd ?? null,
            workerId: data.workerId, supervisorId: data.supervisorId, state: 'active', phase: 'working',
            reviews: 0, reviewsUsed: 0, fixRounds: 0, handovers: 0, lineage: [], reopenings: 0,
            lastVerdict: null, lastSummary: null, lastFixInstructions: null, lastFixRound: 0,
            acceptance: Array.isArray(data.acceptance) ? data.acceptance : [], at: event.at, createdAt: event.at,
          })
        } else if (data.reopened) {
          const record = records.get(pairId)
          record.state = 'active'
          record.phase = 'working'
          record.reviews = 0
          record.fixRounds = 0
          record.reopenings = data.reopened
          record.workerId = data.workerId ?? record.workerId
          record.supervisorId = data.supervisorId ?? record.supervisorId
          record.requirement = data.requirement ?? record.requirement
          record.createdAt = record.createdAt ?? event.at
        }
        continue
      }
      const record = records.get(pairId)
      if (!record) continue
      record.at = event.at
      if (event.kind === 'handover') {
        if (data.side === 'worker') record.workerId = data.newId ?? record.workerId
        else record.supervisorId = data.newId ?? record.supervisorId
        record.handovers += 1
        record.lineage.push({ side: data.side, number: data.number, previousId: data.previousId, newId: data.newId, at: event.at, hydrated: true })
      } else if (event.kind === 'review') {
        if (!data.rejected) {
          record.reviews += 1
          record.workerId = data.workerId ?? record.workerId
          record.supervisorId = data.supervisorId ?? record.supervisorId
          record.lastReviewAt = event.at
          if (record.state === 'active') record.phase = 'reviewing'
        }
      } else if (event.kind === 'verdict') {
        record.lastVerdict = data.verdict ?? record.lastVerdict
        record.lastSummary = data.summary ?? record.lastSummary
        record.lastFixInstructions = data.fixInstructions ?? record.lastFixInstructions
        record.lastFixRound = data.fixRound ?? record.lastFixRound
        if (data.verdict === 'needs_fix') record.fixRounds += 1
        if (data.verdict === 'complete') { record.state = 'complete'; record.phase = 'done' }
      } else if (event.kind === 'requirement') {
        if (Array.isArray(data.acceptance) && data.acceptance.length) record.acceptance = data.acceptance
      } else if (event.kind === 'halted') {
        if (data.reason && String(data.reason).includes('重复监督对')) continue
        record.state = 'halted'
        record.phase = 'halted'
        record.haltReason = data.reason ?? ''
      } else if (event.kind === 'stopped') {
        record.state = 'stopped'
        record.phase = 'stopped'
      } else if (event.kind === 'pairing') {
        if (data.action === 'reopened') { record.state = 'active'; record.phase = 'working'; record.reviews = 0; record.fixRounds = 0 }
        else if (data.action === 'duplicate-pair') { record.state = 'halted'; record.phase = 'halted'; record.haltReason = '重复监督对已合并' }
      }
    }
    const materialized = []
    for (const record of records.values()) {
      if (pairs.has(record.id) || !record.workerId || !record.supervisorId) continue
      const pair = newPairShell({
        id: record.id, name: record.name, requirement: record.requirement, auto: record.auto, cwd: record.cwd,
        workerId: record.workerId, supervisorId: record.supervisorId, acceptanceList: record.acceptance, createdAt: record.createdAt,
      })
      pair.hydrated = true
      pair.state = record.state
      pair.phase = record.state === 'active' ? 'working' : record.phase
      pair.reviews = record.reviews
      pair.reviewsUsed = record.reviews
      pair.fixRounds = record.fixRounds
      pair.handovers = record.handovers
      pair.lineage = record.lineage
      pair.reopenings = record.reopenings
      pair.lastVerdict = record.lastVerdict
      pair.lastSummary = record.lastSummary
      pair.lastFixInstructions = record.lastFixInstructions
      pair.lastFixRound = record.lastFixRound
      pair.haltReason = record.haltReason ?? null
      pair.lastEventAt = record.at
      pair.cardDelivered = true
      pair.reportPending = null
      pair.lastTurnEndAt = Date.now()
      // 重载/重启复原：上次停在评审中的对要恢复 busy 与「评审起手时间」，
      // 否则看门狗算不出它已经卡了多久，永远收不了口（11-15 卡死就是这么来的）。
      if (record.phase === 'reviewing') {
        pair.busy = true
        pair.phase = 'reviewing'
        pair.lastSupervisorHand = record.lastReviewAt ?? record.at ?? record.createdAt ?? Date.now()
      }
      // 复原后单轮计时的起点用「上次事件时间」兜底：否则重载后 worker 明明在跑却永远不算超时。
      if (record.phase !== 'done' && record.phase !== 'stopped' && record.phase !== 'halted') {
        pair.workerRunningSince = record.at ?? 0
      }
      installPair(pair)
      for (const row of record.lineage) if (row?.previousId) markRetired(row.previousId, pair, row.side === 'worker' ? 'worker' : 'supervisor')
      materialized.push(pair)
    }
    const dropped = enforceOneToOne('hydrate')
    let dormant = 0
    const dormantBefore = Date.now() - config.dormantAfterMs
    for (const pair of materialized) {
      if (pair.state !== 'active' || (pair.lastEventAt ?? 0) > dormantBefore) continue
      pair.state = 'dormant'
      pair.phase = 'dormant'
      pair.reportPending = null
      pair.busy = false
      pair.reviewTimerOn = false
      dormant += 1
    }
    if (dormant) warn(`dormant pairs after restart: ${dormant} (静默超过 ${Math.round(config.dormantAfterMs / 3600000)}h 的老对转休眠，重开时复用原监督会话)`)
    if (materialized.length) {
      const active = materialized.filter((pair) => pair.state === 'active').map((pair) => pair.id)
      recordPairing(materialized[materialized.length - 1], { action: 'hydrate', count: materialized.length, active, dormant, dropped })
      warn(`pairs hydrated from journal: ${materialized.length} (active: ${active.join(', ') || 'none'}), duplicate dropped: ${dropped}`)
    }
    return { materialized, dropped }
  }
  function resolvePair(pairId, agent) {
    if (pairId) {
      const pair = pairs.get(pairId)
      if (!pair) throw new Error(`unknown supervision pair "${pairId}". Known: ${[...pairs.keys()].join(', ') || '(none)'}`)
      return pair
    }
    if (agent) {
      const own = byWorker.get(agent.id) ?? bySupervisor.get(agent.id)
      if (own) return own
    }
    const active = [...pairs.values()].filter((pair) => pair.state === 'active')
    if (active.length === 1) return active[0]
    throw new Error(`pairId is required: ${active.length === 0 ? 'no active supervision pair exists' : `${active.length} active pairs (${active.map((pair) => pair.id).join(', ')})`}`)
  }

  const pairView = (pair) => ({
    pairId: pair.id,
    name: pair.name,
    state: pair.state,
    phase: pair.phase,
    auto: !!pair.auto,
    reportPending: pair.reportPending ?? null,
    serial: { workerRunning: pair.workerRunning, supervisorRunning: pair.supervisorRunning, reviewInFlight: pair.busy },
    // 客户最关心的「到底跑多久了」：单轮运行时长与超时记账（旧版这里完全看不到，只能靠猜）
    running: {
      workerSeconds: pair.workerRunning && pair.workerRunningSince ? Math.round((Date.now() - pair.workerRunningSince) / 1000) : 0,
      supervisorSeconds: pair.supervisorRunning && pair.supervisorRunningSince ? Math.round((Date.now() - pair.supervisorRunningSince) / 1000) : 0,
      sinceSupervisorHandSeconds: pair.lastSupervisorHand ? Math.round((Date.now() - pair.lastSupervisorHand) / 1000) : 0,
      reviewTimeouts: `${pair.reviewTimeoutCount ?? 0}/${config.maxReviewTimeouts}`,
      workerTimeouts: `${pair.workerTimeoutCount ?? 0}/${config.maxWorkerTimeouts}`,
      deferredDelivery: (pair.pendingDeliveries ?? []).map((row) => row.tag).join('/') || null,
      queuedDeliveries: (pair.pendingDeliveries ?? []).length,
      watchdogSeconds: watchdogAt ? Math.round((Date.now() - watchdogAt) / 1000) : null,
      // v1.3.1 单轮上限透出到状态：本地模型上下文大时一轮可能很久，客户要能看到实际生效值
      turnTimeoutMs: config.workerTurnTimeoutMs,
      // 本地模型单通道：这里能直接看到「现在有几路在抢通道」，>0 时插件不会插队
      channel: { others: channelOthers(pair).length, samples: channelOthers(pair).slice(0, 4), deferredByChannel: pair.deferredByChannel ?? 0, source: channelSource, guard: config.channelGuard },
    },
    workerSessionId: pair.workerId,
    supervisorSessionId: pair.supervisorId,
    context: {
      worker: pressureOf(pair.workerId).tokens ?? pair.lastWorkerTokens ?? null,
      supervisor: pressureOf(pair.supervisorId).tokens ?? pair.lastSupervisorTokens ?? null,
      limit: pressureOf(pair.workerId).limit,
      window: pressureOf(pair.workerId).window ?? pressureOf(pair.supervisorId).window ?? null,
      ceiling: ceilingOf(pair.workerId) ?? ceilingOf(pair.supervisorId) ?? null,
      declaredWindow: pressureOf(pair.workerId).declaredWindow ?? null,
      source: pressureOf(pair.workerId).source,
      supervisorSource: pressureOf(pair.supervisorId).source,
      remaining: pressureOf(pair.workerId).remaining,
      handovers: `${pair.handovers}/${config.maxHandovers}`,
      overflowCount: pair.overflowCount ?? 0,
      // v1.2.4：客户设的上下文大小 + 当前分段进度（`2/5` 表示正在做第 2 段，共 5 段）
      splitTokens: config.contextSplitTokens > 0 ? config.contextSplitTokens : null,
      split: pair.splitPlan ? `${pair.splitPlan.index}/${pair.splitPlan.parts.length}` : null,
    },
    lineage: pair.lineage,
    retiredSessions: retiredSides(pair),
    pairing: pairingSummary(pair),
    reviews: `${pair.reviews}/${config.maxReviews}`,
    fixRounds: `${pair.fixRounds}/${config.maxFixRounds}`,
    lastVerdict: pair.lastVerdict,
    lastSummary: pair.lastSummary,
    consecutiveErrors: pair.consecutiveErrors,
    recentErrors: pair.recentErrors,
  })

  const textOutput = {
    schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    render(_args, value) {
      return [{ type: 'text', text: String((value && value.text) || '') }]
    },
  }

  // ---------------------------------------------------------------- tools

  ctx.tools.register({
    name: 'supervision_start',
    description: 'Create a supervised execution pair: a fresh executor session that receives the customer requirement plus a supervisor session that reviews the executor ONLY after it reports everything done (supervision_done). Sessions run strictly serially (single-slot local model); review/fix rounds are bounded by maxFixRounds/maxReviews/maxHandovers and a consecutive-model-error halt. Use when the user asks to start a supervised task (一个监督会话+一个执行会话).',
    parameters: {
      type: 'object',
      properties: {
        requirement: { type: 'string', description: 'The full customer requirement text handed to the executor session.' },
        acceptance: { type: 'array', items: { type: 'string' }, description: 'Checkable acceptance items the supervisor must independently reproduce (files exist, command output matches, API returns 200, page opens…). Strongly recommended: without them the review only sees the executor self-report.' },
        name: { type: 'string', description: 'Short human-readable task label for both sessions.' },
        cwd: { type: 'string', description: 'Workspace directory for both sessions; defaults to the caller working directory.' },
      },
      required: ['requirement'],
    },
    output: textOutput,
    async execute(args, exec) {
      assertNotInAnyPair(exec.agent)
      const cwd = args.cwd ?? ctx.get('workingDirectory')?.get?.(exec.agent?.session) ?? undefined
      const pair = await startPair({ name: args.name, requirement: args.requirement, acceptance: args.acceptance, cwd })
      return {
        text: [
          `监督对已创建：${pair.id}`,
          `执行会话：${pair.workerId}（客户在 Web UI 打开该会话直接输入需求即可）`,
          `监督会话：${pair.supervisorId}`,
          `工作目录：${pair.cwd ?? '(默认)'}`,
          '评审时机：执行会话【全部完成】并 supervision_done 后才触发一次评审；中间步骤不评审。串行：一方跑完才轮到另一方。',
          `上下文：执行/监督两侧水位各自测得（来源 ${pressureOf(pair.workerId).source}），阈值 ${kTokens(limitFor(pressureOf(pair.workerId).window))}（窗口减预留 ${kTokens(config.contextReserveTokens)}）；达阈值自动开新会话接力，投递前还会按剩余额度裁剪，provider 若先拒请求则立即紧急接力。`,
          '熔断：修复上限 ' + config.maxFixRounds + ' 轮、评审预算 ' + config.maxReviews + '、接力上限 ' + config.maxHandovers + '、连续 3 次模型错误自动停止（上下文溢出不计入，走接力）。',
          channelAdvice(pair).trim(),
          '用 supervision_status 查看进度；supervision_review 人工提前评审；supervision_stop 结束监督。',
        ].join('\n'),
      }
    },
  })

  ctx.tools.register({
    name: 'supervision_enroll',
    description: 'Enroll the CURRENT session as the executor of a new supervision pair: a supervisor session is created and reviews this session only after it reports everything done. Use when the user asks to put this very conversation under supervision (also re-arms supervision after a host restart). Note: a NEW session whose first customer message contains 「需要审查」 is enrolled automatically by the plugin, so you do not need to call this for that case.',
    parameters: {
      type: 'object',
      properties: {
        requirement: { type: 'string', description: 'The customer requirement this session is working on; omit to let the supervisor judge from the session log.' },
        name: { type: 'string', description: 'Short task label.' },
      },
    },
    output: textOutput,
    async execute(args, exec) {
      const agent = exec.agent
      if (!agent) throw new Error('supervision_enroll requires an owning agent session')
      const requirement = args.requirement ?? '(调用方未单独给出：监督者请从执行会话自身日志判断客户需求是否完成。)'
      const pair = await acquirePair({
        name: args.name,
        requirement,
        cwd: ctx.get('workingDirectory')?.get?.(agent.session) ?? undefined,
        workerSessionId: agent.id,
      })
      const acquire = pair.lastAcquire ?? {}
      if (acquire.reused) {
        return {
          text: [
            `本会话已有一个监督对，直接复用：${pair.id}（未新建任何会话）`,
            `执行会话：${pair.workerId}；监督会话：${pair.supervisorId}`,
            `原因：${acquire.reason}`,
            '全部完成时调用一次 supervision_done 才会触发评审；需要中途检查用 supervision_review。',
          ].join('\n'),
        }
      }
      return {
        text: `当前会话已纳入监督：${pair.id}\n监督会话：${pair.supervisorId}\n全部完成时调用 supervision_done 才触发评审。${channelAdvice(pair)}`,
      }
    },
  })

  ctx.tools.register({
    name: 'supervision_done',
    description: 'Executor-side completion claim — the ONLY automatic review trigger. Call it exactly ONCE, after the ENTIRE customer requirement is done and verified (not per step; report again after each fix round). The supervisor then reviews serially; if it finds bugs, fix instructions are dispatched back. Requires the supervision role-card message in this session.',
    parameters: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'What was accomplished and how it was verified (paste real command output as evidence).' },
      },
      required: ['summary'],
    },
    output: textOutput,
    async execute(args, exec) {
      let pair = byWorker.get(exec.agent?.id)
      if (!pair) throw new Error('only an enrolled executor session may call supervision_done (start or enroll supervision first)')
      if (pair.state === 'dormant') {
        // 宿主重启 / 插件重转后老对进入休眠：本会话上报 = 复用原监督会话续跑（零新开会话）
        await reopenPair(pair, {})
        recordPairing(pair, { action: 'auto-reopen-on-done', workerId: pair.workerId, supervisorId: pair.supervisorId })
        pair = byWorker.get(exec.agent?.id) ?? pair
      }
      if (pair.state !== 'active') throw new Error(`pair ${pair.id} is ${pair.state}; no review will run（用 supervision_enroll 复用原监督会话，或 supervision_review 人工评审）`)
      pair.lastDoneSummary = args.summary
      pair.consecutiveErrors = 0
      pair.reportPending = 'done'
      pair.reportAt = Date.now()
      pair.nudgeAt = 0
      // 正常上报说明执行侧没卡死：超时计数清零（连续卡死才熔断）
      pair.workerTimeoutCount = 0
      // v1.2.4 分段推进：本段做完只推进到下一段，**不进评审**；最后一段才进评审。
      const split = pair.splitPlan
      if (split && split.index <= split.parts.length) {
        const finished = split.index
        if (finished < split.parts.length) {
          split.index = finished + 1
          split.partDoneAt = Date.now()
          recordReport('context-split', pair, {
            action: 'part-done', part: finished, total: split.parts.length,
            nextPart: split.index, summary: snippet(args.summary, 400),
          })
          scheduleSplitPart(pair, 800)
          return { text: `第 ${finished}/${split.parts.length} 段已记录（本轮不进评审）。插件将把第 ${split.index}/${split.parts.length} 段发给新会话按顺序继续。` }
        }
        pair.splitPlan = null
        recordReport('context-split', pair, { action: 'all-parts-done', total: split.parts.length, summary: snippet(args.summary, 400) })
        scheduleReview(pair, { detail: `执行会话声称已全部完成（分段 ${split.parts.length}/${split.parts.length}）：${snippet(args.summary, 240)}` }, 1200)
        return { text: `第 ${split.parts.length}/${split.parts.length} 段（最后一段）已完成，插件将串行送监督评审。请保持空闲等待结论。` }
      }
      scheduleReview(pair, { detail: `执行会话声称已全部完成：${snippet(args.summary, 240)}` }, 1200)
      return { text: '已上报「全部完成」，插件将在本轮结束后串行送监督评审。请保持空闲等待结论。' }
    },
  })

  ctx.tools.register({
    name: 'supervision_review',
    description: 'Manually trigger a supervisor review round now (e.g. customer asks for a mid-flight check). Does not repeat on turn ends; reviews still only auto-run on supervision_done.',
    parameters: {
      type: 'object',
      properties: {
        pairId: { type: 'string', description: 'Supervision pair id; omit when only one pair exists.' },
        note: { type: 'string', description: 'Why this manual review was requested (shown to the supervisor).' },
      },
    },
    output: textOutput,
    execute(args, exec) {
      const pair = resolvePair(args.pairId, exec.agent)
      if (pair.state !== 'active') throw new Error(`pair ${pair.id} is ${pair.state}`)
      scheduleReview(pair, { detail: `人工触发评审：${snippet(args.note ?? '客户要求中途检查', 200)}` }, 500)
      return { text: `已为监督对 ${pair.id} 排队一次人工评审（串行送达）。` }
    },
  })

  // v1.2.4 分段：先看计划（dry-run），确认后 apply —— 客户的「超过设定大小就拆分、按顺序完成」
  // 平时由看门狗在水位到线时自动触发；这个工具用于超限前主动分段、或只想看拆分结果。
  ctx.tools.register({
    name: 'supervision_split',
    description: 'Split the pair\'s remaining work into ordered context segments (v1.2.4). Dry-run returns the plan; apply=true immediately opens a new executor session and starts from the segment 1. Triggered automatically when context exceeds the customer-set contextSplitTokens (e.g. 512K/1M).',
    parameters: {
      type: 'object',
      properties: {
        pairId: { type: 'string', description: 'Supervision pair id; omit when only one pair exists.' },
        apply: { type: 'boolean', description: 'true = start executing segment 1 in a fresh executor session now (default false = plan only).' },
        tokens: { type: 'number', description: 'Override the per-segment token budget for this plan (e.g. 524288 / 1048576).' },
      },
    },
    output: textOutput,
    async execute(args, exec) {
      const pair = resolvePair(args.pairId, exec.agent)
      if (pair.state !== 'active') throw new Error(`pair ${pair.id} is ${pair.state}; 只有 active 的对能分段`)
      const pressure = pressureOf(pair.workerId)
      const budget = typeof args.tokens === 'number' && args.tokens >= 100 ? Math.floor(args.tokens) : undefined
      const plan = planSplit(pair, pressure, budget)
      const lines = [
        `监督对 ${pair.id}「${pair.name}」分段计划：共 ${plan.parts.length} 段（每段预算 ≈${plan.budget} 字 / 阈值 ${tokenLabel(plan.limit)}）。`,
        pressure.tokens !== undefined ? `执行侧当前水位 ${pressureText(pressure)}` : '执行侧水位未知（不影响分段，计划按需求条目切）',
        ...plan.parts.map((part, index) => `\n第 ${index + 1}/${plan.parts.length} 段（${part.length} 项）：\n${part.map((item, i) => `  ${i + 1}. ${snippet(item.text, 200)}`).join('\n')}`),
      ]
      if (!args.apply) {
        recordReport('context-split', pair, { action: 'plan', total: plan.parts.length, budget: plan.budget, limit: plan.limit, tokens: pressure.tokens ?? null, dryRun: true })
        return { text: lines.join('\n') + '\n\n（dry-run，未开工。要按这个计划开始分段执行，用 supervision_split apply=true。）' }
      }
      if (plan.parts.length <= 1) return { text: lines.join('\n') + '\n\n只剩一段，不需要分段（直接用普通接力/直接干）。' }
      pair.splitPlan = plan
      const started = await handoverIfNeeded(pair, 'worker', { force: true, split: true, reason: '客户主动分段（supervision_split apply）' })
      return { text: lines.join('\n') + (started ? '\n\n已开新执行会话，正在投第 1 段。' : '\n\n分段启动被拒（可能正在接力/已达接力上限），见 supervision_status.recentErrors。') }
    },
  })

  // ------------------------------------------------- anti-fake-complete gate
  // 反假完成门槛：complete 必须有逐项、有证据的核验清单；缺项/无证据/上一条整改
  // 没有结论，都直接打回监督（本轮评审作废），杜绝模型一句「都完成了」就关对。
  const CHECK_STATUS = new Set(['done', 'failed', 'unverified'])
  const EVIDENCE_MARK_RE = /(\/[^\s'"，。]+|[\w.-]+\.(ts|js|vue|json|md|py|pyw|html|css|yml|yaml|sh|ps1|log|txt|glb|png|jpg|csv|sql|service|env)|GET |POST |curl |systemctl|journalctl|ssh |ps1|pwsh|pytest|http[s]?:\/\/|\d{3}\s*(OK|条|项|行)|exit\s*\(code[:\s]*\d+\)|[A-Za-z]:\\\\)/i

  const checklistRows = (value) => (Array.isArray(value) ? value : [])
    .map((item) => (item && typeof item === 'object' ? item : { item: typeof item === 'string' ? item : '', verified: '', evidence: '' }))

  const checklistText = (value) => (Array.isArray(value) ? value : []).map((item, index) => {
    if (item && typeof item === 'object') return `${index + 1}. ${item.item ?? ''} → ${item.verified ?? ''}：${item.evidence ?? ''}`
    return `${index + 1}. ${String(item ?? '')}`
  }).join('\n')

  function checkVerdict(pair, args) {
    const problems = []
    const checklist = checklistRows(args.checklist)
    if (args.verdict === 'complete') {
      if (checklist.length < 1) problems.push('checklist 缺失：complete 必须逐条给出你亲自核验过的验收条目（每条含 verify 命令/路径 + evidence 真实输出）。')
      const previous = checklistRows(pair.lastChecklist).filter((row) => String(row.verified ?? '').toLowerCase() !== 'done')
      if (previous.length && pair.lastVerdict === 'needs_fix') {
        const names = checklist.map((row) => String(row.item ?? '')).join(' ').toLowerCase()
        const missed = previous.filter((row) => {
          const key = String(row.item ?? '').trim().slice(0, 8).toLowerCase()
          return key.length > 1 && !names.includes(key)
        })
        if (missed.length) problems.push(`上一条整改（第 ${pair.lastFixRound ?? pair.fixRounds} 轮）的缺项没有一条被重新核验：${missed.map((row) => String(row.item ?? '').slice(0, 40)).join('；')}。`)
      }
      const summary = String(args.summary ?? '').trim()
      if (summary.length < config.completeSummaryMinChars) problems.push(`summary 太短（${summary.length} 字 < ${config.completeSummaryMinChars}）：complete 必须写清每条验收是怎么复现的。`)
    }
    checklist.forEach((row, index) => {
      const label = `第 ${index + 1} 项「${snippet(row.item, 40)}」`
      const status = String(row.verified ?? '').trim().toLowerCase()
      const evidence = String(row.evidence ?? '').trim()
      if (!status) problems.push(`${label} 没有 verified（done/failed/unverified）。`)
      else if (!CHECK_STATUS.has(status)) problems.push(`${label} verified="${snippet(status, 20)}" 非法，只能是 done/failed/unverified。`)
      else if (status === 'done' && evidence.length < 8) problems.push(`${label} 标记 done 但没有真实证据（须写你亲自跑的命令/读到的文件内容/HTTP 状态，不得照抄执行会话的话）。`)
      else if (status === 'done' && evidence.length < 24 && !EVIDENCE_MARK_RE.test(evidence)) problems.push(`${label} 证据太弱："${snippet(evidence, 60)}"（要含路径/命令/输出片段/状态码，能被别人复现）。`)
    })
    if (args.verdict === 'needs_fix' && !String(args.fixInstructions ?? '').trim()) problems.push('needs_fix 必须填写 fixInstructions：逐条指出未通过/未核验的项与期望结果。')
    return { ok: problems.length === 0, problems, checklist }
  }

  ctx.tools.register({
    name: 'supervision_verdict',
    description: 'Supervisor-side review verdict; the ONLY valid end of a [监督评审] review turn. complete closes the pair; needs_fix queues the fix instructions for serial dispatch back to the executor (bounded by maxFixRounds). complete requires a per-item checklist where every item carries evidence YOU produced yourself (command output, file path/content, HTTP status) — the plugin rejects a complete without it, so a bare "all done" cannot pass.',
    parameters: {
      type: 'object',
      properties: {
        pairId: { type: 'string', description: 'Supervision pair id from the review message.' },
        verdict: { type: 'string', enum: ['complete', 'needs_fix'], description: 'complete = requirement fully met; needs_fix = bugs or gaps found.' },
        summary: { type: 'string', description: 'Acceptance evidence (complete) or observed bug symptoms (needs_fix).' },
        fixInstructions: { type: 'string', description: 'Required for needs_fix: concrete instructions for the executor — files, symptoms, reproduction, expected behavior.' },
        checklist: {
          type: 'array',
          description: 'Item-by-item verification of the requirement/acceptance list. Mandatory for complete; also useful for needs_fix (items marked failed/unverified become the fix list). Write it from YOUR OWN checks, not from the executor\'s claims.',
          items: {
            type: 'object',
            properties: {
              item: { type: 'string', description: 'The acceptance item being verified (short quote of the requirement).' },
              verified: { type: 'string', enum: ['done', 'failed', 'unverified'], description: 'done = reproduced by me and it passes; failed = reproduced and it fails; unverified = I could not reproduce it.' },
              evidence: { type: 'string', description: 'What I actually ran/observed: command + output snippet, file path + real content, HTTP status, screenshot path. Copying the executor\'s sentence is not evidence.' },
            },
            required: ['item', 'verified'],
          },
        },
      },
      required: ['verdict', 'summary'],
    },
    output: textOutput,
    async execute(args, exec) {
      const pair = resolvePair(args.pairId, exec.agent)
      if (bySupervisor.get(exec.agent?.id) !== pair && byWorker.get(exec.agent?.id) !== pair) {
        throw new Error(`caller session ${exec.agent?.id} does not belong to pair ${pair.id}`)
      }
      if (pair.state !== 'active') throw new Error(`pair ${pair.id} is already ${pair.state}`)
      if (!pair.busy) throw new Error(`no [监督评审] is in flight for ${pair.id}; stay idle until a review message arrives, then answer it with supervision_verdict`)
      const gate = checkVerdict(pair, args)
      if (!gate.ok) {
        recordReport('review', pair, { rejected: args.verdict, review: pair.reviews, problems: gate.problems.slice(0, 12), checklist: checklistText(args.checklist) })
        pushError(pair, `结论被打回：${gate.problems[0] ?? ''}`)
        warn(`verdict ${args.verdict} rejected (${pair.id}): ${gate.problems.join(' | ')}`)
        throw new Error(`【结论打回·反假完成门槛】${gate.problems.map((line, index) => `\n${index + 1}. ${line}`).join('')}\n\n请先自己把上面缺的证据跑出来（读文件/跑命令/请求 API），再重新调用 supervision_verdict：\n- complete：checklist 每项 verified="done" 且 evidence 写你亲自跑出的输出片段（命令+结果、路径+实际内容、HTTP 状态码）。\n- needs_fix：把没过的项写进 checklist（failed/unverified），并给出 fixInstructions。\n禁止凭执行会话的自述直接 complete。`)
      }
      if (args.verdict === 'complete') {
        pair.lastVerdict = args.verdict
        pair.lastSummary = args.summary
        pair.lastChecklist = gate.checklist
        pair.verdictSeen = true
        pair.consecutiveErrors = 0
        pair.state = 'complete'
        pair.phase = 'done'
        recordReport('verdict', pair, { verdict: 'complete', review: pair.reviews, summary: snippet(args.summary, 4000), checklist: checklistText(args.checklist) })
        releaseReview(pair)
        serialDeliver(pair, 'notice', pair.workerId, capMiddle(`【监督结论】评审通过，任务关闭。逐项验收依据：\n${capMiddle(checklistText(args.checklist), config.checklistNoteMaxChars, '验收依据')}\n\n结论摘要：${capMiddle(args.summary, config.fixSummaryMaxChars, '结论摘要')}`, config.deliverMaxChars, '结论通知')).catch((error) => warn('done notice failed', error))
        return { text: `结论已记录：complete（逐项核验 ${gate.checklist.length} 项全部有证据）。监督对 ${pair.id} 已关闭（自动评审停止）。请向客户简要汇报验收结论。` }
      }
      pair.lastVerdict = args.verdict
      pair.lastSummary = args.summary
      pair.lastChecklist = gate.checklist
      pair.verdictSeen = true
      pair.consecutiveErrors = 0
      releaseReview(pair)
      if (pair.fixRounds >= config.maxFixRounds) {
        halt(pair, `自动修复已达上限（${config.maxFixRounds} 轮）仍未通过评审。最新问题：${snippet(args.summary, 300)}`)
        return { text: 'needs_fix 已记录，但自动修复轮数达上限，监督对 ' + pair.id + ' 转入 halted，等待人工。' }
      }
      pair.fixRounds += 1
      pair.phase = 'fixing'
      recordReport('verdict', pair, { verdict: 'needs_fix', review: pair.reviews, fixRound: pair.fixRounds, summary: snippet(args.summary, 4000), fixInstructions: snippet(args.fixInstructions, 4000), checklist: checklistText(args.checklist) })
      const instruction = capMiddle([
        `【监督修复指令 #${pair.fixRounds}】监督者逐项复现后发现以下问题（下列每一条都必须整改并自证，缺一不可）：`,
        `症状：${capMiddle(args.summary, config.fixSummaryMaxChars, '症状（全文见 supervision_reports）')}`,
        `修复要求：${capMiddle(args.fixInstructions, config.fixInstrMaxChars, '修复要求（全文见 supervision_reports(需要审查) 的 verdict 记录）')}`,
        `监督逐项核验记录：\n${capMiddle(checklistText(args.checklist) || '（监督未提供逐项清单）', config.checklistNoteMaxChars, '核验记录')}`,
        `上下文互审：${sidePressureLine(pair, 'supervisor')}；${sidePressureLine(pair, 'worker')}。`,
        '请修复并完成必要验证后，再次调用 supervision_done 上报（摘要里逐项写「第 N 项：做了什么 + 真实输出」；一次上报全部修完的结果；修复前保持原任务上下文；不上报监督不会复查）。',
      ].filter(Boolean).join('\n'), config.deliverMaxChars, '整改指令')
      pair.lastFixRound = pair.fixRounds
      pair.lastFixSummary = args.summary
      pair.lastFixInstructions = args.fixInstructions
      pair.reportPending = 'fix'
      pair.reportAt = 0
      pair.nudgeAt = 0
      pair.lastTurnEndAt = 0
      pair.fixRequestId = undefined
      serialDeliver(pair, 'fix', pair.workerId, instruction)
        .then((requestId) => { pair.fixRequestId = requestId; pair.lastTurnEndAt = Date.now() })
        .catch((error) => warn('fix dispatch failed', error))
      return { text: `needs_fix 已排队发往执行会话（第 ${pair.fixRounds}/${config.maxFixRounds} 轮自动修复，串行送达）。执行会话修完再次上报后才有下一轮评审。` }
    },
  })

  ctx.tools.register({
    name: 'supervision_status',
    description: 'List supervision pairs and their live state: phase, both sides\' running flags (serial), review/fix rounds vs budgets, token pressure vs rollover limit, handover lineage, consecutive model-error counter, recent recorded errors.',
    parameters: {
      type: 'object',
      properties: {
        pairId: { type: 'string', description: 'One pair only; omit for all pairs.' },
      },
    },
    output: textOutput,
    execute(args) {
      nudgeQueuedDrains()
      const selected = args.pairId ? [resolvePair(args.pairId)] : [...pairs.values()]
      const trace = config.debugEnrollTrace === true ? enrollTrace.slice(-8) : []
      const traceText = trace.length ? `\n【自动纳入监督诊断】\n${trace.join('\n')}` : ''
      const pairingNote = `\n配对唯一性：${pairingIssues.length ? `已处理 ${pairingIssues.length} 次重复建对（${pairingIssues.slice(-3).map((row) => `${row.action}:${row.dropped.join('/')} -> 保留 ${row.kept}`).join('；')}）` : '当前无重复对（一个执行只对一个监督）'}；活体对 ${[...pairs.values()].filter((pair) => pair.state === 'active').length} 个，退休会话 ${retired.size} 个。`
      if (selected.length === 0) return { text: `当前没有监督对。用 supervision_start 创建，或 supervision_enroll 把本会话纳入监督；新会话首条消息写「${config.reviewTriggerPattern}」会自动建对。${traceText}${pairingNote}` }
      return { text: `${JSON.stringify(selected.map(pairView), null, 2)}${traceText}${pairingNote}` }
    },
  })

  ctx.tools.register({
    name: 'supervision_worker_log',
    description: 'Fetch a compact digest of the executor session log for review: customer inputs, executor replies, tool successes/failures, todo snapshots, turn endings. Use when the review message digest is not enough.',
    parameters: {
      type: 'object',
      properties: {
        pairId: { type: 'string', description: 'Supervision pair id.' },
        sinceSeq: { type: 'number', description: 'Start after this event seq; default 0 = whole log.' },
        maxLines: { type: 'number', description: 'Max digest lines to return (tail kept). Default 150.' },
      },
    },
    output: textOutput,
    async execute(args, exec) {
      const pair = resolvePair(args.pairId, exec.agent)
      const events = await workerEvents(pair)
      const since = typeof args.sinceSeq === 'number' ? args.sinceSeq : 0
      const lines = []
      for (let index = 0; index < events.length; index += 1) {
        const event = events[index]
        if (typeof event?.seq === 'number' && event.seq <= since) continue
        const line = digestLine(event, collectToolNames(events, index))
        if (line) lines.push(`#${event.seq} ${line}`)
      }
      const maxLines = Math.max(1, typeof args.maxLines === 'number' ? args.maxLines : 150)
      const kept = lines.slice(-maxLines)
      const body = `${lines.length > kept.length ? `…(更早 ${lines.length - kept.length} 行省略，可用 sinceSeq 往前取)\n` : ''}${kept.join('\n') || '(无记录)'}`
      // 这条工具的原文会整段进监督会话上下文：不限长就等于让评审自己把上下文撑爆。
      const shrunk = capMiddle(body, config.workerLogMaxChars, `日志摘录（要更早/更细的用 sinceSeq 分段取，或用 maxLines 少要一点）`)
      return { text: `${shrunk}${shrunk.length < body.length ? `\n\n[插件已按 ${config.workerLogMaxChars} 字预算裁剪，原 ${body.length} 字]` : ''}` }
    },
  })

  ctx.tools.register({
    name: 'supervision_stop',
    description: 'Stop supervising a pair: ends reviews and auto-fix dispatch. Both sessions stay open and usable (archiving/removing sessions is left to the user).',
    parameters: {
      type: 'object',
      properties: {
        pairId: { type: 'string', description: 'Supervision pair id; omit when only one pair exists.' },
      },
    },
    output: textOutput,
    execute(args, exec) {
      const pair = resolvePair(args.pairId, exec.agent)
      pair.state = 'stopped'
      pair.phase = 'stopped'
      recordReport('stopped', pair, {})
      stopPairSides(pair, '监督对已停止')
      releaseReview(pair)
      return { text: `监督对 ${pair.id} 已停止（执行 ${pair.workerId} / 监督 ${pair.supervisorId} 会话保留）。` }
    },
  })

  ctx.tools.register({
    name: 'supervision_requirement',
    description: 'Add/inspect acceptance criteria for a pair. Acceptance is the checklist the supervisor must independently reproduce at review time; it is injected verbatim into every later review. Only the customer (or the human driving this conversation) supplies it — this is what stops "self-reported success" from passing review.',
    parameters: {
      type: 'object',
      properties: {
        pairId: { type: 'string', description: 'Supervision pair id; omit when only one pair exists.' },
        acceptance: { type: 'array', items: { type: 'string' }, description: 'One line per checkable acceptance item, e.g. "GET /api/x returns 200 with non-empty JSON", "UI panel opens without console error". Must be observable, not aspirational.' },
        note: { type: 'string', description: 'Optional extra customer context appended to the requirement.' },
      },
    },
    output: textOutput,
    async execute(args, exec) {
      const pair = resolvePair(args.pairId, exec.agent)
      const items = Array.isArray(args.acceptance) ? args.acceptance.filter((line) => typeof line === 'string' && line.trim()) : []
      if (items.length === 0 && !args.note) return { text: `当前验收标准：\n${pair.currentRequirement}` }
      pair.requirements.push({ at: Date.now(), source: exec.agent?.id === pair.workerId ? 'worker' : 'human', acceptance: items, note: args.note ?? '' })
      if (items.length) pair.currentRequirement = `${pair.requirement}\n\n【验收清单】\n${items.map((line) => `- ${line}`).join('\n')}`
      if (args.note) pair.currentRequirement += `\n\n【客户补充】${args.note}`
      recordReport('requirement', pair, { acceptance: items, note: args.note ?? '', by: exec.agent?.id === pair.workerId ? 'worker' : 'human' })
      // Tell the executor too, so it aims at the checklist instead of its own guess.
      serialDeliver(pair, 'requirement', pair.workerId, `【客户更新验收标准】以下清单是监督评审核验的唯一标准，逐项做到并自证：\n${items.map((line) => `- ${line}`).join('\n')}${args.note ? `\n补充：${args.note}` : ''}`).catch(() => {})
      return { text: `验收标准已登记（下次评审起注入监督）。当前：\n${pair.currentRequirement}` }
    },
  })

  ctx.tools.register({
    name: 'supervision_feedback',
    description: 'Push an observed problem straight into the supervision loop: it lands in the durable journal as hard evidence and the next review treats it as an unconditional bug. Use it when the user reports something broken (blank UI, wrong output, crash) even if the executor session claims success.',
    parameters: {
      type: 'object',
      properties: {
        pairId: { type: 'string', description: 'Supervision pair id; omit when only one pair exists.' },
        problem: { type: 'string', description: 'What is broken, how to see it, and where (error text, screenshot path, URL).' },
      },
      required: ['problem'],
    },
    output: textOutput,
    async execute(args, exec) {
      const pair = resolvePair(args.pairId, exec.agent)
      recordReport('user-review', pair, { text: snippet(args.problem, 3000), by: exec.agent?.id ?? 'human' })
      scheduleReview(pair, { detail: `客户直接反馈问题（硬证据）：${snippet(args.problem, 240)}` }, 800)
      return { text: `已作为硬故障证据送入监督对 ${pair.id} 的评审回路${pair.busy ? '（当前评审进行中，下一轮必然包含）' : '，串行送审。'}` }
    },
  })

  // ---------------------------------------------------------------- report query

  function reportPayload(query = {}) {
    const limit = Math.min(pickNumber(query.limit, 300, 1), 2000)
    let events = journal.events.slice().reverse()
    if (query.pairId) events = events.filter((event) => event.pairId === query.pairId)
    if (query.kind) events = events.filter((event) => event.kind === query.kind)
    if (typeof query.text === 'string' && query.text) {
      const needle = query.text.toLowerCase()
      events = events.filter((event) => JSON.stringify(event).toLowerCase().includes(needle))
    }
    return {
      pairs: [...pairs.values()].map((pair) => ({
        pairId: pair.id,
        name: pair.name,
        state: pair.state,
        phase: pair.phase,
        auto: !!pair.auto,
        reportPending: pair.reportPending ?? null,
        workerRunning: pair.workerRunning,
        supervisorRunning: pair.supervisorRunning,
        workerSessionId: pair.workerId,
        supervisorSessionId: pair.supervisorId,
        reviews: pair.reviews,
        maxReviews: config.maxReviews,
        fixRounds: pair.fixRounds,
        maxFixRounds: config.maxFixRounds,
        handovers: pair.handovers,
        maxHandovers: config.maxHandovers,
        maxContextTokens: config.maxContextTokens,
        contextLimit: pressureOf(pair.workerId).limit,
        contextWindow: pressureOf(pair.workerId).window ?? null,
        contextCeiling: ceilingOf(pair.workerId) ?? ceilingOf(pair.supervisorId) ?? null,
        contextSource: pressureOf(pair.workerId).source,
        workerTokens: pressureOf(pair.workerId).tokens ?? pair.lastWorkerTokens ?? null,
        supervisorTokens: pressureOf(pair.supervisorId).tokens ?? pair.lastSupervisorTokens ?? null,
        overflowCount: pair.overflowCount ?? 0,
        lastVerdict: pair.lastVerdict,
        createdAt: pair.createdAt,
        lineage: pair.lineage,
        // 与工具面 pairView 同构（曾是 .map(row => row.previousId) -> 序列化成 [null]，面板拿不到会话）
        retiredSessions: retiredSides(pair),
        pairing: pairingSummary(pair),
      })),
      reports: events.slice(0, limit),
      total: journal.events.length,
    }
  }

  ctx.tools.register({
    name: 'supervision_reports',
    description: 'Query the durable review-report journal: pair creations, review rounds, verdicts (complete/needs_fix with summaries and fix instructions), context handovers, halts. Newest first, with optional filters.',
    parameters: {
      type: 'object',
      properties: {
        pairId: { type: 'string', description: 'Only events of one pair.' },
        kind: { type: 'string', enum: ['pair', 'review', 'verdict', 'handover', 'halted', 'stopped', 'client-error', 'user-review', 'requirement', 'pairing', 'overflow', 'delivery-trim', 'pressure-wall'], description: 'Only events of one kind（overflow=上下文溢出记录、delivery-trim=投递裁剪、pressure-wall=水位撞墙）.' },
        text: { type: 'string', description: 'Substring match against the whole event JSON (summary, instructions, requirement…).' },
        limit: { type: 'number', description: 'Max events, default 300.' },
      },
    },
    output: textOutput,
    execute(args) {
      const payload = reportPayload(args)
      return { text: JSON.stringify(payload, null, 2) }
    },
  })

  // HTTP API for the UI panel: GET = report/pair query, POST = browser-side
  // error uploads and customer feedback straight into the review loop.
  ctx.inject(['webServer'], (webCtx) => {
    let origin = ''
    try { origin = webCtx.webServer.getOrigin() } catch {}
    const readBody = (req) => new Promise((resolve) => {
      let raw = ''
      req.setEncoding('utf8')
      req.on('data', (chunk) => { raw += chunk; if (raw.length > 65536) { req.destroy(); resolve(null) } })
      req.on('end', () => { try { resolve(JSON.parse(raw || '{}')) } catch { resolve(null) } })
      req.on('error', () => resolve(null))
    })
    return webCtx.webServer.register({
      kind: 'exact',
      path: '/api/session-supervisor',
      async handler(req, res) {
        try {
          const requestOrigin = req.headers.origin
          if (requestOrigin && origin && requestOrigin !== origin) {
            res.writeHead(403, { 'content-type': 'application/json' })
            res.end('{"error":"cross-origin"}')
            return
          }
          if (req.method === 'POST') {
            const body = await readBody(req)
            if (!body) { res.writeHead(400, { 'content-type': 'application/json' }); res.end('{"error":"bad-json"}'); return }
            if (body.type === 'ui-error') {
              const pair = body.pairId ? pairs.get(body.pairId) : [...pairs.values()].find((candidate) => candidate.state === 'active') ?? null
              const event = recordReport('client-error', pair, { message: snippet(body.message, 800), stack: snippet(body.stack, 3000), pageUrl: snippet(body.pageUrl, 300), source: 'browser' })
              if (pair && pair.state === 'active') scheduleReview(pair, { detail: `浏览器错误自动上报（#${event.id}）：${snippet(body.message, 200)}` }, 800)
              res.writeHead(200, { 'content-type': 'application/json' })
              res.end(`{"ok":true,"id":${event.id}}`)
              return
            }
            if (body.type === 'ui-review' && typeof body.text === 'string' && body.text.trim()) {
              const pair = body.pairId ? pairs.get(body.pairId) : [...pairs.values()].filter((candidate) => candidate.state === 'active').sort((a, b) => b.createdAt - a.createdAt)[0] ?? null
              if (pair) {
                recordReport('user-review', pair, { text: snippet(body.text, 3000), by: 'ui' })
                scheduleReview(pair, { detail: `UI 面板客户反馈（硬证据）：${snippet(body.text, 200)}` }, 800)
                res.writeHead(200, { 'content-type': 'application/json' })
                res.end('{"ok":true}')
              } else {
                res.writeHead(404, { 'content-type': 'application/json' })
                res.end('{"error":"no-active-pair"}')
              }
              return
            }
            res.writeHead(400, { 'content-type': 'application/json' })
            res.end('{"error":"unknown-type"}')
            return
          }
          if (req.method !== 'GET') {
            res.writeHead(405, { 'content-type': 'application/json' })
            res.end('{"error":"method-not-allowed"}')
            return
          }
          const url = new URL(req.url ?? '/api/session-supervisor', 'http://127.0.0.1')
          const query = {
            pairId: url.searchParams.get('pairId') ?? undefined,
            kind: url.searchParams.get('kind') ?? undefined,
            text: url.searchParams.get('text') ?? undefined,
            limit: url.searchParams.get('limit') ? Number(url.searchParams.get('limit')) : undefined,
          }
          const body = JSON.stringify(reportPayload(query))
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(body)
        } catch (error) {
          warn('report api failed', error)
          try { res.writeHead(500, { 'content-type': 'application/json' }); res.end('{"error":"internal"}') } catch {}
        }
      },
    })
  })

  // v3: 重启 / 插件重转后从持久 journal 复原监督对（保持 1:1，不重复开会话）
  try {
    const { materialized, dropped } = hydratePairsFromJournal()
    if (materialized.length) warn(`pairing hydration: ${materialized.length} pair(s) restored, ${dropped} duplicate(s) dropped`)
  } catch (error) { warn('pair hydration failed', error) }
}
