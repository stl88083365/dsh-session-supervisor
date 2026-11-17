// 文本工具调用守卫（v1.3.0）回归：node .verify/text-toolcall-test.mjs
// 覆盖：正文写了 <tool_call> 且本轮 0 工具执行 → 注入纠正 / 真有工具执行则闭嘴 /
//       连续上限 4 次后 give-up / 干净一轮清零 / 开关关闭完全不介入 / 监督侧同样生效 /
//       纠正文案点名真实 shell 工具 pwsh 且第 2 次起升级。
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { pathToFileURL, fileURLToPath } from "node:url"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const SRC = path.join(ROOT, "index.js")
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// 复用 stall-test 的 fakeHost（同一份桩，别维护两套）
const stallSrc = fs.readFileSync(path.join(ROOT, ".verify", "stall-test.mjs"), "utf8")
const hostBody = stallSrc.slice(stallSrc.indexOf("function fakeHost"), stallSrc.indexOf("async function loadPlugin"))
const makeFakeHost = new Function("fs", "os", "path", "pathToFileURL", "wait", hostBody + "\nreturn fakeHost")(fs, os, path, pathToFileURL, wait)

const loadPlugin = async (profile) => {
  const target = path.join(profile, "plugin-under-test.mjs")
  fs.copyFileSync(SRC, target)
  return import(pathToFileURL(target).href + "?t=" + Date.now() + Math.random())
}

const results = []
const check = (label, ok, extra) => {
  results.push({ label, ok: !!ok })
  console.log((ok ? "PASS " : "FAIL ") + label + (extra ? " :: " + extra : ""))
  if (!ok) console.log("  logs: " + (globalThis.CURRENT_HOST?.logs ?? []).slice(-8).join("\n  logs: "))
}

