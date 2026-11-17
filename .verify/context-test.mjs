// 上下文防爆回归（fake ctx，不碰宿主）: node .verify/context-test.mjs
// 覆盖 2026-11-15「爆上下文」事故的四条修复：零 usage 也能量出水面、阈值跟窗口、
// 溢出错误紧急接力不熔断、投递按预算裁剪 + worker_log 封顶。
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { pathToFileURL, fileURLToPath } from "node:url"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const SRC = path.join(ROOT, "index.js")
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function fakeHost(profile) {
  fs.rmSync(profile, { recursive: true, force: true })
  fs.mkdirSync(profile, { recursive: true })
  process.env.DSH_PROFILE_DIR = profile
  const host = { sessions: new Map(), tools: new Map(), handlers: new Map(), created: [], prompts: [], cancels: [], agents: new Map(), pressure: new Map(), titles: new Map(), logs: [] }
  const emit = (name, ...args) => { for (const handler of host.handlers.get(name) ?? []) { try { handler(...args) } catch (error) { host.logs.push("handler " + name + " threw " + error) } } }
  const makeSession = (cwd) => {
    const id = "session-" + host.created.length + "-" + Math.random().toString(36).slice(2, 8)
    const session = { id, cwd: cwd ?? null, events: [], seq: 0 }
    host.sessions.set(id, session); host.created.push(id)
    return session
  }
  /** 水位桩：provider=pressureTokens（不报 usage 时给 undefined），measure=tokenMeter.measure 总量 */
  host.setPressure = (id, value) => host.pressure.set(id, typeof value === "number" ? { measure: value } : value)
  host.finishTurn = (id, reason = {}) => {
    const agent = host.agents.get(id)
    if (agent) agent.running = false
    emit("agent/status", { agent: { id }, status: "idle" })
    const session = host.sessions.get(id)
    if (session) emit("session/event", session, { type: "turn/end", seq: (session.seq += 1), data: { reason } })
  }
  const meterStub = {
    contextPressure: (session) => {
      const p = host.pressure.get(session?.id) ?? {}
      const out = {}
      if (p.provider !== undefined) out.pressureTokens = p.provider
      if (p.window !== undefined) out.contextWindow = p.window
      return out
    },
    measure: (session) => {
      const p = host.pressure.get(session?.id) ?? {}
      if (p.measure === undefined) return undefined
      return { totalTokens: p.measure, baseline: { kind: p.baselineKind ?? "estimated" }, surfaceTokens: p.measure, surfaceDeltaTokens: 0 }
    },
    estimateMessage: (message) => Math.ceil(JSON.stringify(message ?? "").length / 3),
  }
  host.ctx = {
    logger: { warn: (line) => host.logs.push(String(line)) },
    tools: { register: (tool) => host.tools.set(tool.name, tool) },
    on: (name, handler) => { if (!host.handlers.has(name)) host.handlers.set(name, []); host.handlers.get(name).push(handler) },
    effect: (fn) => { try { if (typeof fn === "function") fn() } catch (error) { host.logs.push("effect threw " + error) } },
    timer: { timeout: async (callback, ms) => { if (typeof callback === "function") setTimeout(() => { try { callback() } catch (error) { host.logs.push("timer threw " + error) } }, ms); else await wait(ms) }, interval: () => () => {} },
    inject: (deps, fn) => { if (typeof fn === "function") { try { fn({ webServer: { getOrigin: () => "", register: () => ({}) } }) } catch (error) { host.logs.push("inject threw " + error) } } },
    sessions: { get: (id) => host.sessions.get(id) },
    agents: { get: (id) => { if (!host.agents.has(id)) host.agents.set(id, { id, running: false, cancel: () => { host.cancels.push(id); host.finishTurn(id, { kind: "canceled" }) } }); return host.agents.get(id) } },
    sessionQuery: { readSession: async (id) => host.sessions.get(id) ?? null },
    workspaceRegistry: { resolveByPath: async () => null },
    get: (name) => {
      if (name === "tokenMeter") return meterStub
      if (name === "sessionTitle") return { rename: (session, title) => host.titles.set(session.id, title) }
      if (name === "workingDirectory") return { get: () => undefined }
      return undefined
    },
    sessionController: {
      create: async ({ cwd } = {}) => ({ sessionId: makeSession(cwd).id }),
      prompt: async ({ sessionId, content, requestId }) => {
        const session = host.sessions.get(sessionId)
        if (!session) throw new Error("unknown session " + sessionId)
        host.prompts.push({ sessionId, requestId, text: (content ?? []).map((block) => block.text ?? "").join("\n") })
        emit("session/event", session, { type: "user/message", seq: (session.seq += 1), data: { source: { kind: "user", rpcId: requestId }, content } })
        const agent = host.ctx.agents.get(sessionId)
        agent.running = true
        emit("agent/status", { agent: { id: sessionId }, status: "running" })
        setTimeout(() => host.finishTurn(sessionId), 5)
        return { accepted: true }
      },
      cancel: async ({ sessionId }) => { host.cancels.push("api:" + sessionId); host.finishTurn(sessionId, { kind: "canceled" }); return { accepted: true } },
    },
  }
  host.emit = emit
  host.customerSession = (cwd) => makeSession(cwd)
  host.deliveriesTo = (id) => host.prompts.filter((row) => row.sessionId === id)
  host.call = async (tool, args, agentId) => {
    const definition = host.tools.get(tool)
    if (!definition) throw new Error("tool not registered: " + tool)
    return definition.execute(args, { agent: agentId ? { id: agentId, session: host.sessions.get(agentId) } : undefined })
  }
  host.pairs = async () => {
    const text = (await host.call("supervision_status", {})).text
    const start = text.indexOf("["); if (start < 0) return []
    return JSON.parse(text.slice(start, text.lastIndexOf("]") + 1))
  }
  host.journal = () => {
    const file = path.join(profile, "session-supervisor", "reports.json")
    try { return JSON.parse(fs.readFileSync(file, "utf8")).events ?? [] } catch { return [] }
  }
  host.waitFor = async (fn, tries = 60) => { for (let i = 0; i < tries; i += 1) { if (fn()) return true; await wait(50) } return false }
  return host
}

