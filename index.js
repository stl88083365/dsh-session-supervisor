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
 * Context rollover: both sides' token pressure (tokenMeter.contextPressure) is
 * measured when both are idle; at/above maxContextTokens the plugin mints a
 * fresh successor session (same Workspace), serially delivers a self-contained
 * handover card (role + requirement + progress + recent log tail), and renames
 * the old session with "（已接力）". Lineage stays in supervision_status.
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
 * { maxFixRounds: 3, reviewEnabled: true, digestMaxChars: 10000,
 *   maxContextTokens: 240000, maxHandovers: 8, maxReviews: 12,
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

export function apply(ctx, rawConfig = {}) {
  const config = {
    maxFixRounds: pickNumber(rawConfig?.maxFixRounds, 3, 1),
    reviewEnabled: rawConfig?.reviewEnabled !== false,
    digestMaxChars: pickNumber(rawConfig?.digestMaxChars, 10000, 500),
    maxContextTokens: pickNumber(rawConfig?.maxContextTokens, 240000, 1000),
    maxHandovers: pickNumber(rawConfig?.maxHandovers, 8, 1),
    maxReviews: pickNumber(rawConfig?.maxReviews, 12, 2),
    serialWaitMs: pickNumber(rawConfig?.serialWaitMs, 1800000, 5000),
    reviewTurnTimeoutMs: pickNumber(rawConfig?.reviewTurnTimeoutMs, 900000, 30000),
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
    retiredNoticeMs: pickNumber(rawConfig?.retiredNoticeMs, 300000, 0),
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

  /** Live token pressure of one session; undefined when the session is cold or unmeasured. */
  function contextTokens(sessionId) {
    try {
      const session = ctx.sessions.get(sessionId)
      if (session === undefined) return undefined
      return ctx.get('tokenMeter')?.contextPressure?.(session)?.pressureTokens
    } catch {
      return undefined
    }
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

  const pairIdle = (pair) => pair.workerRunning === false && pair.supervisorRunning === false

  async function waitPairIdle(pair) {
    const deadline = Date.now() + config.serialWaitMs
    while (!pairIdle(pair)) {
      if (pair.state === 'stopped') return false
      if (Date.now() > deadline) {
        warn(`serial gate timed out (${pair.id}); delivering anyway (worker=${pair.workerRunning}, supervisor=${pair.supervisorRunning})`)
        return true
      }
      await sleep(2000)
    }
    return true
  }

  /** The turnstile: one plugin delivery at a time, pair fully idle, never concurrent model use. */
  function serialDeliver(pair, tag, sessionId, text) {
    const run = async () => {
      if (pair.state === 'stopped' && tag !== 'notice') return
      // v3 投递前一致性检查：会话已被接力退休 / 已不属于本对（重复对）时不再投递，
      // 避免旧会话被唤醒 —— 这是「老会话停止运行」的硬保证。
      const why = deliveryBlocker(pair, sessionId, tag)
      if (why) { warn(`skip ${tag} delivery -> ${sessionId} (${why})`); return }
      const ok = await waitPairIdle(pair)
      if (!ok) return undefined
      const requestId = await deliver(sessionId, tag, text)
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
    `5. 上下文约定：模型上限约 254k，达到 ${kTokens(config.maxContextTokens)} 插件会自动把你接力到新的执行会话（交接卡自包含，本会话同时停止运行），你无需整理上下文；本监督对始终只有你一个活体执行会话，监督会话也只有一个。`,
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
    '客户原始需求：\n' + pair.requirement,
    '评审协议：',
    '1. 收到 [监督评审] 消息时，结合内嵌的执行日志摘录判断完成情况；需要更多上下文用 supervision_worker_log。',
    '2. 评审对象必须是【交付物本身与运行时证据】，不是执行会话的自述：验收清单逐项由你亲自复现（读文件、跑命令、请求 API、查注册）；凡日志里说成功而你无法复核、或复核不过的，一律 needs_fix。',
    '3. 评审材料里的【硬故障证据】（浏览器上报错误/客户直接反馈）是无条件 bug：只要存在未解决记录，禁止 complete。',
    '4. 【反假完成·硬门槛】supervision_verdict 必须带 checklist：把需求/验收清单拆成条目，每条给你【亲自执行过的】核验命令或路径与核验结果（verified: done/failed/unverified + evidence）。',
    '   - 证据必须是你自己跑出来的（命令输出、文件真实内容与行数、HTTP 状态码、页面截图路径），不是执行会话的原话；照抄对方摘要 = 该条未核验。',
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

  const handoverCard = (pair, side, summaryText) => [
    `【接力交接】监督对 ${pair.id}「${pair.name}」。因${side === 'worker' ? '执行' : '监督'}会话上下文达到 ${kTokens(config.maxContextTokens)} 上限，插件开启本会话接替上一${side === 'worker' ? '执行' : '监督'}会话（旧会话改名「已接力」保留追溯，其内容不必读取，以下材料已自包含）。`,
    '串行约定：本地模型一次只跑一个会话，插件按队列自动协调双方，你只需完成自己这一轮并正常结束。',
    side === 'worker'
      ? '你的职责：继续完成客户需求。先核对现场文件再动手，避免重做已完成部分；全部完成并验证后调用 supervision_done（附真实输出证据）；不上报监督永远不会启动。禁止调用 supervision_start / supervision_enroll。'
      : '你的职责：接替监督评审。只评审不执行；只有执行会话全部完成（supervision_done）后插件才会送评审材料，每轮评审必须以 supervision_verdict（带逐项 checklist 与亲自核验证据）收尾。禁止调用 supervision_start / supervision_enroll / supervision_done。',
    '——— 交接材料 ———',
    `原始需求：\n${pair.requirement}`,
    `对账状态：已评审 ${pair.reviews} 轮，自动修复 ${pair.fixRounds}/${config.maxFixRounds} 轮，上一次结论 ${pair.lastVerdict ?? '（无）'}${pair.lastSummary ? `\n上次结论摘要：${snippet(pair.lastSummary, 1200)}` : ''}`,
    side === 'worker' && pair.lastDoneSummary ? `上次完成上报摘要：${snippet(pair.lastDoneSummary, 800)}` : '',
    side === 'worker' ? `工作目录：${pair.cwd ?? '（默认）'}` : `执行会话 sessionId：${pair.workerId}`,
    '——— 最近执行日志摘录 ———',
    summaryText,
  ].join('\n')

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

  async function handoverIfNeeded(pair, side) {
    if (pair.state !== "active") return false
    const role = side === "worker" ? "worker" : "supervisor"
    const previousId = role === "worker" ? pair.workerId : pair.supervisorId
    const tokens = contextTokens(previousId)
    if (tokens === undefined || tokens < config.maxContextTokens) return false
    pair.rolling = pair.rolling ?? new Set()
    if (pair.rolling.has(role)) { warn("handover already in flight (" + pair.id + " " + role + ")"); return false }
    if (pair.handovers >= config.maxHandovers) {
      halt(pair, "上下文接力次数达到上限（" + config.maxHandovers + " 次），" + (role === "worker" ? "执行" : "监督") + "侧仍超过 " + kTokens(config.maxContextTokens))
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
      const tail = digestLinesOf(previousEvents).slice(-40).join("\n")
      pair.handovers += 1
      const lineageRow = { side: role, number, previousId, newId, at: Date.now(), stopped: false }
      pair.lineage.push(lineageRow)
      recordReport("handover", pair, { side: role, number, previousId, newId })
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
      const delivered = await serialDeliver(pair, "handover", newId, handoverCard(pair, role, tail || "（无摘录）"))
      if (!delivered) warn("handover card delivery skipped (" + pair.id + " " + role + ")")
      // 接力会话同时补送完整角色卡（执行纪律 / 监督评审协议），否则新会话只有一张交接卡，
      // 拿不到「只能调 supervision_verdict / 完成后调 supervision_done」这类硬约束。
      else serialDeliver(pair, role === "worker" ? "worker-card" : "supervisor-card", newId, role === "worker" ? workerCard(pair) : supervisorCard(pair))
        .then((ok) => { if (!ok) warn("role card after handover skipped (" + pair.id + " " + role + ")") })
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
    await waitPairIdle(pair)
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
    const workerTokens = contextTokens(pair.workerId)
    const supervisorTokens = contextTokens(pair.supervisorId)
    pair.lastWorkerTokens = workerTokens
    pair.lastSupervisorTokens = supervisorTokens
    // 未决浏览器错误（UI 崩溃这类日志外的故障由 client 上报回评审回路）
    let errorScanAt = pair.lastErrorScanAt
    const uiErrors = journal.events
      .filter((event) => (event.kind === 'client-error' || event.kind === 'user-review') && event.at > errorScanAt && (!event.pairId || event.pairId === pair.id))
      .slice(-6)
    pair.lastErrorScanAt = Date.now()
    const uiErrorNote = uiErrors.length
      ? `【硬故障证据·必须处理】未解决的上报错误（浏览器/客户直接反馈，属于必须评审的 bug，逐条在 verdict summary 回应）：\n${uiErrors.map((event) => `- [${new Date(event.at).toLocaleString()}] ${snippet(event.kind === 'user-review' ? event.data?.text : `${event.data?.message} @ ${event.data?.pageUrl || ''}\n${event.data?.stack || ''}`, 500)}`).join('\n')}`
      : ''
    const acceptanceNote = pair.requirements.length > 1 || pair.currentRequirement.includes('【验收清单】')
      ? `验收标准（逐项实际复现核验：文件真实存在/命令输出一致/API 返回正常/页面可打开，跳过任何一项都判 needs_fix）：\n${pair.currentRequirement}`
      : (pair.auto
        ? `原始需求（自动纳入监督：请先把它拆成可核验的验收条目，再逐条实际复现——文件真实存在/命令输出一致/API 返回正常/页面可打开；凡是复现不了或复现不过的都判 needs_fix）：\n${pair.currentRequirement}`
        : '')
    const forcedNote = pair.forcedReviewAt
      ? `【强制送审】执行会话空闲后没有调用 supervision_done，插件按现有现场强制送审。请把「没有自证完成」本身当成一条未通过项，逐项复现交付物后给结论；不要接受任何口头完成声明。`
      : ''
    const previousFixNote = pair.lastVerdict === 'needs_fix' && pair.lastFixInstructions
      ? `【上一条整改 #${pair.lastFixRound ?? pair.fixRounds} 必须复查】\n症状：${snippet(pair.lastFixSummary, 800)}\n要求：${snippet(pair.lastFixInstructions, 1500)}\n上一轮核验记录：\n${checklistText(pair.lastChecklist) || '（无）'}\n本轮 checklist 必须逐条给出这些项的最新结论（item 文案保持一致，插件会据此校验覆盖率）。`
      : ''
    const checklistNote = [
      `【逐项核验硬门槛】supervision_verdict 必须带 checklist：每条 = {item, verified: done|failed|unverified, evidence}。`,
      `证据只能来自你自己执行的核验（命令+真实输出片段、文件路径+实际内容、HTTP 状态、截图/日志路径）；照抄执行会话的「已完成」= 该条 unverified。`,
      `complete 的前置条件：${config.completeSummaryMinChars} 字以上的结论 + checklist 全部 done 且都有证据；做不到的项只能 needs_fix（插件会打回不合格结论）。`,
    ].join('\n')
    const text = [
      `[监督评审 #${pair.reviews}] 监督对 ${pair.id}「${pair.name}」`,
      `触发：${trigger || '人工触发评审'}`,
      `执行会话当前：${pair.workerRunning ? '运行中' : '空闲'}；累计自动修复 ${pair.fixRounds}/${config.maxFixRounds} 轮；评审预算 ${pair.reviews}/${config.maxReviews}。`,
      `上下文互审：执行侧 ≈${kTokens(workerTokens)}，监督侧 ≈${kTokens(supervisorTokens)}（上限 ${kTokens(config.maxContextTokens)}，达线自动接力）。${pair.handovers > 0 ? `已接力 ${pair.handovers} 次。` : ''}`,
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
    ].filter(Boolean).join('\n')
    pair.lastSupervisorHand = Date.now()
    pair.supervisorIdleSince = 0
    pair.reviewRequestId = await serialDeliver(pair, 'review', pair.supervisorId, text)
    recordReport('review', pair, { review: pair.reviews, trigger, digestChars: (digest.text || '').length, workerId: pair.workerId, supervisorId: pair.supervisorId, workerTokens: workerTokens ?? null, supervisorTokens: supervisorTokens ?? null })
  }

  function releaseReview(pair) {
    pair.busy = false
    if (pair.recheckAfterBusy) { pair.recheckAfterBusy = false; scheduleReview(pair, { detail: '评审期间执行会话又有新的完成上报' }, 600) }
  }

  function pushError(pair, line) {
    pair.recentErrors = [...pair.recentErrors, snippet(line, 300)].slice(-8)
  }

  function noteModelError(pair) {
    pair.consecutiveErrors += 1
    if (pair.consecutiveErrors >= 3) halt(pair, `连续 ${pair.consecutiveErrors} 次模型错误（本地模型可能断联），自动流程停止，恢复后人工继续`)
  }

  // ---------------------------------------------------------------- events

  function onWorkerEvent(pair, event) {
    if (pair.state !== 'active') return
    pair.lastActivity = Date.now()
    if (event?.type === 'turn/end') {
      const reason = event.data?.reason ?? {}
      pair.lastTurnEndAt = Date.now()
      touchJournal(pair)
      // 上下文达线：不等上报，也在空闲点把执行会话接力到新会话（老会话随即停止运行）
      const pressure = contextTokens(pair.workerId) ?? 0
      if (pressure >= config.maxContextTokens && pairIdle(pair)) {
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
    if (event?.type !== 'turn/end') return
    pair.supervisorIdleSince = Date.now()
    if (!pair.busy) return
    const reason = event.data?.reason ?? {}
    if (reason.kind === 'error' && !pair.verdictSeen) {
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
    if (pair) onSupervisorEvent(pair, event)
  })

  ctx.on('agent/status', function (payload) {
    const running = payload?.status === 'running'
    const worker = byWorker.get(payload?.agent?.id)
    if (worker) {
      if (running && !worker.workerRunning) worker.workerRunningSince = Date.now()
      worker.workerRunning = running
      if (running) worker.lastActivity = Date.now()
      return
    }
    const supervisor = bySupervisor.get(payload?.agent?.id)
    if (supervisor) {
      if (running && !supervisor.supervisorRunning) supervisor.supervisorRunningSince = Date.now()
      supervisor.supervisorRunning = running
    }
  })

  ctx.on('agent/error', function (payload) {
    const pair = byWorker.get(payload?.agent?.id)
    if (!pair || pair.state !== 'active') return
    pushError(pair, `agent/error turn=${payload.turn} step=${payload.step} ${payload.error?.message ?? payload.error}`)
    noteModelError(pair)
  })

  // Watchdog: unstick a hung review turn (single-slot model must not be held forever),
  // and make sure an executor that stops talking without reporting done still gets
  // reviewed: nudge once, then force a review after idleForceReviewMs.
  ctx.timer.interval(() => {
    const now = Date.now()
    for (const pair of pairs.values()) {
      if (pair.state !== 'active') continue
      // v3 空闲点接力：任一侧水位达线且双方都不在跑模型，就换会话（评审期间的接力在 runReview 内）
      if (config.reviewEnabled && !pair.busy && !pair.reviewTimerOn && pairIdle(pair)
        && (!pair.lastHandoverAt || now - pair.lastHandoverAt > config.rolloverCooldownMs)) {
        const over = contextTokens(pair.workerId) ?? 0
        const overSupervisor = contextTokens(pair.supervisorId) ?? 0
        if (over >= config.maxContextTokens || overSupervisor >= config.maxContextTokens) {
          handoverIfNeeded(pair, over >= config.maxContextTokens ? 'worker' : 'supervisor')
            .catch((error) => warn('idle rollover failed', error))
        }
      }
      const handAt = Math.max(pair.supervisorIdleSince ?? 0, pair.lastSupervisorHand ?? 0)
      if (
        config.reviewTurnTimeoutMs > 0 && pair.busy
        && handAt && now - handAt > config.reviewTurnTimeoutMs
      ) {
        pair.supervisorRunningSince = 0
        pushError(pair, `监督评审轮超过 ${Math.round(config.reviewTurnTimeoutMs / 60000)} 分钟未结束，插件已中止该轮（防串行死等）`)
        try { ctx.agents.get(pair.supervisorId)?.cancel({ kind: 'user', reason: 'session-supervisor review timeout' }) } catch (error) { warn('supervisor cancel failed', error) }
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
      lastFixRound: 0,
      lastFixSummary: null,
      lastFixInstructions: null,
      // v3 接力 / 交接 / 配对唯一性记账
      reviewRequestId: undefined,
      fixRequestId: undefined,
      supervisorIdleSince: 0,
      lastSupervisorHand: 0,
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
    workerSessionId: pair.workerId,
    supervisorSessionId: pair.supervisorId,
    context: {
      worker: contextTokens(pair.workerId) ?? pair.lastWorkerTokens ?? null,
      supervisor: contextTokens(pair.supervisorId) ?? pair.lastSupervisorTokens ?? null,
      limit: config.maxContextTokens,
      handovers: `${pair.handovers}/${config.maxHandovers}`,
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
          `熔断：修复上限 ${config.maxFixRounds} 轮、评审预算 ${config.maxReviews}、接力上限 ${config.maxHandovers}、连续 3 次模型错误自动停止。`,
          `上下文：双方水位达 ${kTokens(config.maxContextTokens)} 自动开新会话接力（交接卡自包含）。`,
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
      return { text: `当前会话已纳入监督：${pair.id}\n监督会话：${pair.supervisorId}\n全部完成时调用 supervision_done 才触发评审。` }
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
        serialDeliver(pair, 'notice', pair.workerId, `【监督结论】评审通过，任务关闭。逐项验收依据：\n${checklistText(args.checklist)}\n\n结论摘要：${args.summary}`).catch((error) => warn('done notice failed', error))
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
      const instruction = [
        `【监督修复指令 #${pair.fixRounds}】监督者逐项复现后发现以下问题（下列每一条都必须整改并自证，缺一不可）：`,
        `症状：${args.summary}`,
        `修复要求：${args.fixInstructions}`,
        `监督逐项核验记录：\n${checklistText(args.checklist) || '（监督未提供逐项清单）'}`,
        `上下文互审：监督侧 ≈${kTokens(pair.lastSupervisorTokens)}，执行侧 ≈${kTokens(pair.lastWorkerTokens)}（上限 ${kTokens(config.maxContextTokens)}）。`,
        '请修复并完成必要验证后，再次调用 supervision_done 上报（摘要里逐项写「第 N 项：做了什么 + 真实输出」；一次上报全部修完的结果；修复前保持原任务上下文；不上报监督不会复查）。',
      ].join('\n')
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
      return { text: `${lines.length > kept.length ? `…(更早 ${lines.length - kept.length} 行省略)\n` : ''}${kept.join('\n') || '(无记录)'}` }
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
        workerTokens: contextTokens(pair.workerId) ?? pair.lastWorkerTokens ?? null,
        supervisorTokens: contextTokens(pair.supervisorId) ?? pair.lastSupervisorTokens ?? null,
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
        kind: { type: 'string', enum: ['pair', 'review', 'verdict', 'handover', 'halted', 'stopped', 'client-error', 'user-review', 'requirement', 'pairing'], description: 'Only events of one kind.' },
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