const base = { idleNudgeMs: 0, idleForceReviewMs: 0, rolloverCooldownMs: 0, pairIdleGraceMs: 500, channelGraceMs: 500, channelGuard: false }
const instance = async (config = {}) => {
  const profile = path.join(os.tmpdir(), "sup-tt-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6))
  const host = makeFakeHost(profile)
  const mod = await loadPlugin(profile)
  mod.apply(host.ctx, { ...base, ...config })
  host.profile = profile
  globalThis.CURRENT_HOST = host
  return host
}

const REQ = "需求：把导出接口改成按段下载，逐段提示进度，补离线回归并落盘日志。"
const makePair = async (host) => {
  const worker = host.customerSession("C:/tmp")
  await host.call("supervision_enroll", { requirement: REQ }, worker.id)
  await host.tickUntil(async () => (await host.status()).length > 0, 60)
  const view = (await host.status())[0]
  await host.tickUntil(async () => (await host.one(view.pairId))?.running?.queuedDeliveries === 0, 120)
  return { workerId: view.workerSessionId, supervisorId: view.supervisorSessionId, pairId: view.pairId }
}

const GUARD = "工具调用写成了正文"
const TEXT_CALL = '<tool_call>\n<function=exec>\n<parameter=command>\nssh root@host "date"\n</parameter>\n</function>\n</tool_call>'

/** 只把 agent 标空闲（不像 host.release 那样再补一个 turn/end，避免打乱按轮计数）。 */
const idle = (host, id) => {
  const agent = host.agents.get(id)
  if (agent) agent.running = false
  host.emit("agent/status", { agent: { id }, status: "idle" })
}

/** 造一轮真实的会话事件：assistant 正文（可能含文本调用）+ N 个真实 tool/call + turn/end。 */
const turn = (host, session, { text = "好的，我继续。", calls = 0, n = 1 } = {}) => {
  const push = (type, data) => {
    const ev = { type, seq: (session.seq += 1), data }
    session.events.push(ev)
    host.emit("session/event", session, ev)
  }
  push("assistant/message", { turn: n, step: 1, message: { role: "assistant", content: [{ type: "text", text }] } })
  for (let i = 0; i < calls; i += 1) push("tool/call", { turn: n, step: 1, callId: `c${n}-${i}`, name: "pwsh", arguments: "{}" })
  push("turn/end", { turn: n, reason: { kind: "completed" } })
}

/** 单通道排队：把目标侧标空闲并喂几次 interval，直到队列清空（否则投递一直 parked）。 */
const settle = async (host, pairId, id) => {
  for (let i = 0; i < 15; i += 1) {
    idle(host, id)
    host.tick()
    await wait(120)
    if ((await host.one(pairId))?.running?.queuedDeliveries === 0) return true
  }
  return false
}

const count = (host, id) => host.deliveriesTo(id).filter((row) => row.text.includes(GUARD)).length
const attempts = (host) => host.journal("text-toolcall").map((r) => `${r.data?.action}:${r.data?.attempts}`)

async function main() {
  // ── TT1 文本调用 + 本轮 0 工具执行 → 注入一条纠正 + journal 记 retry
  {
    const host = await instance({})
    const { workerId, pairId } = await makePair(host)
    const w = host.sessions.get(workerId)
    const before = count(host, workerId)
    turn(host, w, { text: TEXT_CALL, calls: 0, n: 1 })
    await settle(host, pairId, workerId)
    await wait(450)
    const row = host.deliveriesTo(workerId).filter((r) => r.text.includes(GUARD)).at(-1)?.text ?? ""
    check("TT1 正文写调用且 0 工具执行 → 注入纠正", count(host, workerId) === before + 1, `deliveries=${count(host, workerId) - before}`)
    check("TT1 文案点名真实 shell 工具 pwsh 并禁止文本标记", /pwsh/.test(row) && /不存在 exec 工具/.test(row) && /不要再写 <tool_call>/.test(row), row.slice(0, 120).replace(/\n/g, " "))
    check("TT1 第 1 次是普通口径（不是升级口径）", /（第 1\/4 次纠正）/.test(row) && !/这是第 1\/4 次纠正/.test(row), row.slice(-90).replace(/\n/g, " "))
    check("TT1 journal 记 text-toolcall(retry, attempts=1)", attempts(host).join(",") === "retry:1", attempts(host).join(","))

    // ── TT2 同一轮既有文本又有真实工具执行 → 不打扰
    const before2 = count(host, workerId)
    turn(host, w, { text: TEXT_CALL, calls: 2, n: 2 })
    await settle(host, pairId, workerId)
    await wait(350)
    check("TT2 本轮真有工具执行 → 不再注入", count(host, workerId) === before2, `deliveries=${count(host, workerId) - before2}`)

    // ── TT3 连续上限：4 次注入，第 5 次 give-up（TT2 已清零，从 1 重新数）
    const start = count(host, workerId)
    for (let i = 3; i <= 7; i += 1) { turn(host, w, { text: TEXT_CALL, calls: 0, n: i }); await settle(host, pairId, workerId); await wait(80) }
    await wait(450)
    const seq = attempts(host).filter((x) => !x.startsWith("give")).join(",")
    const give = host.journal("text-toolcall").filter((r) => r.data?.action === "give-up").at(-1)
    check("TT3 连续写正文只救 4 次", count(host, workerId) - start === 4, `injected=${count(host, workerId) - start}`)
    check("TT3 第 5 次记 give-up 不再打扰", give?.data?.attempts === 5 && give?.data?.role === "worker", JSON.stringify(host.journal("text-toolcall").map((r) => `${r.data?.action}:${r.data?.attempts}`)))

    // ── TT6 监督侧同样生效（评审轮里把 verdict 写成文本也一样救）
    const sup = host.sessions.get((await host.one(pairId)).supervisorSessionId)
    const sBefore = count(host, sup.id)
    turn(host, sup, { text: TEXT_CALL, calls: 0, n: 1 })
    await settle(host, pairId, sup.id)
    await wait(300)
    check("TT6 监督侧写正文也被纠正", count(host, sup.id) === sBefore + 1, `deliveries=${count(host, sup.id) - sBefore}`)
    await host.call("supervision_stop", { pairId }, workerId).catch(() => {})
  }

  // ── TT4 干净一轮清零：错→错→干净→错，第 3 次又从 1 起算
  {
    const host = await instance({})
    const { workerId, pairId } = await makePair(host)
    const w = host.sessions.get(workerId)
    const start = count(host, workerId)
    turn(host, w, { text: TEXT_CALL, calls: 0, n: 1 }); await settle(host, pairId, workerId)
    turn(host, w, { text: TEXT_CALL, calls: 0, n: 2 }); await settle(host, pairId, workerId)
    turn(host, w, { text: "这轮正常调用工具。", calls: 3, n: 3 }); await settle(host, pairId, workerId)
    turn(host, w, { text: TEXT_CALL, calls: 0, n: 4 }); await settle(host, pairId, workerId)
    await wait(450)
    const last = host.journal("text-toolcall").filter((r) => r.data?.action === "retry").at(-1)
    check("TT4 干净一轮把预算回满（第 3 次又从 attempts=1 起算）", last?.data?.attempts === 1, attempts(host).join(","))
    check("TT4 三次错误共注入 3 条（没有被上限吞掉）", count(host, workerId) - start === 3, `injected=${count(host, workerId) - start}`)
    await host.call("supervision_stop", { pairId }, workerId).catch(() => {})
  }

  // ── TT5 开关关闭：完全不介入、不落 journal
  {
    const host = await instance({ textToolCallGuard: false })
    const { workerId, pairId } = await makePair(host)
    const w = host.sessions.get(workerId)
    const start = count(host, workerId)
    turn(host, w, { text: TEXT_CALL, calls: 0, n: 1 })
    await settle(host, pairId, workerId)
    await wait(400)
    check("TT5 关掉守卫后不注入", count(host, workerId) === start, `deliveries=${count(host, workerId) - start}`)
    check("TT5 关掉守卫后无 text-toolcall 事件", host.journal("text-toolcall").length === 0, JSON.stringify(host.journal("text-toolcall").map((r) => r.data)))
    await host.call("supervision_stop", { pairId }, workerId).catch(() => {})
  }

  // ── TT7 第 2 次起升级口径（不要再解释、下一步必须有真实调用）
  {
    const host = await instance({})
    const { workerId, pairId } = await makePair(host)
    const w = host.sessions.get(workerId)
    turn(host, w, { text: TEXT_CALL, calls: 0, n: 1 }); await settle(host, pairId, workerId)
    turn(host, w, { text: TEXT_CALL, calls: 0, n: 2 }); await settle(host, pairId, workerId)
    await wait(350)
    const rows = host.deliveriesTo(workerId).filter((r) => r.text.includes(GUARD))
    check("TT7 第 2 次带升级口径", /这是第 2\/4 次纠正/.test(rows.at(-1)?.text ?? "") && /必须立刻产生至少一个真实工具调用/.test(rows.at(-1)?.text ?? ""), (rows.at(-1)?.text ?? "").slice(-120).replace(/\n/g, " "))
    await host.call("supervision_stop", { pairId }, workerId).catch(() => {})
  }

  const pass = results.filter((r) => r.ok).length
  console.log(`\n结果：${pass}/${results.length} 通过`)
  process.exit(pass === results.length ? 0 : 1)
}

main().catch((error) => { console.error(error); process.exit(1) })
