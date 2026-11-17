// 用客户原文验证：溢出识别 + 真实窗口解析
import fs from 'node:fs'

const src = fs.readFileSync('index.js', 'utf8')
const reLine = src.match(/const OVERFLOW_RE = (\/.*\/i)/)[1]
const OVERFLOW_RE = eval(reLine)
const msg = '400: {"type":"invalid_request_error","message":"request exceeds the context window: prompt (524520 tokens) leaves no room to answer in the context (524288); requests are never truncated"}'
console.log('OVERFLOW_RE 命中:', OVERFLOW_RE.test(msg))

const patterns = [
  /prompt \((\d+) tokens?\)[^)]*?context[^\d(]*(\d{4,})/i,
  /context \((\d{4,})\)/i,
  /(?:context window|max(?:imum)? context(?: length)?)[^\d]{0,12}(\d{5,})\s*(?:tokens?|k\b)?/i,
]
let hit
for (const re of patterns) { const m = msg.match(re); if (m) { hit = Number(m[2] ?? m[1]); break } }
console.log('parseWindowCeiling 结果:', hit)

// 反例：普通错误不能被误判成溢出
for (const bad of ['rate limited', '401 unauthorized', 'model overloaded']) console.log(`误判检查「${bad}」:`, OVERFLOW_RE.test(bad))
