// 上下文分段（v1.2.4）回归：node .verify/split-test.mjs
// 覆盖：分段计划有序 / 超客户设定阈值自动分段 / 段间串行不跳段 / 最后一段才进评审 /
//       未超阈值不拆 / 512K·1M 阈值按真实窗口夹住 / 关掉开关退回普通接力。
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

const base = { idleNudgeMs: 0, idleForceReviewMs: 0, rolloverCooldownMs: 0, pairIdleGraceMs: 800, channelGraceMs: 800, channelGuard: false }
const instance = async (config = {}) => {
  const profile = path.join(os.tmpdir(), "sup-split-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6))
  const host = makeFakeHost(profile)
  const mod = await loadPlugin(profile)
  mod.apply(host.ctx, { ...base, ...config })
  host.profile = profile
  globalThis.CURRENT_HOST = host
  return host
}

const REQ = [
  "需求：给后台加一个分段导出功能，验收按下面 5 条逐项做。",
  "1. 新增 /api/export/parts 接口，返回分段清单（含 index/total）。",
  "2. 导出时按 1000 行一段切分，段顺序稳定（同一批数据两次导出顺序一致）。",
  "3. 前端导出按钮改为按段下载，逐段提示进度。",
  "4. 任一段失败可单独重试，不影响已完成段。",
  "5. 补一组离线回归（≥5 项），跑出 OK 并落盘日志。",
].join("\n")

const makePair = async (host, name = "分段需求", requirement = REQ) => {
  const worker = host.customerSession("C:/tmp")
  await host.call("supervision_enroll", { requirement }, worker.id)
  await host.tickUntil(async () => (await host.status()).length > 0, 60)
  const view = (await host.status())[0]
  await host.tickUntil(async () => (await host.one(view.pairId))?.running?.queuedDeliveries === 0, 120)
  return { workerId: view.workerSessionId, supervisorId: view.supervisorSessionId, pairId: view.pairId }
}

async function main() {
  // ── SP1 dry-run：计划有序、条目来自验收清单、落 journal(action=plan)
  {
    const host = await instance({ contextSplitTokens: 4000, contextSplitPartChars: 220 })
    const { workerId, pairId } = await makePair(host)
    const out = await host.call("supervision_split", {}, workerId)
    const text = out.text ?? ""
    check("SP1 计划含 ≥2 段且标注段号顺序", /第 1\/\d 段/.test(text) && /第 2\/\d 段/.test(text), text.slice(0, 120).replace(/\n/g, " "))
    check("SP1 计划条目来自验收清单（不是整段需求）", /\/api\/export\/parts/.test(text) && /离线回归/.test(text), text.slice(0, 200).replace(/\n/g, " "))
    await wait(450) // journal 落盘 300ms 去抖
    const plan = host.journal("context-split").find((r) => r.data?.action === "plan")
    check("SP1 journal 落 context-split(action=plan, dryRun)", !!plan && plan.data.dryRun === true && plan.data.total >= 2, JSON.stringify(plan?.data ?? null))
    await host.call("supervision_stop", { pairId }, workerId).catch(() => {})
  }

  // ── SP2 超阈值自动分段：新会话 + 第 1/N 段卡 + journal part-start
  {
    const host = await instance({ contextSplitTokens: 5000, contextSplitPartChars: 220 })
    const { workerId, pairId } = await makePair(host)
    host.setPressure(workerId, { measure: 6000 })
    const before = host.created.length
    await host.tickUntil(async () => host.created.length > before, 120)
    // 等对上的 workerId 真切换（换会话是异步的，created 先增）
    await host.waitFor(async () => (await host.one(pairId))?.workerSessionId !== workerId, 120)
    const newWorker = (await host.one(pairId))?.workerSessionId
    await host.waitFor(() => host.deliveriesTo(newWorker).some((row) => /分段接力/.test(row.text)), 150)
    const card = host.deliveriesTo(newWorker).find((row) => /分段接力/.test(row.text))?.text ?? ""
    check("SP2 到线自动换新执行会话", newWorker !== workerId && host.created.length === before + 1, `${workerId} -> ${newWorker}`)
    check("SP2 新会话拿到「第 1/N 段」卡", /第 1\/\d 段/.test(card), card.slice(0, 100).replace(/\n/g, " "))
    check("SP2 卡里只列本段条目、并写明做完就上报", /本段只做这 \d+ 项/.test(card) && /supervision_done/.test(card), card.slice(0, 160).replace(/\n/g, " "))
    await wait(450) // journal 落盘 300ms 去抖
    const part = host.journal("context-split").find((r) => r.data?.action === "part-start")
    check("SP2 journal 落 context-split(part-start) 带 total/tokens/limit", !!part && part.data.part === 1 && part.data.total >= 2 && part.data.tokens === 6000, JSON.stringify(part?.data ?? null))
    check("SP2 状态里能看分段进度", /^\d+\/\d+$/.test(String((await host.one(pairId))?.context?.split ?? "")), JSON.stringify((await host.one(pairId))?.context))

    // ── SP3 段间串行：本段 done 不评审，推进到下一段
    const reviewsBefore = (await host.one(pairId))?.reviews
    // 现实时序：执行会话在自己的轮里上报，轮随即结束（会话变空闲）。桩里要显式收尾，
    // 否则这一侧一直挂着 running，下一次投递会排队（FIFO 语义正确，但断言拿不到卡）。
    host.release(newWorker)
    await host.call("supervision_done", { summary: "第 1 段完成：/api/export/parts 返回 index/total，curl 200 实测" }, newWorker)
    const advanced = await host.waitFor(async () => /^2\//.test(String((await host.one(pairId))?.context?.split ?? "")), 120)
    check("SP3 本段上报后推进到第 2 段", advanced, JSON.stringify((await host.one(pairId))?.context))
    check("SP3 本段上报不触发评审", (await host.one(pairId))?.reviews === reviewsBefore, `reviews=${(await host.one(pairId))?.reviews} before=${reviewsBefore}`)
    check("SP3 下一段开到新会话", await host.waitFor(async () => (await host.one(pairId))?.workerSessionId !== newWorker, 120), "worker=" + (await host.one(pairId))?.workerSessionId)
    const second = await host.tickUntil(async () => host.prompts.some((row) => /第 2\/\d 段/.test(row.text) && /前面 1 段已完成/.test(row.text)), 400)
    check("SP3 第 2 段卡投到新会话且写明前段已完成（不重做）", second, "serial=" + JSON.stringify((await host.one(pairId))?.serial) + " queue=" + JSON.stringify((await host.one(pairId))?.running?.deferredDelivery) + " journals=" + JSON.stringify(host.journal("delivery-deferred").slice(-4).map((r) => r.data)))

    // ── SP5 最后一段 done → 进评审
    const lastWorker = (await host.one(pairId))?.workerSessionId
    const total = Number(String((await host.one(pairId))?.context?.split ?? "0/0").split("/")[1])
    for (let i = 2; i <= total; i += 1) {
      const w = (await host.one(pairId))?.workerSessionId
      host.release(w)
      await host.call("supervision_done", { summary: `第 ${i} 段完成：已落盘并跑回归 OK` }, w)
      await host.waitFor(async () => String((await host.one(pairId))?.context?.split ?? "") === "", 120)
      if (i < total) await host.waitFor(async () => Number(String((await host.one(pairId))?.context?.split ?? "0/0").split("/")[0]) === i + 1, 120)
    }
    const reviewed = await host.waitFor(async () => Number(String((await host.one(pairId))?.reviews ?? "0/12").split("/")[0]) > 0, 150)
    check("SP5 全部段完成后才进评审", reviewed && (await host.one(pairId))?.context?.split === null, `reviews=${(await host.one(pairId))?.reviews} split=${(await host.one(pairId))?.context?.split}`)
    check("SP5 journal 记 all-parts-done", host.journal("context-split").some((r) => r.data?.action === "all-parts-done"), JSON.stringify(host.journal("context-split").map((r) => r.data?.action)))
    await host.call("supervision_stop", { pairId }, workerId).catch(() => {})
  }

  // ── SP6 未超阈值不拆（也不能因为开了开关就乱换会话）
  {
    const host = await instance({ contextSplitTokens: 5000 })
    const { workerId, pairId } = await makePair(host)
    const before = host.created.length
    host.setPressure(workerId, { measure: 1200 })
    for (let i = 0; i < 6; i += 1) { host.tick(); await wait(60) }
    check("SP6 水位未到线不换会话", host.created.length === before, "created+" + (host.created.length - before))
    check("SP6 无 context-split 事件", host.journal("context-split").length === 0, JSON.stringify(host.journal("context-split").map((r) => r.data)))
    await host.call("supervision_stop", { pairId }, workerId).catch(() => {})
  }

  // ── SP7 客户设定 512K / 1M 生效（且被真实窗口夹住）
  {
    const host = await instance({ contextSplitTokens: 1048576 })
    const { workerId, pairId } = await makePair(host)
    host.setPressure(workerId, { measure: 100000, window: 1048576 })
    let limit = (await host.one(pairId))?.context?.limit
    check("SP7 设 1M + 窗口 1M → 阈值=窗口−预留(60000)", limit === 988576, "limit=" + limit)
    host.setPressure(workerId, { measure: 100000, window: 524288 })
    limit = (await host.one(pairId))?.context?.limit
    check("SP7 设 1M + 窗口 512K → 阈值被夹到 464288", limit === 464288, "limit=" + limit)
    check("SP7 状态透出客户设定值", (await host.one(pairId))?.context?.splitTokens === 1048576, JSON.stringify((await host.one(pairId))?.context))
    await host.call("supervision_stop", { pairId }, workerId).catch(() => {})
  }

  // ── SP8 关掉开关（=0）退回普通接力卡
  {
    const host = await instance({ maxContextTokens: 5000 })
    const { workerId, pairId } = await makePair(host)
    host.setPressure(workerId, { measure: 6000 })
    const before = host.created.length
    await host.tickUntil(async () => host.created.length > before, 120)
    await host.waitFor(async () => (await host.one(pairId))?.workerSessionId !== workerId, 120)
    const newWorker = (await host.one(pairId))?.workerSessionId
    await host.waitFor(() => host.prompts.some((row) => /接力交接/.test(row.text)), 200)
    const text = host.prompts.map((row) => row.text).join("\n")
    check("SP8 关掉分段 → 用普通接力卡", /接力交接/.test(text) && !/分段接力/.test(text), text.slice(0, 80).replace(/\n/g, " "))
    check("SP8 不产生 context-split 事件", host.journal("context-split").length === 0, JSON.stringify(host.journal("context-split").map((r) => r.data)))
    await host.call("supervision_stop", { pairId }, workerId).catch(() => {})
  }

  const failed = results.filter((r) => !r.ok)
  console.log(`\n结果：${results.length - failed.length}/${results.length} 通过`)
  if (failed.length) process.exitCode = 1
}

main().catch((error) => { console.error("split-test crashed:", error); process.exitCode = 1 })
