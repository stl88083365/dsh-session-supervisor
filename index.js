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
 * Row config (raw passthrough, no schema):
 * { maxFixRounds: 3, reviewEnabled: true, digestMaxChars: 10000,
 *   maxContextTokens: 240000, maxHandovers: 8, maxReviews: 12,
 *   serialWaitMs: 1800000, reviewTurnTimeoutMs: 900000 }
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
  }

  const pairs = new Map()
  const byWorker = new Map()
  const bySupervisor = new Map()
  let rpcSeq = 0
  let pairSeq = 0
  let handoverSeq = 0

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
  const persistJournal = () => {
    if (journalTimer) return
    journalTimer = setTimeout(() => {
      journalTimer = null
      try { fs.writeFileSync(storeFile, JSON.stringify(journal)) } catch (error) { warn('report store write failed', error) }
    }, 300)
    if (journalTimer.unref) journalTimer.unref()
  }
  const recordReport = (kind, pair, data) => {
    const event = { id: (journal.seq += 1), at: Date.now(), kind, pairId: pair?.id ?? null, pairName: pair?.name ?? null, data: data ?? {} }
    journal.events.push(event)
    if (journal.events.length > 5000) journal.events = journal.events.slice(-4000)
    persistJournal()
    return event
  }
  ctx.effect(() => () => { if (journalTimer) { clearTimeout(journalTimer); journalTimer = null } try { fs.writeFileSync(storeFile, JSON.stringify(journal)) } catch {} })

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
      const ok = await waitPairIdle(pair)
      if (!ok) return
      await deliver(sessionId, tag, text)
      await sleep(1500)
    }
    serialTail = serialTail.then(run, run)
    return serialTail
  }

  async function deliver(sessionId, tag, text) {
    const requestId = `sup:${tag}:${Date.now().toString(36)}:${(rpcSeq += 1)}`
    // sessionController's Remote facade builds the durable user-rpc source itself; 2nd arg is the caller signal.
    await ctx.sessionController.prompt({ sessionId, content: [{ type: 'text', text }], requestId }, AbortSignal.timeout(30000))
  }

  async function createSession(cwd) {
    const created = await ctx.sessionController.create(cwd ? { cwd } : {})
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
    `5. 上下文约定：模型上限约 254k，达到 ${kTokens(config.maxContextTokens)} 插件自动开新执行会话接力（交接卡自包含），你无需整理上下文。`,
  ].join('\n')

  const supervisorCard = (pair) => [
    '【会话监督·角色卡】你是监督会话，只负责评审，绝不亲自写代码或执行任务。',
    `监督对：${pair.id}「${pair.name}」`,
    `执行会话 sessionId：${pair.workerId}`,
    '评审时机（重要）：执行会话【全部完成】并调用 supervision_done 后，插件才会把评审材料发来；中间步骤不会触发评审，你也不要在等待期间反复查询。',
    `串行约定：本地模型一次只跑一个会话。你给出结论（调用 supervision_verdict）并结束本轮后，插件才会把整改指令串行发回执行会话。`,
    '客户原始需求：\n' + pair.requirement,
    '评审协议：',
    '1. 收到 [监督评审] 消息时，结合内嵌的执行日志摘录判断完成情况；需要更多上下文用 supervision_worker_log。',
    '2. 每轮评审必须调用一次 supervision_verdict 收尾，这是你的唯一结论渠道：',
    '   - complete：需求全部满足且有验证证据；summary 写验收依据。',
    '   - needs_fix：存在 bug/未完成/验证缺失；summary 写症状，fixInstructions 写给执行会话的具体修复指令。',
    `3. 客户中途补充要求属正常输入，不算 bug；自动修复上限 ${config.maxFixRounds} 轮，评审总预算 ${config.maxReviews} 轮，超限插件自动熔断。`,
    '4. 允许的调用只有：supervision_verdict、supervision_worker_log、supervision_status。禁止 supervision_start / supervision_enroll / supervision_done（那是执行会话的上报渠道）。',
  ].join('\n')

  const handoverCard = (pair, side, summaryText) => [
    `【接力交接】监督对 ${pair.id}「${pair.name}」。因${side === 'worker' ? '执行' : '监督'}会话上下文达到 ${kTokens(config.maxContextTokens)} 上限，插件开启本会话接替上一${side === 'worker' ? '执行' : '监督'}会话（旧会话改名「已接力」保留追溯，其内容不必读取，以下材料已自包含）。`,
    '串行约定：本地模型一次只跑一个会话，插件按队列自动协调双方，你只需完成自己这一轮并正常结束。',
    side === 'worker'
      ? '你的职责：继续完成客户需求。先核对现场文件再动手，避免重做已完成部分；全部完成并验证后调用 supervision_done（附真实输出证据）。禁止调用 supervision_start / supervision_enroll。'
      : '你的职责：接替监督评审。只评审不执行；只有执行会话全部完成（supervision_done）后插件才会送评审材料，每轮评审必须以 supervision_verdict 收尾。禁止调用 supervision_start / supervision_enroll / supervision_done。',
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
    pushError(pair, `熔断：${reason}`)
    serialDeliver(pair, 'notice', pair.workerId, `【监督熔断】${reason}。自动流程已停止，等待客户/人工输入。`).catch(() => {})
    warn(`pair ${pair.id} halted: ${reason}`)
  }

  async function handoverIfNeeded(pair, side) {
    if (pair.state !== 'active') return false
    const sessionId = side === 'worker' ? pair.workerId : pair.supervisorId
    const tokens = contextTokens(sessionId)
    if (tokens === undefined || tokens < config.maxContextTokens) return false
    if (pair.handovers >= config.maxHandovers) {
      halt(pair, `上下文接力次数达到上限（${config.maxHandovers} 次），${side === 'worker' ? '执行' : '监督'}侧仍超过 ${kTokens(config.maxContextTokens)}`)
      return false
    }
    const previousId = sessionId
    const previousEvents = side === 'worker' ? await workerEvents(pair) : []
    const tail = digestLinesOf(previousEvents).slice(-40).join('\n')
    const number = (handoverSeq += 1)
    let newId
    try {
      newId = await createSession(pair.cwd ?? undefined)
    } catch (error) {
      warn(`handover create failed (${pair.id} ${side})`, error)
      return false
    }
    pair.handovers += 1
    pair.lineage.push({ side, number, previousId, newId, at: Date.now() })
    recordReport('handover', pair, { side, number, previousId, newId })
    if (side === 'worker') {
      byWorker.delete(previousId)
      pair.workerId = newId
      pair.cursor = 0
      byWorker.set(newId, pair)
      setTitle(newId, `执行#${number}｜${pair.name}`)
    } else {
      bySupervisor.delete(previousId)
      pair.supervisorId = newId
      bySupervisor.set(newId, pair)
      setTitle(newId, `监督#${number}｜${pair.name}`)
    }
    setTitle(previousId, side === 'worker' ? `执行#${number}（已接力）｜${pair.name}` : `监督#${number}（已接力）｜${pair.name}`)
    await serialDeliver(pair, 'handover', newId, handoverCard(pair, side, tail || '（无摘录）'))
    warn(`handover #${number} (${side}) ${previousId} -> ${newId}`)
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
    const text = [
      `[监督评审 #${pair.reviews}] 监督对 ${pair.id}「${pair.name}」`,
      `触发：${trigger || '人工触发评审'}`,
      `执行会话当前：${pair.workerRunning ? '运行中' : '空闲'}；累计自动修复 ${pair.fixRounds}/${config.maxFixRounds} 轮；评审预算 ${pair.reviews}/${config.maxReviews}。`,
      `上下文互审：执行侧 ≈${kTokens(workerTokens)}，监督侧 ≈${kTokens(supervisorTokens)}（上限 ${kTokens(config.maxContextTokens)}，达线自动接力）。${pair.handovers > 0 ? `已接力 ${pair.handovers} 次。` : ''}`,
      handoverNote,
      errorNote,
      '--- 执行日志摘录（自上次评审）---',
      digest.text || '（无新增记录）',
      '--- 摘录结束 ---',
      `请按角色卡协议评审，并必须调用 supervision_verdict(pairId="${pair.id}") 给出 complete 或 needs_fix 结论；needs_fix 必须填写 fixInstructions。需要更早历史用 supervision_worker_log(pairId="${pair.id}")。不要自己执行任务，不要创建新监督对。`,
    ].filter(Boolean).join('\n')
    await serialDeliver(pair, 'review', pair.supervisorId, text)
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
      if (reason.kind === 'error') {
        // Record only: no review before supervision_done. A dead model repeated
        // enough times still deserves a halt.
        pushError(pair, `轮结束·错误 ${reason.error?.message ?? ''}`)
        noteModelError(pair)
      }
      return
    }
    if (event?.type === 'tool/result') {
      const error = toolResultError(event.data)
      if (error) pushError(pair, `工具失败 ${error.name ?? ''} ${error.code ?? ''} ${error.message ?? ''}`)
    }
  }

  function onSupervisorEvent(pair, event) {
    if (event?.type !== 'turn/end' || !pair.busy) return
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

  ctx.on('session/event', function (session, event) {
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

  // Watchdog: unstick a hung review turn (single-slot model must not be held forever).
  ctx.timer.interval(() => {
    const now = Date.now()
    for (const pair of pairs.values()) {
      if (pair.state !== 'active') continue
      if (
        config.reviewTurnTimeoutMs > 0 && pair.busy && pair.supervisorRunning
        && pair.supervisorRunningSince && now - pair.supervisorRunningSince > config.reviewTurnTimeoutMs
      ) {
        pair.supervisorRunningSince = 0
        pushError(pair, `监督评审轮超过 ${Math.round(config.reviewTurnTimeoutMs / 60000)} 分钟未结束，插件已中止该轮（防串行死等）`)
        try { ctx.agents.get(pair.supervisorId)?.cancel({ kind: 'user', reason: 'session-supervisor review timeout' }) } catch (error) { warn('supervisor cancel failed', error) }
      }
    }
  }, 30000)

  // ---------------------------------------------------------------- pair ops

  function assertNotInAnyPair(agent) {
    if (!agent) return
    if (byWorker.get(agent.id) || bySupervisor.get(agent.id)) {
      throw new Error('this session is already part of a supervision pair; roles must not create new pairs (use supervision_verdict / supervision_worker_log only)')
    }
    for (const pair of pairs.values()) {
      if (pair.workerId === agent.id || pair.supervisorId === agent.id) throw new Error('this session belongs to a supervision pair; roles must not create new pairs')
    }
  }

  async function startPair({ name, requirement, cwd, workerSessionId }) {
    const workerId = workerSessionId ?? await createSession(cwd)
    const supervisorId = await createSession(cwd)
    const pair = {
      id: `sup-${(pairSeq += 1)}-${Date.now().toString(36).slice(-5)}`,
      name: snippet(name || requirement, 40),
      requirement,
      cwd: cwd ?? null,
      workerId,
      supervisorId,
      state: 'active',
      phase: 'working',
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
      createdAt: Date.now(),
      lastVerdict: null,
      lastSummary: null,
      lastDoneSummary: null,
      lastWorkerTokens: undefined,
      lastSupervisorTokens: undefined,
      handovers: 0,
      lineage: [],
      consecutiveErrors: 0,
    }
    pairs.set(pair.id, pair)
    byWorker.set(pair.workerId, pair)
    bySupervisor.set(pair.supervisorId, pair)
    recordReport('pair', pair, { cwd: pair.cwd, workerId, supervisorId, requirement: snippet(requirement, 2000) })
    setTitle(workerId, `执行｜${pair.name}`)
    setTitle(supervisorId, `监督｜${pair.name}`)
    serialDeliver(pair, 'card', supervisorId, supervisorCard(pair)).catch((error) => warn('supervisor card delivery failed', error))
    serialDeliver(pair, 'requirement', workerId, `${workerCard(pair)}\n\n【客户原始需求】\n${requirement}`).catch((error) => warn('requirement delivery failed', error))
    return pair
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
        name: { type: 'string', description: 'Short human-readable task label for both sessions.' },
        cwd: { type: 'string', description: 'Workspace directory for both sessions; defaults to the caller working directory.' },
      },
      required: ['requirement'],
    },
    output: textOutput,
    async execute(args, exec) {
      assertNotInAnyPair(exec.agent)
      const cwd = args.cwd ?? ctx.get('workingDirectory')?.get?.(exec.agent?.session) ?? undefined
      const pair = await startPair({ name: args.name, requirement: args.requirement, cwd })
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
    description: 'Enroll the CURRENT session as the executor of a new supervision pair: a supervisor session is created and reviews this session only after it reports everything done. Use when the user asks to put this very conversation under supervision (also re-arms supervision after a host restart).',
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
      assertNotInAnyPair(agent)
      const requirement = args.requirement ?? '(调用方未单独给出：监督者请从执行会话自身日志判断客户需求是否完成。)'
      const pair = await startPair({
        name: args.name,
        requirement,
        cwd: ctx.get('workingDirectory')?.get?.(agent.session) ?? undefined,
        workerSessionId: agent.id,
      })
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
      const pair = byWorker.get(exec.agent?.id)
      if (!pair) throw new Error('only an enrolled executor session may call supervision_done (start or enroll supervision first)')
      if (pair.state !== 'active') throw new Error(`pair ${pair.id} is ${pair.state}; no review will run`)
      pair.lastDoneSummary = args.summary
      pair.consecutiveErrors = 0
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

  ctx.tools.register({
    name: 'supervision_verdict',
    description: 'Supervisor-side review verdict; the ONLY valid end of a [监督评审] review turn. complete closes the pair; needs_fix queues the fix instructions for serial dispatch back to the executor (bounded by maxFixRounds).',
    parameters: {
      type: 'object',
      properties: {
        pairId: { type: 'string', description: 'Supervision pair id from the review message.' },
        verdict: { type: 'string', enum: ['complete', 'needs_fix'], description: 'complete = requirement fully met; needs_fix = bugs or gaps found.' },
        summary: { type: 'string', description: 'Acceptance evidence (complete) or observed bug symptoms (needs_fix).' },
        fixInstructions: { type: 'string', description: 'Required for needs_fix: concrete instructions for the executor — files, symptoms, reproduction, expected behavior.' },
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
      pair.lastVerdict = args.verdict
      pair.lastSummary = args.summary
      pair.verdictSeen = true
      pair.consecutiveErrors = 0
      if (args.verdict === 'complete') {
        pair.state = 'complete'
        pair.phase = 'done'
        recordReport('verdict', pair, { verdict: 'complete', review: pair.reviews, summary: snippet(args.summary, 4000) })
        releaseReview(pair)
        serialDeliver(pair, 'notice', pair.workerId, `【监督结论】评审通过，任务关闭。验收依据：${args.summary}`).catch((error) => warn('done notice failed', error))
        return { text: `结论已记录：complete。监督对 ${pair.id} 已关闭（自动评审停止）。请向客户简要汇报验收结论。` }
      }
      if (!args.fixInstructions) throw new Error('needs_fix requires concrete fixInstructions for the executor')
      releaseReview(pair)
      if (pair.fixRounds >= config.maxFixRounds) {
        halt(pair, `自动修复已达上限（${config.maxFixRounds} 轮）仍未通过评审。最新问题：${snippet(args.summary, 300)}`)
        return { text: `needs_fix 已记录，但自动修复轮数达上限，监督对 ${pair.id} 转入 halted，等待人工。` }
      }
      pair.fixRounds += 1
      pair.phase = 'fixing'
      recordReport('verdict', pair, { verdict: 'needs_fix', review: pair.reviews, fixRound: pair.fixRounds, summary: snippet(args.summary, 4000), fixInstructions: snippet(args.fixInstructions, 4000) })
      const instruction = [
        `【监督修复指令 #${pair.fixRounds}】监督者评审发现以下问题：`,
        `症状：${args.summary}`,
        `修复要求：${args.fixInstructions}`,
        `上下文互审：监督侧 ≈${kTokens(pair.lastSupervisorTokens)}，执行侧 ≈${kTokens(pair.lastWorkerTokens)}（上限 ${kTokens(config.maxContextTokens)}）。`,
        '请修复并完成必要验证后，再次调用 supervision_done 上报（一次上报全部修完的结果；修复前保持原任务上下文）。',
      ].join('\n')
      serialDeliver(pair, 'fix', pair.workerId, instruction).catch((error) => warn('fix dispatch failed', error))
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
      if (selected.length === 0) return { text: '当前没有监督对。用 supervision_start 创建，或 supervision_enroll 把本会话纳入监督。' }
      return { text: JSON.stringify(selected.map(pairView), null, 2) }
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
      releaseReview(pair)
      return { text: `监督对 ${pair.id} 已停止（执行 ${pair.workerId} / 监督 ${pair.supervisorId} 会话保留）。` }
    },
  })

  // ---------------------------------------------------------------- report query

  function reportPayload(query = {}) {
    const limit = pickNumber(query.limit, 300, 1)
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
        kind: { type: 'string', enum: ['pair', 'review', 'verdict', 'handover', 'halted', 'stopped'], description: 'Only events of one kind.' },
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

  // HTTP read API for the UI panel (same-origin only, like other plugin APIs).
  ctx.inject(['webServer'], (webCtx) => {
    let origin = ''
    try { origin = webCtx.webServer.getOrigin() } catch {}
    return webCtx.webServer.register({
      kind: 'exact',
      path: '/api/session-supervisor',
      handler(req, res) {
        try {
          const requestOrigin = req.headers.origin
          if (requestOrigin && origin && requestOrigin !== origin) {
            res.writeHead(403, { 'content-type': 'application/json' })
            res.end('{"error":"cross-origin"}')
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
}
