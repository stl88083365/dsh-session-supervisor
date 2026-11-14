// 1:1 配对 + 上下文接力回归测试（fake ctx，不碰宿主）: node .verify/pairing-test.mjs
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
  const host = { sessions: new Map(), tools: new Map(), handlers: new Map(), created: [], prompts: [], cancels: [], agents: new Map(), tokens: new Map(), titles: new Map(), intervals: [], logs: [] }
  const emit = (name, ...args) => { for (const handler of host.handlers.get(name) ?? []) { try { handler(...args) } catch (error) { host.logs.push("handler " + name + " threw " + error) } } }
  const makeSession = (cwd) => {
    const id = "session-" + host.created.length + "-" + Math.random().toString(36).slice(2, 8)
    const session = { id, cwd: cwd ?? null, events: [], seq: 0 }
    host.sessions.set(id, session); host.created.push(id); host.tokens.set(id, 1000)
    return session
  }
  host.setPressure = (id, value) => host.tokens.set(id, value)
  host.finishTurn = (id, reason = {}) => {
    const agent = host.agents.get(id)
    if (agent) agent.running = false
    emit("agent/status", { agent: { id }, status: "idle" })
    const session = host.sessions.get(id)
    if (session) emit("session/event", session, { type: "turn/end", seq: (session.seq += 1), data: { reason } })
  }
  host.ctx = {
    logger: { warn: (line) => host.logs.push(String(line)) },
    tools: { register: (tool) => host.tools.set(tool.name, tool) },
    on: (name, handler) => { if (!host.handlers.has(name)) host.handlers.set(name, []); host.handlers.get(name).push(handler) },
    effect: (fn) => { try { if (typeof fn === "function") fn() } catch (error) { host.logs.push("effect threw " + error) } },
    timer: {
      timeout: async (callback, ms) => { if (typeof callback === "function") setTimeout(() => { try { callback() } catch (error) { host.logs.push("timer threw " + error) } }, ms); else await wait(ms) },
      interval: (fn) => { host.intervals.push(fn); return () => {} },
    },
    inject: (deps, fn) => { if (typeof fn === "function") { try { fn({ webServer: { getOrigin: () => "", register: () => ({}) } }) } catch (error) { host.logs.push("inject threw " + error) } } },
    sessions: { get: (id) => host.sessions.get(id) },
    agents: { get: (id) => { if (!host.agents.has(id)) host.agents.set(id, { id, running: false, cancel: () => { host.cancels.push(id); host.finishTurn(id, { kind: "canceled" }) } }); return host.agents.get(id) } },
    sessionQuery: { readSession: async (id) => host.sessions.get(id) ?? null },
    workspaceRegistry: { resolveByPath: async () => null },
    get: (name) => {
      if (name === "tokenMeter") return { contextPressure: (session) => ({ pressureTokens: session ? (host.tokens.get(session.id) ?? 0) : undefined }) }
      if (name === "sessionTitle") return { rename: (session, title) => host.titles.set(session.id, title) }
      if (name === "workingDirectory") return { get: (session) => (host.sessions.get(session?.id) ?? session)?.cwd ?? undefined }
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
    const agent = agentId ? { id: agentId, session: host.sessions.get(agentId) } : undefined
    return definition.execute(args, { agent })
  }
  host.pairs = async () => {
    const text = (await host.call("supervision_status", {})).text
    const start = text.indexOf("[")
    if (start < 0) return []
    const end = text.lastIndexOf("]")
    return JSON.parse(text.slice(start, end + 1))
  }
  return host
}

async function loadPlugin(profile) {
  const target = path.join(profile, "plugin-under-test.mjs")
  fs.copyFileSync(SRC, target)
  return import(pathToFileURL(target).href + "?t=" + Date.now() + Math.random())
}

