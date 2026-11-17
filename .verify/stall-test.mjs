// 卡死收口 + 排队不丢 回归（fake ctx）: node .verify/stall-test.mjs
// 覆盖：评审超时收口/上限、执行侧单轮超时、投递排队不丢不乱序（角色卡不被覆盖）、
// 单通道不插队、饿死后强行投递、委派会话不建对、评审材料排队期间不起计时。
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { pathToFileURL, fileURLToPath } from "node:url"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const SRC = path.join(ROOT, "index.js")
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// 看门狗用 Date.now() 判超时：测试里把时钟推快即可
let skew = 0
const realNow = Date.now.bind(Date)
Date.now = () => realNow() + skew

function fakeHost(profile) {
  fs.rmSync(profile, { recursive: true, force: true })
  fs.mkdirSync(profile, { recursive: true })
  process.env.DSH_PROFILE_DIR = profile
  const host = { sessions: new Map(), tools: new Map(), handlers: new Map(), created: [], prompts: [], cancels: [], agents: new Map(), pressure: new Map(), titles: new Map(), logs: [], held: new Set(), intervals: [] }
  const emit = (name, ...args) => { for (const h of host.handlers.get(name) ?? []) { try { h(...args) } catch (e) { host.logs.push("handler threw " + e) } } }
  const makeSession = (cwd) => {
    const id = "session-" + host.created.length + "-" + Math.random().toString(36).slice(2, 8)
    const session = { id, cwd: cwd ?? null, events: [], seq: 0 }
    host.sessions.set(id, session); host.created.push(id)
    return session
  }
  host.setPressure = (id, v) => host.pressure.set(id, typeof v === "number" ? { measure: v } : v)
  host.hold = (id) => host.held.add(id)
  host.release = (id) => { host.held.delete(id); host.finishTurn(id, { kind: "completed" }) }
  host.finishTurn = (id, reason = {}) => {
    const agent = host.agents.get(id)
    if (agent) agent.running = false
    emit("agent/status", { agent: { id }, status: "idle" })
    const session = host.sessions.get(id)
    if (session) emit("session/event", session, { type: "turn/end", seq: (session.seq += 1), data: { reason } })
  }
  host.tick = () => { for (const fn of host.intervals) { try { fn() } catch (e) { host.logs.push("interval threw " + e) } } }
  host.tickUntil = async (fn, tries = 100, step = 40) => {
    for (let i = 0; i < tries; i += 1) { host.tick(); if (await fn()) return true; await wait(step) }
    return false
  }
  const meterStub = {
    contextPressure: (s) => { const p = host.pressure.get(s?.id) ?? {}; const out = {}; if (p.provider !== undefined) out.pressureTokens = p.provider; if (p.window !== undefined) out.contextWindow = p.window; return out },
    measure: (s) => { const p = host.pressure.get(s?.id) ?? {}; return p.measure === undefined ? undefined : { totalTokens: p.measure, baseline: { kind: "estimated" }, surfaceTokens: p.measure } },
    estimateMessage: (m) => Math.ceil(JSON.stringify(m ?? "").length / 3),
  }
  host.ctx = {
    logger: { warn: (l) => host.logs.push(String(l)) },
    tools: { register: (t) => host.tools.set(t.name, t) },
    on: (n, h) => { if (!host.handlers.has(n)) host.handlers.set(n, []); host.handlers.get(n).push(h) },
    effect: (fn) => { try { if (typeof fn === "function") fn() } catch (e) { host.logs.push("effect threw " + e) } },
    timer: {
      timeout: async (cb, ms) => { if (typeof cb === "function") setTimeout(() => { try { cb() } catch (e) { host.logs.push("timer threw " + e) } }, ms); else await wait(ms) },
      interval: (fn) => { host.intervals.push(fn); return () => {} },
    },
    inject: (deps, fn) => { if (typeof fn === "function") { try { fn({ webServer: { getOrigin: () => "", register: () => ({}) } }) } catch (e) { host.logs.push("inject threw " + e) } } },
    sessions: { get: (id) => host.sessions.get(id) },
    agents: { get: (id) => { if (!host.agents.has(id)) host.agents.set(id, { id, running: false, cancel: () => { host.cancels.push(id); host.finishTurn(id, { kind: "canceled" }) } }); return host.agents.get(id) } },
    sessionQuery: { readSession: async (id) => host.sessions.get(id) ?? null },
    workspaceRegistry: { resolveByPath: async () => null },
    get: (n) => {
      if (n === "tokenMeter") return meterStub
      if (n === "sessionTitle") return { rename: (s, t) => host.titles.set(s.id, t) }
      if (n === "workingDirectory") return { get: () => undefined }
      return undefined
    },
    sessionController: {
      create: async ({ cwd } = {}) => ({ sessionId: makeSession(cwd).id }),
      prompt: async ({ sessionId, content, requestId }) => {
        const session = host.sessions.get(sessionId)
        if (!session) throw new Error("unknown session " + sessionId)
        host.prompts.push({ sessionId, requestId, text: (content ?? []).map((b) => b.text ?? "").join("\n") })
        emit("session/event", session, { type: "user/message", seq: (session.seq += 1), data: { source: { kind: "user", rpcId: requestId }, content } })
        host.ctx.agents.get(sessionId).running = true
        emit("agent/status", { agent: { id: sessionId }, status: "running" })
        if (!host.held.has(sessionId)) setTimeout(() => host.finishTurn(sessionId), 5)
        return { accepted: true }
      },
      cancel: async ({ sessionId }) => { host.cancels.push("api:" + sessionId); host.finishTurn(sessionId, { kind: "canceled" }); return { accepted: true } },
    },
  }
  host.emit = emit
  host.customerSession = (cwd) => makeSession(cwd)
  host.deliveriesTo = (id) => host.prompts.filter((r) => r.sessionId === id)
  host.call = async (tool, args, agentId) => {
    const d = host.tools.get(tool); if (!d) throw new Error("tool not registered: " + tool)
    return d.execute(args, { agent: agentId ? { id: agentId, session: host.sessions.get(agentId) } : undefined })
  }
  host.status = async () => { const t = (await host.call("supervision_status", {})).text; const s = t.indexOf("["); return s < 0 ? [] : JSON.parse(t.slice(s, t.lastIndexOf("]") + 1)) }
  host.one = async (pairId) => (await host.status()).find((p) => p.pairId === pairId)
  host.journal = (kind) => {
    try {
      const events = JSON.parse(fs.readFileSync(path.join(profile, "session-supervisor", "reports.json"), "utf8")).events ?? []
      return kind ? events.filter((r) => r.kind === kind) : events
    } catch { return [] }
  }
  host.waitFor = async (fn, tries = 150) => { for (let i = 0; i < tries; i += 1) { if (await fn()) return true; await wait(40) } return false }
  /** 喂狗直到某条 journal 事件出现（journal 落盘有 300ms 去抖，所以要先等一下） */
  host.waitEvent = (kind, predicate = () => true, tries = 150) => host.tickUntil(async () => {
    const hit = host.journal(kind).find((r) => predicate(r.data ?? {}, r))
    return !!hit
  }, tries)
  return host
}

