// 真机在线复核（只读，不写任何状态）：
//   1) 插件自身 API：活体对 1:1 自检 + 退休会话名单
//   2) 宿主会话面：被接力的老会话是否真的「已改名 + 不在运行」
// 用法：DSH_WEB_URL=http://127.0.0.1:51914 node .verify/live-1to1-check.mjs [pairId]
import { rpc, ORIGIN } from './dsh-rpc.mjs'

const want = process.argv[2]
const log = (...a) => console.log(...a)

log('origin =', ORIGIN)

const data = await (await fetch(`${ORIGIN}/api/session-supervisor?limit=5`)).json()
const pairs = data.pairs ?? []
const live = pairs.filter((p) => p.state === 'active')
log(`\n[1] 活体监督对 ${live.length} 个（全部 ${pairs.length}）`)
for (const p of live) {
  log(`  ${p.pairId} worker=${p.workerSessionId?.slice(8, 16)} supervisor=${p.supervisorSessionId?.slice(8, 16)} pairing=${JSON.stringify(p.pairing)}`)
}
const conflict = live.filter((p) => (p.pairing?.conflicts ?? []).length || p.pairing?.oneToOne !== true)
log(`  => 1:1 自检：${conflict.length === 0 ? 'PASS（无 conflicts，无共享会话）' : 'FAIL ' + JSON.stringify(conflict.map((p) => p.pairId))}`)

const target = want ? pairs.find((p) => p.pairId === want) : live[0]
if (!target) { log('未找到目标监督对'); process.exit(1) }
log(`\n[2] 目标对 ${target.pairId} 退休会话（已接力）：`)
for (const r of (target.retiredSessions ?? []).filter(Boolean)) log(`  ${r.side} ${String(r.sessionId).slice(8, 16)} -> ${String(r.relayedTo).slice(8, 16)} at ${new Date(r.at).toLocaleString()}`)
if (!(target.retiredSessions ?? []).length) log('  （无）')

// 宿主会话面：读会话标题 + 运行位，证明「老会话停止运行」是真生效而不是只改名
let listed = null
try { listed = await rpc('session/list', { _request: {} }) } catch (error) { log(`\n[3] 宿主 RPC session/list 不可用：${String(error).slice(0, 160)}`) }
const rows = listed?.items ?? []
if (!rows.length) { log('\n[3] 未取到宿主会话列表'); process.exit(0) }
log(`\n[3] 宿主 session/list 取到 ${rows.length} 条会话`)
const pick = (id) => rows.find((row) => row.sessionId === id)
const titleOf = (row) => String(row?.projections?.values?.title ?? row?.title ?? '')
const seen = new Set()
let failures = 0
for (const r of (target.retiredSessions ?? []).filter(Boolean).map((x) => x.sessionId)) {
  const row = pick(r)
  if (!row) { log(`  退休会话 ${String(r).slice(8, 16)}：宿主未列出`); continue }
  const relayed = titleOf(row).includes('已接力')
  const stopped = row.running === false
  if (!relayed || !stopped) failures += 1
  log(`  退休会话 ${String(r).slice(8, 16)}：running=${row.running} title=${JSON.stringify(titleOf(row).slice(0, 40))} => ${relayed && stopped ? 'PASS（已改名 + 不在运行）' : 'FAIL'}`)
}
for (const id of [target.workerSessionId, target.supervisorSessionId]) {
  const row = pick(id)
  if (!row) continue
  log(`  活体 ${String(id).slice(8, 16)}：running=${row.running} title=${JSON.stringify(titleOf(row).slice(0, 40))}`)
}
log(`=> 老会话停止运行（真机）：${failures === 0 ? 'PASS' : 'FAIL ' + failures + ' 条'}`)
