// 溢出自动续做（1.2.5）回归：node .verify/overflow-test.mjs
// 覆盖：散会话撞 400 no-room → 自动开新会话接着做 / 卡里带未完成待办 / 老会话停+改名 /
//       journal 记 continuation / 冷却内不重复开 / 续做链封顶 / 监督对内走原 relay（不开两路）/ 委派会话不续。
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { pathToFileURL, fileURLToPath } from "node:url"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const SRC = path.join(ROOT, "index.js")
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const stallSrc = fs.readFileSync(path.join(ROOT, ".verify", "stall-test.mjs"), "utf8")
const hostBody = stallSrc.slice(stallSrc.indexOf("function fakeHost"), stallSrc.indexOf("async function loadPlugin"))
const makeFakeHost = new Function("fs", "os", "path", "pathToFileURL", "wait", hostBody + "\nreturn fakeHost")(fs, os, path, pathToFileURL, wait)

const OVERFLOW = {
  name: 'Error',
  message: '400: {"type":"invalid_request_error","message":"request exceeds the context window: prompt (524520 tokens) leaves no room to answer in the context (524288); requests are never truncated"}',
}

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
  const profile = path.join(os.tmpdir(), "sup-ov-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6))
  const host = makeFakeHost(profile)
  const mod = await loadPlugin(profile)
  mod.apply(host.ctx, { ...base, ...config })
  host.profile = profile
  globalThis.CURRENT_HOST = host
  return host
}

/** 给会话塞一段真实形状的事件（含 todo 快照 + 一轮问答），模拟「长会话干到一半」。 */
const seedSession = (host, session, { title = "长会话", pending = "把剩下的接口补完", done = "已经把 A 部分做完" } = {}) => {
  const push = (type, data) => session.events.push({ type, seq: (session.seq += 1), data })
  push("user/message", { source: { kind: "user", rpcId: "user:1" }, content: [{ type: "text", text: "把这次改造做完，分三步" }] })
  push("assistant/message", { message: { role: "assistant", content: [{ type: "text", text: "先做 A 部分" }] } })
  push("tool/call", { name: "todo_write", arguments: JSON.stringify({ todos: [
    { content: done, status: "completed" },
    { content: pending, status: "in_progress" },
    { content: "最后跑一遍回归并贴输出", status: "pending" },
  ] }) })
  push("tool/result", { message: { role: "tool", content: [{ type: "text", text: "Updated todo list" }] }, isError: false })
  host.titles.set(session.id, title)
  return session
}