async function loadPlugin(profile) {
  const target = path.join(profile, "plugin-under-test.mjs")
  fs.copyFileSync(SRC, target)
  return import(pathToFileURL(target).href + "?t=" + Date.now() + Math.random())
}

const results = []
let CURRENT_HOST = null
const check = (label, ok, extra) => {
  results.push({ label, ok: !!ok })
  console.log((ok ? "PASS " : "FAIL ") + label + (extra ? " :: " + extra : ""))
  if (!ok && CURRENT_HOST) {
    // 失败时把插件日志与流水一起吐出来：定位「为什么没送达」不必再手写复现脚本
    console.log("  logs: " + CURRENT_HOST.logs.slice(-10).join("\n  logs: ").slice(0, 1600))
    try {
      const evs = CURRENT_HOST.journal().filter((r) => String(r.kind).startsWith("delivery")).slice(-8)
      console.log("  journal: " + JSON.stringify(evs.map((r) => ({ k: r.kind, ...r.data }))))
    } catch {}
    console.log("  prompts: " + CURRENT_HOST.prompts.map((p) => p.sessionId.slice(-6) + ":" + p.requestId.split(":").slice(1, 3).join("/")).join(", "))
  }
}
const base = { idleNudgeMs: 0, idleForceReviewMs: 0, rolloverCooldownMs: 0, pairIdleGraceMs: 800, channelGraceMs: 800 }
const instance = async (config = {}) => {
  const profile = path.join(os.tmpdir(), "sup-stall-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6))
  const host = fakeHost(profile)
  const mod = await loadPlugin(profile)
  mod.apply(host.ctx, { ...base, ...config })
  host.profile = profile
  CURRENT_HOST = host
  return host
}
/** 建对后的投递是异步排队的：等它真正落地，再进入「抢占通道」等场景（否则测的是竞态窗口） */
const settleDeliveries = async (host, sessionId, min = 1, tries = 250) => {
  await host.tickUntil(async () => host.deliveriesTo(sessionId).length >= min, tries)
  return host.tickUntil(async () => (await host.status()).every((p) => p.running.queuedDeliveries === 0), tries)
}
const makePair = async (host, name = "需求") => {
  const worker = host.customerSession("C:/tmp")
  await host.call("supervision_enroll", { requirement: name }, worker.id)
  const view = (await host.status())[0]
  return { workerId: view.workerSessionId, supervisorId: view.supervisorSessionId, pairId: view.pairId }
}
const occupyChannel = async (host) => {
  const other = host.customerSession("C:/other")
  host.hold(other.id)
  await host.ctx.sessionController.prompt({ sessionId: other.id, content: [{ type: "text", text: "别人在干活" }], requestId: "other-" + other.id })
  await wait(80)
  return other
}

async function main() {
  // ── S1 评审超时：必须收口（释放 busy）+ 记 event + 通知执行侧 + 重排；连续超时才熔断
  {
    const host = await instance({ reviewTurnTimeoutMs: 60000, maxReviewTimeouts: 2 })
    const { workerId, supervisorId, pairId } = await makePair(host, "需求 S1")
    await host.call("supervision_done", { summary: "做完了，证据：Get-Content a.txt → ok（C:/tmp/a.txt）" }, workerId)
    check("S1 评审已进 in-flight", await host.waitFor(async () => (await host.one(pairId))?.serial?.reviewInFlight === true), JSON.stringify((await host.one(pairId))?.serial))
    skew += 61000
    check("S1 超时后记 review-timeout", await host.waitEvent("review-timeout", (d) => d.count === 1))
    const st = await host.one(pairId)
    check("S1 超时后 busy 被释放（不再永久 reviewing）", st?.serial?.reviewInFlight === false || st?.state === "halted", JSON.stringify(st?.serial))
    check("S1 超时计数可审计", (st?.running?.reviewTimeouts ?? "").startsWith("1/"), JSON.stringify(st?.running))
    check("S1 监督会话被真正中止", host.cancels.includes(supervisorId), "cancels=" + host.cancels.join(","))
    check("S1 执行侧收到「按未通过处理」通知", await host.waitFor(() => host.deliveriesTo(workerId).some((r) => /按「未通过」|supervision_done/.test(r.text))),
      "prompts=" + host.deliveriesTo(workerId).map((r) => r.requestId.split(":")[1]).join(","))
    // 第二轮：重排的评审再次超时 → 达 maxReviewTimeouts → 熔断
    await host.waitFor(async () => (await host.one(pairId))?.serial?.reviewInFlight === true, 60)
    await host.tickUntil(async () => (await host.one(pairId))?.running?.queuedDeliveries === 0, 200)
    await host.waitFor(async () => Number(((await host.one(pairId))?.running?.sinceSupervisorHandSeconds ?? 0) > 0) === 1, 60)
    skew += 61000
    check("S1 连续超时达上限后熔断", await host.tickUntil(async () => (await host.one(pairId))?.state === "halted", 120), "state=" + (await host.one(pairId))?.state)
  }

  // ── S2 执行侧单轮超时：cancel + 通知（可能先排队，必须不丢）+ 正常上报清零计数
  {
    const host = await instance({ workerTurnTimeoutMs: 60000, maxWorkerTimeouts: 2 })
    const { workerId, pairId } = await makePair(host, "需求 S2")
    await settleDeliveries(host, workerId)
    host.hold(workerId)
    await host.ctx.sessionController.prompt({ sessionId: workerId, content: [{ type: "text", text: "跑一条没有超时的 ssh" }], requestId: "manual-long" })
    await wait(80)
    check("S2 长轮被登记为 running", (await host.one(pairId))?.serial?.workerRunning === true, JSON.stringify((await host.one(pairId))?.serial))
    skew += 61000
    check("S2 单轮超时记 worker-timeout", await host.waitEvent("worker-timeout", (d) => d.count === 1))
    check("S2 单轮超时触发 cancel", host.cancels.includes("api:" + workerId) || host.cancels.includes(workerId), "cancels=" + host.cancels.join(","))
    check("S2 超时计数 1/2", (await host.one(pairId))?.running?.workerTimeouts === "1/2", JSON.stringify((await host.one(pairId))?.running))
    // 通道空了必须把超时通知补上（排队不丢）
    check("S2 超时通知最终送达执行侧", await host.tickUntil(async () => host.deliveriesTo(workerId).some((r) => /中止本轮|落盘/.test(r.text)), 150),
      "prompts=" + host.deliveriesTo(workerId).map((r) => r.requestId.split(":")[1]).join(","))
    host.release(workerId)
    await host.call("supervision_done", { summary: "做完了：已落盘并跑 Get-Content → ok（C:/tmp/a.txt）" }, workerId)
    await wait(200)
    check("S2 正常上报后超时计数清零", (await host.one(pairId))?.running?.workerTimeouts === "0/2", JSON.stringify((await host.one(pairId))?.running))
  }

  // ── S3 长轮期间投递排队（不硬塞打断），空闲后自动补发
  {
    const host = await instance({})
    const { workerId, pairId } = await makePair(host, "需求 S3")
    await settleDeliveries(host, workerId)
    host.hold(workerId)
    await host.ctx.sessionController.prompt({ sessionId: workerId, content: [{ type: "text", text: "长轮" }], requestId: "manual-3" })
    await wait(80)
    await host.call("supervision_review", { note: "S3" }, workerId).catch(() => {})
    check("S3 忙时投递入库排队（gate=not-idle/queue-ahead）", await host.waitEvent("delivery-deferred", (d) => d.gate === "not-idle" || d.gate === "queue-ahead"),
      JSON.stringify(host.journal("delivery-deferred").slice(-1)[0]?.data ?? null))
    check("S3 状态里能看到排队条目", await host.waitFor(async () => {
      const r = (await host.one(pairId))?.running
      return typeof r?.deferredDelivery === "string" && String(r.deferredDelivery).includes("review") && r.queuedDeliveries >= 1
    }, 150), JSON.stringify((await host.one(pairId))?.running?.deferredDelivery) + " queued=" + (await host.one(pairId))?.running?.queuedDeliveries)
    host.release(workerId)
    check("S3 空闲后自动补发", await host.waitEvent("delivery-retry", () => true, 120), JSON.stringify(host.journal("delivery-retry").slice(-1)[0]?.data ?? null))
  }

  // ── S4 单通道：别人的会话在跑时不插队；通道空了自动补发
  {
    const host = await instance({ channelGuard: true })
    const { workerId, pairId } = await makePair(host, "需求 S4")
    // 建对时的投递是异步入队的：先等它们真落地，否则测到的是竞态窗口而不是「插队」
    await settleDeliveries(host, workerId)
    const other = await occupyChannel(host)
    check("S4 状态里能看到别人占通道", (await host.one(pairId))?.running?.channel?.others >= 1, JSON.stringify((await host.one(pairId))?.running?.channel))
    await host.call("supervision_review", { note: "S4" }, workerId).catch(() => {})
    check("S4 通道被占时不插队（gate=channel-busy）", await host.waitEvent("delivery-deferred", (d) => d.gate === "channel-busy"),
      JSON.stringify(host.journal("delivery-deferred").slice(-1)[0]?.data ?? null) + " logs=" + host.logs.slice(-6).join(" ~ ").slice(0, 400))
    host.release(other.id)
    check("S4 通道空闲后自动补发", await host.waitEvent("delivery-retry", (d) => d.tag === "review", 250), JSON.stringify(host.journal("delivery-retry").slice(-1)[0]?.data ?? null))
  }

  // ── S5 排队不丢 + 先来后到：拥堵期间的多条投递最终全部送达（角色卡不被覆盖丢）
  {
    const host = await instance({ channelGuard: true, channelMaxWaitMs: 900000 })
    const { workerId, supervisorId } = await makePair(host, "需求 S5")
    await settleDeliveries(host, workerId)
    const other = await occupyChannel(host)
    await host.call("supervision_review", { note: "S5 评审一" }, workerId).catch(() => {})
    await host.call("supervision_review", { note: "S5 评审二" }, workerId).catch(() => {})
    check("S5 拥堵期多条投递入库（队列 ≥1）", await host.waitFor(async () => (await host.status()).some((p) => p.running.queuedDeliveries >= 1)),
      JSON.stringify((await host.status())[0]?.running?.queuedDeliveries))
    host.release(other.id)
    check("S5 队列最终排空", await host.tickUntil(async () => (await host.status()).every((p) => p.running.queuedDeliveries === 0), 400),
      "queued=" + (await host.status())[0]?.running?.queuedDeliveries)
    const supervisorCards = host.deliveriesTo(supervisorId).filter((r) => r.requestId.startsWith("sup:card")).length
    const reviews = host.deliveriesTo(supervisorId).filter((r) => r.requestId.startsWith("sup:review")).length
    check("S5 监督角色卡送达（未丢失）", supervisorCards >= 1, "cards=" + supervisorCards)
    check("S5 评审材料送达", reviews >= 1, "reviews=" + reviews)
  }

  // ── S6 材料排队期间不起评审判时：不该因此烧超时/熔断
  {
    const host = await instance({ channelGuard: true, reviewTurnTimeoutMs: 60000, maxReviewTimeouts: 2, channelMaxWaitMs: 900000 })
    const { workerId, pairId } = await makePair(host, "需求 S6")
    await settleDeliveries(host, workerId)
    const other = await occupyChannel(host)
    await host.call("supervision_done", { summary: "做完了，证据：Get-Content a.txt → ok（C:/tmp/a.txt）" }, workerId)
    await wait(400)
    skew += 70000 // 时限「已过」，但材料还在排队
    host.tick()
    await wait(300)
    host.tick()
    const st = await host.one(pairId)
    check("S6 材料未送达期间不计超时", st?.running?.reviewTimeouts === "0/2" && st?.state === "active", JSON.stringify({ t: st?.running?.reviewTimeouts, s: st?.state, q: st?.running?.queuedDeliveries }))
    host.release(other.id)
    check("S6 通道空闲后评审材料送达", await host.waitEvent("delivery-retry", (d) => d.tag === "review", 150) || host.deliveriesTo((await host.one(pairId)).supervisorSessionId).some((r) => r.requestId.startsWith("sup:review")),
      "state=" + (await host.one(pairId))?.state)
  }

  // ── S7 委派/一次性会话不建对（不留幽灵监督对）
  {
    const host = await instance({})
    const fake = { id: "mnemon-run-v1-deadbeef", events: [], seq: 0 }
    host.sessions.set(fake.id, fake)
    host.emit("session/event", fake, { type: "user/message", seq: 1, data: { source: { kind: "user", rpcId: "user:1" }, content: [{ type: "text", text: "这条文本需要审查" }] } })
    await wait(400)
    check("S7 委派会话（mnemon-run-*）不建对", (await host.status()).length === 0, "pairs=" + (await host.status()).length)
  }

  // ── S8 排队饿死后强行投递（监督不至于永远不动）
  {
    // 1000ms 是 channelMaxWaitMs 的下限值（更小的值会被 pickNumber 判成非法并回落到默认 600s，
    // 上一版这里写 500 → 实际拿到 600000 → 「饿死强行投递」压根没触发）
    const host = await instance({ channelGuard: true, channelMaxWaitMs: 1000 })
    const { workerId } = await makePair(host, "需求 S8")
    await settleDeliveries(host, workerId)
    await occupyChannel(host)
    await host.call("supervision_review", { note: "S8" }, workerId).catch(() => {})
    await wait(300)
    skew += 5000
    check("S8 饿死后强行投递（记 delivery-forced）", await host.waitEvent("delivery-forced", () => true, 150),
      JSON.stringify(host.journal("delivery-forced").slice(-1)[0]?.data ?? null))
  }

  const failed = results.filter((r) => !r.ok)
  console.log(`\n结果：${results.length - failed.length}/${results.length} 通过`)
  if (failed.length) process.exitCode = 1
}

main().catch((e) => { console.error("stall-test crashed:", e); process.exitCode = 1 })