const results = []
const check = (label, ok, extra) => { results.push({ label, ok: !!ok }); console.log((ok ? "PASS " : "FAIL ") + label + (extra ? " :: " + extra : "")) }
let __host = null
function instance2() { return (__host?.logs ?? []).filter((line) => /skip |handover|deliveryBlocker/i.test(String(line))) }
async function testsOnFreshInstance() {
  const profile = path.join(os.tmpdir(), "sup-1to1-" + Date.now().toString(36))
  const host = fakeHost(profile)
  const module = await loadPlugin(profile)
  module.apply(host.ctx, { maxContextTokens: 5000, idleNudgeMs: 0, idleForceReviewMs: 0, rolloverCooldownMs: 0 })
  __host = host

  // T1 同一个执行会话并发 supervision_enroll -> 只允许一个监督会话（1 执行 <-> 1 监督）
  const worker = host.customerSession("C:/tmp")
  const before1 = host.created.length
  const outputs = await Promise.all([
    host.call("supervision_enroll", { requirement: "需求 A" }, worker.id),
    host.call("supervision_enroll", { requirement: "需求 A" }, worker.id),
    host.call("supervision_enroll", { requirement: "需求 A" }, worker.id),
  ])
  const created1 = host.created.length - before1
  const status1 = await host.pairs()
  check("T1 并发纳入只新建 1 个会话（监督）", created1 === 1, "created+" + created1)
  check("T1 只有 1 个监督对", status1.length === 1, "pairs=" + status1.length)
  const pair1 = status1[0]
  check("T1 该对 1:1 自检通过", pair1.pairing?.oneToOne === true, JSON.stringify(pair1.pairing))
  check("T1 复用提示可辨识", outputs.some((row) => row.text.includes("复用")), outputs.map((row) => row.text.split("\n")[0]).join(" | "))
  const supervisorId = pair1.supervisorSessionId
  const workerId1 = pair1.workerSessionId

  // T2 首条客户消息含「需要审查」自动建对；重复触发不再开会话
  const worker2 = host.customerSession("C:/tmp")
  const before2 = host.created.length
  host.emit("session/event", worker2, { type: "user/message", seq: (worker2.seq += 1), data: { source: { kind: "user", rpcId: "user:1" }, content: [{ type: "text", text: "这个插件有 bug，需要审查一下" }] } })
  await wait(120)
  check("T2 触发词自动建对（+1 会话）", host.created.length - before2 === 1, "created+" + (host.created.length - before2))
  const before3 = host.created.length
  await Promise.all([
    host.call("supervision_enroll", { requirement: "需求 B" }, worker2.id),
    host.call("supervision_enroll", { requirement: "需求 B" }, worker2.id),
  ])
  check("T2 已建对会话重复纳入不再开会话", host.created.length === before3, "created+" + (host.created.length - before3))

  // T3 执行侧水位达线 -> 恰好一个新执行会话；老会话停止运行并退休；监督会话不变
  const target = (await host.pairs()).find((row) => row.workerSessionId === workerId1)
  check("T3 找到待接力监督对", !!target, "pair=" + (target?.pairId ?? "none"))
  const oldWorker = target.workerSessionId
  const before4 = host.created.length
  const cancelsBefore = host.cancels.length
  host.setPressure(oldWorker, 9000)
  host.setPressure(supervisorId, 1000)
  await host.call("supervision_done", { summary: "做完了：跑了 dir 命令输出 ok，文件 a.txt 存在（证据 C:/tmp/a.txt）" }, oldWorker)
  for (let i = 0; i < 80; i += 1) {
    const view = (await host.pairs()).find((row) => row.pairId === target.pairId)
    if (view && view.workerSessionId !== oldWorker) break
    await wait(100)
  }
  let after = (await host.pairs()).find((row) => row.pairId === target.pairId)
  const newWorker = after.workerSessionId
  for (let i = 0; i < 60; i += 1) {
    if (host.deliveriesTo(newWorker).some((row) => row.requestId.startsWith("sup:handover"))) break
    await wait(200)
  }
  check("T3 达线只新开 1 个执行会话", host.created.length - before4 === 1, "created+" + (host.created.length - before4))
  check("T3 执行侧已切到新会话", !!newWorker && newWorker !== oldWorker, oldWorker + " -> " + newWorker)
  check("T3 老执行会话被真正停止(cancel)", host.cancels.includes(oldWorker) || host.cancels.includes("api:" + oldWorker), "cancels+" + (host.cancels.length - cancelsBefore))
  check("T3 老会话进入退休表", (after.retiredSessions ?? []).some((row) => row.sessionId === oldWorker), JSON.stringify(after.retiredSessions))
  check("T3 监督会话未被替换（仍 1:1）", after.supervisorSessionId === supervisorId, after.supervisorSessionId)
  check("T3 交接卡送达新执行会话", host.deliveriesTo(newWorker).some((row) => row.requestId.startsWith("sup:handover")), "tags=" + JSON.stringify(host.prompts.map((row) => row.sessionId.replace("session-", "s") + ":" + row.requestId.split(":")[1])) + " now=" + newWorker + " | skip=" + instance2().filter(l => String(l).includes("skip handover")).slice(0,2).join(" / "))


  check("T3 新会话标题已接力标记", String(host.titles.get(oldWorker) ?? "").includes("已接力"), host.titles.get(oldWorker) ?? "(未改名)")

  await wait(1500)
  after = (await host.pairs()).find((row) => row.pairId === target.pairId)
  check("T3b 多轮评审后仍只多 1 个会话", host.created.length - before4 === 1, "created+" + (host.created.length - before4))
  check("T3b 评审链路仍在跑", after.reviews !== "0/12", "reviews=" + after.reviews + " busy=" + after.serial.reviewInFlight + " err=" + JSON.stringify(after.recentErrors) + " pending=" + JSON.stringify(after.reportPending))

  // T4 退休老会话被再用：不再建对、不再收任务、且被停掉
  const before5 = host.created.length
  const promptsBefore = host.prompts.length
  for (let i = 0; i < 3; i += 1) {
    await host.call("supervision_enroll", { requirement: "老会话再来一次" }, oldWorker)
    host.emit("session/event", host.sessions.get(oldWorker), { type: "user/message", seq: (host.sessions.get(oldWorker).seq += 1), data: { source: { kind: "user", rpcId: "user:retire" + i }, content: [{ type: "text", text: "需要审查：继续做" }] } })
  }
  await wait(200)
  check("T4 退休会话重复纳入不再开会话", host.created.length === before5, "created+" + (host.created.length - before5))
  const late = host.prompts.slice(promptsBefore).filter((row) => row.sessionId === oldWorker && !row.requestId.startsWith("sup:retired"))
  check("T4 退休会话不再接收任务投递", late.length === 0, late.map((row) => row.requestId).join(","))
  check("T4 退休会话再次被停止", host.cancels.filter((id) => id === oldWorker || id === "api:" + oldWorker).length > 1, "cancels=" + host.cancels.length)
  return { host, profile, pairId: target.pairId, workerId: newWorker, supervisorId, oldWorker }
}