async function main() {
  // ── OV1/OV2/OV3：散会话溢出 → 开新会话 + 续做卡（带未完成待办）+ 老会话停/改名 + journal
  {
    const host = await instance({})
    const old = seedSession(host, host.customerSession("C:/tmp"), { title: "长会话：接口改造" })
    const before = host.created.length
    host.emit("agent/error", { agent: { id: old.id }, error: OVERFLOW, turn: 12, step: 40 })
    const created = await host.waitFor(() => host.created.length > before, 120)
    const newId = host.created[host.created.length - 1]
    await host.waitFor(() => host.deliveriesTo(newId).length > 0, 120)
    const card = host.deliveriesTo(newId).map((row) => row.text).join("\n")
    check("OV1 溢出后自动开新会话", created && newId !== old.id, `${old.id} -> ${newId}`)
    check("OV1 新会话拿到「溢出接力·自动续做」卡", /溢出接力 · 自动续做/.test(card), card.slice(0, 90).replace(/\n/g, " "))
    check("OV1 卡里列出未完成待办（照顺序继续）", /把剩下的接口补完/.test(card) && /最后跑一遍回归/.test(card), card.slice(0, 400).replace(/\n/g, " "))
    check("OV1 卡里标出已完成、并要求不要重做", /已经把 A 部分做完/.test(card) && /不要从头重做/.test(card), card.slice(0, 500).replace(/\n/g, " "))
    check("OV1 卡里带上真实窗口 524288", /524288/.test(card), card.slice(0, 300).replace(/\n/g, " "))
    check("OV2 老会话被真正停掉", host.cancels.includes(old.id) || host.cancels.includes("api:" + old.id), "cancels=" + host.cancels.join(","))
    check("OV2 老会话改名标记已溢出接力", String(host.titles.get(old.id) ?? "").includes("已溢出接力"), host.titles.get(old.id))
    await wait(450)
    const ev = host.journal("continuation").at(-1)
    check("OV3 journal 记 continuation（from/to/depth/待办数）", !!ev && ev.data.sessionId === old.id && ev.data.newId === newId && ev.data.depth === 1 && ev.data.todoPending === 2, JSON.stringify(ev?.data ?? null))

    // ── OV4 冷却内重复报错不再开第二个会话
    const before2 = host.created.length
    host.emit("agent/error", { agent: { id: old.id }, error: OVERFLOW, turn: 13, step: 41 })
    await wait(400)
    check("OV4 同一会话冷却内不重复开会话", host.created.length === before2, "created+" + (host.created.length - before2))
  }

  // ── OV5 续做链封顶（overflowContinueMax=1）：新会话再溢出就不再开
  {
    const host = await instance({ overflowContinueMax: 1, overflowContinueCooldownMs: 0 })
    const first = seedSession(host, host.customerSession("C:/tmp"), { title: "链头" })
    const before = host.created.length
    host.emit("agent/error", { agent: { id: first.id }, error: OVERFLOW })
    await host.waitFor(() => host.created.length > before, 120)
    const second = host.created.at(-1)
    const before2 = host.created.length
    host.emit("agent/error", { agent: { id: second }, error: OVERFLOW })
    await wait(600)
    check("OV5 续做链超上限不再开新会话", host.created.length === before2, "created+" + (host.created.length - before2))
    const blocked = host.journal("continuation-blocked").at(-1)
    check("OV5 记 continuation-blocked（可审计）", !!blocked && blocked.data.sessionId === second, JSON.stringify(blocked?.data ?? null))
  }

  // ── OV6 监督对内的执行侧溢出：走原 relayOnOverflow，只多开 1 个，不产生 continuation
  {
    const host = await instance({})
    const worker = host.customerSession("C:/tmp")
    await host.call("supervision_enroll", { requirement: "对齐接口" }, worker.id)
    await host.tickUntil(async () => (await host.status()).length > 0, 60)
    const pairId = (await host.status())[0].pairId
    await host.tickUntil(async () => (await host.one(pairId))?.running?.queuedDeliveries === 0, 120)
    const before = host.created.length
    host.emit("agent/error", { agent: { id: worker.id }, error: OVERFLOW, turn: 3, step: 9 })
    await host.waitFor(async () => (await host.one(pairId))?.workerSessionId !== worker.id, 150)
    await wait(500)
    check("OV6 对内的溢出只多开一个会话（走原 relay，不叠两路）", host.created.length - before === 1, "created+" + (host.created.length - before))
    check("OV6 对内的溢出不走散会话续做", host.journal("continuation").length === 0, JSON.stringify(host.journal("continuation").map((r) => r.data)))
    check("OV6 溢出被记进 overflow journal", host.journal("overflow").length >= 1, JSON.stringify(host.journal("overflow").map((r) => r.data?.role)))
  }

  // ── OV7 委派/一次性会话（mnemon-run-*）不续做
  {
    const host = await instance({})
    const fake = { id: "mnemon-run-v1-deadbeef", cwd: "C:/tmp", events: [], seq: 0 }
    host.sessions.set(fake.id, fake)
    const before = host.created.length
    host.emit("agent/error", { agent: { id: fake.id }, error: OVERFLOW })
    await wait(500)
    check("OV7 委派会话溢出不开新会话", host.created.length === before, "created+" + (host.created.length - before))
    check("OV7 委派会话不产生 continuation 事件", host.journal("continuation").length === 0, "")
  }

  const failed = results.filter((r) => !r.ok)
  console.log(`\n结果：${results.length - failed.length}/${results.length} 通过`)
  if (failed.length) process.exitCode = 1
}

main().catch((error) => { console.error("overflow-test crashed:", error); process.exitCode = 1 })