async function loadPlugin(profile) {
  const target = path.join(profile, "plugin-under-test.mjs")
  fs.copyFileSync(SRC, target)
  return import(pathToFileURL(target).href + "?t=" + Date.now() + Math.random())
}

const results = []
const check = (label, ok, extra) => { results.push({ label, ok: !!ok }); console.log((ok ? "PASS " : "FAIL ") + label + (extra ? " :: " + extra : "")) }
const instance = async (config) => {
  const profile = path.join(os.tmpdir(), "sup-ctx-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5))
  const host = fakeHost(profile)
  const module = await loadPlugin(profile)
  module.apply(host.ctx, { idleNudgeMs: 0, idleForceReviewMs: 0, rolloverCooldownMs: 0, channelGuard: false, ...config })
  return host
}
const OVERFLOW = { kind: "error", error: { code: "CONTEXT_WINDOW_EXCEEDED", message: '400: {"type":"invalid_request_error","message":"request exceeds the context window: prompt (524545 tokens) leaves no room to answer in the context (524288); requests are never truncated"}' } }

async function main() {
  // C1 provider 不报 usage（11-15 事故原样）：只靠 measure() 的 estimated 总量也要能触发接力
  {
    const host = await instance({ maxContextTokens: 240000 })
    const worker = host.customerSession("C:/tmp")
    await host.call("supervision_enroll", { requirement: "需求 C1" }, worker.id)
    const before = host.created.length
    host.setPressure(worker.id, { provider: undefined, measure: 300000, baselineKind: "estimated" })
    const pre = (await host.pairs())[0]
    check("C1 零 usage 也能量出水面（来源 measured）", pre?.context?.worker === 300000 && pre?.context?.source === "measured", JSON.stringify(pre?.context))
    host.finishTurn(worker.id, { kind: "completed" })
    const rolled = await host.waitFor(() => host.created.length > before)
    const view = (await host.pairs())[0]
    check("C1 零 usage 也能量出水面并接力", rolled, "created+" + (host.created.length - before))
    check("C1 接力后阈值/交接记账在案", view?.context?.handovers === "1/8", JSON.stringify(view?.context))
    check("C1 接力后仍 1:1", view?.pairing?.oneToOne === true, JSON.stringify(view?.pairing))
  }

  // C2 阈值跟窗口：窗口 128k → 阈值 = 128k - 60k = 68k；70k 触发，100k(窗口 300k) 不触发
  {
    const host = await instance({})
    const worker = host.customerSession("C:/tmp")
    await host.call("supervision_enroll", { requirement: "需求 C2" }, worker.id)
    host.setPressure(worker.id, { measure: 70000, window: 128000 })
    const view = (await host.pairs())[0]
    check("C2 阈值跟随窗口（128k → 68k）", view?.context?.limit === 68000, JSON.stringify(view?.context))
    const before = host.created.length
    host.finishTurn(worker.id, { kind: "completed" })
    const rolled2 = await host.waitFor(() => host.created.length > before)
    check("C2 窗口内达阈值就接力", rolled2, "created+" + (host.created.length - before) + " | logs=" + host.logs.filter((l) => /handover|skip|wall|overflow|halt/i.test(String(l))).slice(-4).join(" ~ ").slice(0, 300))
    const host2 = await instance({})
    const w2 = host2.customerSession("C:/tmp")
    await host2.call("supervision_enroll", { requirement: "需求 C2b" }, w2.id)
    host2.setPressure(w2.id, { measure: 100000, window: 300000 })
    const before2 = host2.created.length
    host2.finishTurn(w2.id, { kind: "completed" })
    await wait(300)
    check("C2b 未达阈值不误接力（300k 窗口 / 100k）", host2.created.length === before2, "created+" + (host2.created.length - before2))
  }

  // C3 溢出错误：紧急接力，不并入「连续模型错误」熔断（这是 11-15 把监督对判死的那一步）
  {
    const host = await instance({})
    const worker = host.customerSession("C:/tmp")
    await host.call("supervision_enroll", { requirement: "需求 C3" }, worker.id)
    const before = host.created.length
    host.setPressure(worker.id, { measure: 1000 })
    host.finishTurn(worker.id, OVERFLOW)
    const rolled = await host.waitFor(() => host.created.length > before)
    await wait(450) // reports.json 是 300ms 去抖落盘
    const view = (await host.pairs())[0]
    check("C3 溢出即接力（未达阈值也强制换会话）", rolled, "created+" + (host.created.length - before))
    check("C3 溢出不计入模型错误", (view?.consecutiveErrors ?? -1) === 0, "errors=" + view?.consecutiveErrors + " recent=" + JSON.stringify(view?.recentErrors) + " logs=" + host.logs.filter((l) => /overflow|handover|in flight|drop-extra|relay/i.test(String(l))).slice(-6).join(" || ").slice(0, 400))
    check("C3 监督对未因溢出熔断", view?.state === "active", "state=" + view?.state)
    check("C3 journal 落了 overflow 事件", host.journal().some((row) => row.kind === "overflow"), JSON.stringify(host.journal().filter((row) => row.kind === "overflow").slice(-1)))
    // 投递现在是「同步判定 + FIFO 队列」：交接卡可能先入队再补发，等它真落地再断言内容
    await host.waitFor(() => host.prompts.some((row) => row.requestId.startsWith("sup:handover") && /溢出|provider 拒绝/.test(row.text)), 200)
    const overflowCard = host.prompts.filter((row) => row.requestId.startsWith("sup:handover")).at(-1)
    check("C3 交接卡写明溢出原因", !!overflowCard && /溢出|provider 拒绝/.test(overflowCard.text), (overflowCard?.text ?? "(没拿到交接卡)·prompts=" + host.prompts.length).slice(0, 90).replace(/\n/g, " "))
  }

  // C4 非溢出的连续模型错误仍按原逻辑熔断（不回归）
  {
    const host = await instance({})
    const worker = host.customerSession("C:/tmp")
    await host.call("supervision_enroll", { requirement: "需求 C4" }, worker.id)
    for (let i = 0; i < 3; i += 1) host.finishTurn(worker.id, { kind: "error", error: { message: "ECONNREFUSED" } })
    await wait(250)
    const view = (await host.pairs())[0]
    check("C4 连续 3 次非溢出错误仍熔断", view?.state === "halted", "state=" + view?.state)
  }

  // C5 投递裁剪：单次投递不超过 deliverMaxChars；水位紧张时按剩余额度收缩并记 delivery-trim
  {
    const host = await instance({ deliverMaxChars: 2000 })
    const worker = host.customerSession("C:/tmp")
    await host.call("supervision_enroll", { requirement: "需求 C5" }, worker.id)
    const supervisor = (await host.pairs())[0].supervisorSessionId
    // 让日志摘录本身变大（这才是评审材料的主体），逼出硬上限裁剪
    const session = host.sessions.get(worker.id)
    for (let i = 0; i < 120; i += 1) session.events.push({ type: "assistant/message", seq: (session.seq += 1), data: { message: { content: [{ type: "text", text: "第 " + i + " 拍 " + "y".repeat(300) }] } } })
    await host.call("supervision_done", { summary: "做完了" }, worker.id)
    const got = await host.waitFor(() => host.deliveriesTo(supervisor).some((row) => row.requestId.startsWith("sup:review")))
    const review = host.deliveriesTo(supervisor).filter((row) => row.requestId.startsWith("sup:review")).at(-1)
    check("C5 评审材料送达", got && !!review, "deliveries=" + host.deliveriesTo(supervisor).length)
    check("C5 投递被裁到 deliverMaxChars 内", !!review && review.text.length <= 2400, "chars=" + (review?.text.length ?? 0))
    check("C5 裁剪处留了可读标记", !!review && /裁掉/.test(review.text), (review?.text ?? "").slice(-120).replace(/\n/g, " "))
    // 水位紧张：监督侧只剩 500 词元额度 -> 收缩投递并记 delivery-trim
    const host2 = await instance({ deliverMaxChars: 30000 })
    const w2 = host2.customerSession("C:/tmp")
    await host2.call("supervision_enroll", { requirement: "需求 C5b" }, w2.id)
    const sup2 = (await host2.pairs())[0].supervisorSessionId
    host2.setPressure(sup2, { measure: 239500 })
    const s2 = host2.sessions.get(w2.id)
    for (let i = 0; i < 120; i += 1) s2.events.push({ type: "assistant/message", seq: (s2.seq += 1), data: { message: { content: [{ type: "text", text: "第 " + i + " 拍 " + "z".repeat(300) }] } } })
    await host2.call("supervision_done", { summary: "做完了" }, w2.id)
    const shrunk = await host2.waitFor(() => host2.journal().some((row) => row.kind === "delivery-trim"))
    const review2 = host2.deliveriesTo(sup2).filter((row) => row.requestId.startsWith("sup:review")).at(-1)
    check("C5b 水位紧张时按剩余额度收缩投递", shrunk, "trim=" + JSON.stringify(host2.journal().filter((row) => row.kind === "delivery-trim").slice(-1)[0]?.data ?? null))
    check("C5b 收缩后的投递确实变短", !!review2 && review2.text.length < 1500, "chars=" + (review2?.text.length ?? 0))
  }

  // C6 supervision_worker_log 封顶：不再让评审自己贴几十万字
  {
    const host = await instance({ workerLogMaxChars: 3000 })
    const worker = host.customerSession("C:/tmp")
    await host.call("supervision_enroll", { requirement: "需求 C6" }, worker.id)
    const session = host.sessions.get(worker.id)
    for (let i = 0; i < 400; i += 1) session.events.push({ type: "assistant/message", seq: (session.seq += 1), data: { message: { content: [{ type: "text", text: "第 " + i + " 行 " + "x".repeat(400) }] } } })
    const out = await host.call("supervision_worker_log", { maxLines: 400 }, worker.id)
    check("C6 worker_log 按预算封顶", out.text.length <= 3600, "chars=" + out.text.length)
    check("C6 worker_log 封顶后仍提示分段取法", /sinceSeq|maxLines|裁/.test(out.text), out.text.slice(-80))
  }

  // C7 溢出后按 provider 报的真实窗口收紧阈值（宿主声明的窗口可以比实际能吃的大）
  {
    const host = await instance({ maxContextTokens: 900000 })
    const worker = host.customerSession("C:/tmp")
    await host.call("supervision_enroll", { requirement: "需求 C7" }, worker.id)
    const pre = (await host.pairs())[0]
    check("C7 溢出前阈值 = maxContextTokens（无窗口信息）", pre?.context?.limit === 900000, JSON.stringify(pre?.context))
    host.finishTurn(worker.id, OVERFLOW)
    await wait(500)
    const after = await host.waitFor(() => {
      const row = (host.journal().some((r) => r.kind === "overflow"))
      return row
    })
    const view = (await host.pairs())[0]
    check("C7 溢出被记进 journal", after, "overflow=" + JSON.stringify(host.journal().filter((r) => r.kind === "overflow").slice(-1)[0]?.data?.observedCeiling))
    check("C7 阈值按真实窗口收紧（524288-60000=464288）", view?.context?.limit === 464288, JSON.stringify(view?.context))
    check("C7 ceiling 也透出到状态里", (view?.context?.ceiling ?? 0) === 524288, "ceiling=" + JSON.stringify(view?.context?.ceiling))
  }

  const failed = results.filter((row) => !row.ok)
  console.log(`\n结果：${results.length - failed.length}/${results.length} 通过`)
  const logs = results.length ? null : null
  if (failed.length) process.exitCode = 1
}

main().catch((error) => { console.error("context-test crashed:", error); process.exitCode = 1 })