async function testRealJournalHydration() {
  const src = "C:\\Users\\lbxp\\.dsh\\session-supervisor\\reports.json"
  if (!fs.existsSync(src)) { check("T5 跳过（无真实 journal）", true, src); return }
  const profile = path.join(os.tmpdir(), "sup-1to1-hydrate-" + Date.now().toString(36))
  const host = fakeHost(profile)
  fs.mkdirSync(path.join(profile, "session-supervisor"), { recursive: true })
  fs.copyFileSync(src, path.join(profile, "session-supervisor", "reports.json"))
  const module = await loadPlugin(profile)
  module.apply(host.ctx, { dormantAfterMs: 21600000 })
  await wait(900)
  const status = await host.pairs()
  check("T5 重启后按 journal 复原监督对", status.length > 0, "pairs=" + status.length)
  const live = status.filter((row) => row.state === "active")
  const index = new Map()
  for (const pair of live) for (const key of [pair.workerSessionId, pair.supervisorSessionId]) if (key) index.set(key, (index.get(key) ?? 0) + 1)
  const dup = [...index.entries()].filter(([, count]) => count > 1)
  check("T5 活体对严格 1:1（无共享会话）", dup.length === 0, JSON.stringify(dup))
  const conflicts = (live[0]?.pairing?.conflicts ?? [])
  check("T5 自检 conflicts 为空", conflicts.length === 0, JSON.stringify(conflicts))
  const shared = status.filter((row) => (row.lineage ?? []).some((line) => String(line.previousId ?? "").includes("315349c7")) || String(row.workerSessionId ?? "").includes("315349c7"))
  const alive = shared.filter((row) => row.state === "active" || row.state === "dormant")
  check("T5 真实重复对已收口（同一执行链只留一条）", alive.length <= 1, shared.map((row) => row.pairId + "=" + row.state).join(","))
  const haltedDup = shared.filter((row) => row.state === "halted" || row.state === "stopped")
  check("T5 重复对已熔断（本次停会话或此前已收口）", haltedDup.length >= 1 && (host.cancels.length >= 1 || haltedDup.some((row) => String(row.haltReason ?? "").includes("重复") || row.state === "stopped")), "halted=" + haltedDup.map((row) => row.pairId + ":" + row.state).join(",") + " cancels=" + host.cancels.length)
  check("T5 陈旧对转 dormant（不再自动跑）", status.some((row) => row.state === "dormant"), "states=" + [...new Set(status.map((row) => row.state))].join("/"))
  const journalFile = path.join(profile, "session-supervisor", "reports.json")
  const j = JSON.parse(fs.readFileSync(journalFile, "utf8"))
  const pairingEvents = j.events.filter((event) => event.kind === "pairing")
  check("T5 journal 落了 pairing 事件", pairingEvents.some((event) => event.data?.action === "hydrate"), JSON.stringify(pairingEvents.slice(-2).map((event) => event.data)))
  const bindingsFile = path.join(profile, "session-supervisor", "bindings.json")
  check("T5 绑定落盘 bindings.json", fs.existsSync(bindingsFile), bindingsFile)
  // 老对 dormant：执行会话重开必须复用原监督会话，零新开会话
  const dormantPair = status.find((row) => row.state === "dormant")
  if (dormantPair) {
    for (const id of [dormantPair.workerSessionId, dormantPair.supervisorSessionId]) if (id && !host.sessions.has(id)) host.sessions.set(id, { id, events: [], seq: 0, cwd: null })
    const createdBefore = host.created.length
    const reply = await host.call("supervision_enroll", { requirement: "继续原任务" }, dormantPair.workerSessionId)
    check("T5 dormant 对重开复用同一监督会话", host.created.length === createdBefore && reply.text.includes(dormantPair.supervisorSessionId), "created+" + (host.created.length - createdBefore) + " | " + reply.text.split("\n")[0])
  }
}

const startedAt = Date.now()
let instance = null
try {
  instance = await testsOnFreshInstance()
  check("T0 实例日志无异常抛出", !instance.host.logs.some((line) => String(line).includes("threw")), instance.host.logs.filter((line) => String(line).includes("threw")).slice(0, 2).join(" | "))
} catch (error) {
  check("T1-T4 异常 " + String(error?.stack ?? error).split("\n").slice(0, 3).join(" / "), false)
  if (instance) console.log(instance.host.logs.slice(-15).join("\n"))
}
try { await testRealJournalHydration() } catch (error) { check("T5 异常 " + String(error?.stack ?? error).split("\n").slice(0, 3).join(" / "), false) }
const failed = results.filter((row) => !row.ok)
console.log("")
console.log("结果：" + (results.length - failed.length) + "/" + results.length + " 通过（" + (Date.now() - startedAt) + "ms）")
if (instance) console.log("插件日志尾（含停止/接力/去重证据）:\n" + instance.host.logs.filter((line) => /stopped session|retired|duplicate|handover|hydrat/i.test(String(line))).slice(-12).join("\n"))
process.exit(failed.length ? 1 : 0)

