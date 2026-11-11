#!/usr/bin/env node
/*
 * 单文档体积体检（发布前门禁）
 *
 *   node tests/check-doc-size.js                    用内置线上聚合基线做增长外推
 *   node tests/check-doc-size.js --doc doc.json    分析你从云控制台导出的真实 doc（精确）
 *   node tests/check-doc-size.js --doc doc.json --json   机器可读输出
 *
 * 为什么需要：flush() 是整份 doc 覆盖写（utils/store.js:467），每次打卡/点赞/调分
 * 都要把历史全量上传一遍。doc 越大，弱网失败率与耗时越高。
 *
 * 内置基线采集于 2026-11-11，来源：sql/diagnostics.sql 里的只读聚合 SQL
 * （云数据库 ced_families，1 个家庭，rev=292）。只存聚合字节数，不含任何业务内容。
 * 外推是估算，不是实测；要精确结论请 --doc 导入真实文档。
 *
 * 门禁阈值：导入文档 > 512 KB 告警，> 1 MB 退出码 1（触发上一轮约定的重构评估线）。
 */
const fs = require('fs')

const KEEP = {
  sheetsTriggerDays: 160, // prune 只在超过 120+40 天才裁剪，最坏情况留 160 天
  sheetsDays: 120,
  logs: 800,
  activities: 400,
  notices: 100
}
const WARN = 512 * 1024
const FAIL = 1024 * 1024

// 线上真实聚合值（2026-11-11，octet_length(doc::text) 口径 = JSON 文本字节）
const BASELINE = {
  capturedAt: '2026-11-11',
  days: 4,
  items: 46,
  voices: 12,
  voiceTexts: 9,
  voiceTextBytes: 5703,
  maxVoiceChars: 1071,
  total: 48817,
  sheets: 20441,
  logs: 20604,
  logsN: 136,
  notices: 616,
  noticesN: 2,
  activities: 0,
  activitiesN: 0
}
BASELINE.fixed = BASELINE.total - BASELINE.sheets - BASELINE.logs - BASELINE.notices - BASELINE.activities

const args = process.argv.slice(2)
const flag = (n) => args.indexOf(n) >= 0
const valueOf = (n) => {
  const i = args.indexOf(n)
  return i >= 0 && args[i + 1] && args[i + 1][0] !== '-' ? args[i + 1] : ''
}
const bytes = (v) => Buffer.byteLength(JSON.stringify(v === undefined ? null : v), 'utf8')
const kb = (b) => (b / 1024).toFixed(1) + ' KB'
const mb = (b) => (b / 1024 / 1024).toFixed(2) + ' MB'

function scanDoc(doc) {
  const sheets = doc.sheets || {}
  const days = Object.keys(sheets)
  let items = 0
  let voices = 0
  let voiceTexts = 0
  let voiceTextBytes = 0
  let maxVoiceChars = 0
  const perDay = []
  days.forEach((d) => {
    const list = (sheets[d] && sheets[d].items) || []
    let dayVoices = 0
    list.forEach((it) => {
      items += 1
      ;(it.voices || []).forEach((v) => {
        voices += 1
        dayVoices += 1
        const t = (v && v.text) || ''
        if (t) {
          voiceTexts += 1
          voiceTextBytes += Buffer.byteLength(t, 'utf8')
          maxVoiceChars = Math.max(maxVoiceChars, [...t].length)
        }
      })
    })
    perDay.push({ day: d, bytes: bytes(sheets[d]), items: list.length, voices: dayVoices })
  })
  const logs = doc.logs || []
  const acts = doc.activities || []
  const notices = doc.notices || []
  const known = ['sheets', 'logs', 'activities', 'notices']
  let fixed = 0
  Object.keys(doc).forEach((k) => { if (known.indexOf(k) < 0) fixed += bytes(doc[k]) })
  const total = bytes(doc)
  return {
    capturedAt: new Date().toISOString().slice(0, 10),
    days: days.length,
    firstDay: days.sort()[0] || '-',
    lastDay: days.sort()[days.length - 1] || '-',
    items, voices, voiceTexts, voiceTextBytes, maxVoiceChars,
    perDay,
    total,
    sheets: bytes(doc.sheets),
    logs: bytes(logs), logsN: logs.length,
    notices: bytes(notices), noticesN: notices.length,
    activities: bytes(acts), activitiesN: acts.length,
    fixed
  }
}

// 按当前日均增量，外推到 sheets 保留上限时的体积
// 数组型字段有上限（logs/activities/notices），到顶后不再增长，用每条平均字节估算封顶体积
function project(b, horizonDays) {
  const perDaySheets = b.sheets / Math.max(1, b.days)
  const perDayLogs = b.logsN / Math.max(1, b.days)
  const perDayActs = Math.max(perDayLogs, (b.activitiesN || 0) / Math.max(1, b.days))
  const logUnit = b.logsN ? b.logs / b.logsN : 150
  const actUnit = b.activitiesN ? b.activities / b.activitiesN : 150
  const noticeUnit = b.noticesN ? b.notices / b.noticesN : 300
  const noticesAt = Math.min(KEEP.notices, Math.round(perDayLogs * horizonDays)) * noticeUnit
  return {
    horizonDays,
    sheets: Math.round(perDaySheets * horizonDays),
    logs: Math.round(Math.min(KEEP.logs, perDayLogs * horizonDays) * logUnit),
    activities: Math.round(Math.min(KEEP.activities, perDayActs * horizonDays) * actUnit),
    notices: Math.round(noticesAt),
    fixed: b.fixed,
    perDaySheets: Math.round(perDaySheets),
    perDayVoiceText: Math.round(b.voiceTextBytes / Math.max(1, b.days))
  }
}

function totalOf(p) {
  return p.sheets + p.logs + p.activities + p.notices + p.fixed
}

function bandwidth(bytesN) {
  // 上行带宽 → 单次 flush 纯传输耗时（不含 RTT、TLS、服务端处理）
  const links = [
    ['4G 良好 2 Mbps', 2 * 1024 * 1024 / 8],
    ['弱网 200 Kbps', 200 * 1024 / 8],
    ['极弱 50 Kbps', 50 * 1024 / 8]
  ]
  return links.map(([name, bps]) => ({ name, ms: Math.round(bytesN / bps * 1000) }))
}

function printReport(b, isReal) {
  const label = isReal ? '真实文档（--doc 导入）' : '线上聚合基线（外推为估算）'
  console.log('\n=== 单文档体积体检 · ' + label + ' ===')
  console.log('采集 ' + b.capturedAt + ' | ' + b.days + ' 天清单 / ' + b.items + ' 项 / ' + b.voices + ' 条语音')
  console.log('JSON 总量 ' + kb(b.total) + '（' + b.total.toLocaleString() + ' B）')
  console.log('  sheets       ' + kb(b.sheets).padStart(10) + '   ' + b.days + ' 天')
  console.log('  logs         ' + kb(b.logs).padStart(10) + '   ' + b.logsN + ' 条')
  console.log('  activities   ' + kb(b.activities).padStart(10) + '   ' + b.activitiesN + ' 条')
  console.log('  notices      ' + kb(b.notices).padStart(10) + '   ' + b.noticesN + ' 条')
  console.log('  其它（模板/礼物/资料/配置）' + kb(b.fixed).padStart(10))
  console.log('语音转文字：' + b.voiceTexts + '/' + b.voices + ' 条有文本，共 ' + kb(b.voiceTextBytes) +
    '，最长 ' + b.maxVoiceChars + ' 字；占 doc ' + (b.voiceTextBytes / b.total * 100).toFixed(1) + '%')
  console.log('sheets 日均 ' + kb(b.sheets / Math.max(1, b.days)) + '，其中转文字日均 ' + kb(b.voiceTextBytes / Math.max(1, b.days)))

  console.log('\n--- 增长外推（sheets 保留 ' + KEEP.sheetsDays + ' 天，最坏 ' + KEEP.sheetsTriggerDays + ' 天才裁剪）---')
  ;[30, 60, KEEP.sheetsDays, KEEP.sheetsTriggerDays].forEach((d) => {
    const p = project(b, d)
    const t = totalOf(p)
    console.log('  ' + String(d).padStart(3) + ' 天 → ' + mb(t).padStart(8) + '  (sheets ' + kb(p.sheets) +
      ' / logs ' + kb(p.logs) + ' / activities ' + kb(p.activities) + ' / notices ' + kb(p.notices) + ')')
  })
  const voiceHeavy = project(Object.assign({}, b, {
    sheets: b.sheets - b.voiceTextBytes + Math.max(b.voiceTextBytes, b.voices / Math.max(1, b.days) * 800 * 3 * 4)
  }), KEEP.sheetsTriggerDays)
  console.log('  转文字变长（按每天 3 条 × 800 字）→ 160 天约 ' + mb(totalOf(voiceHeavy)))

  console.log('\n--- 单次 flush 上行传输耗时（当前 ' + kb(b.total) + '）---')
  bandwidth(b.total).forEach((x) => console.log('  ' + x.name.padEnd(18) + (x.ms / 1000).toFixed(1) + ' s' + (x.ms > 10000 ? '  ← 超时风险' : '')))

  const p160 = totalOf(project(b, KEEP.sheetsTriggerDays))
  console.log('\n--- 160 天最坏体积的传输耗时 ---')
  bandwidth(p160).forEach((x) => console.log('  ' + x.name.padEnd(18) + (x.ms / 1000).toFixed(1) + ' s' + (x.ms > 10000 ? '  ← 超时风险' : '')))

  console.log('\n阈值：' + kb(WARN) + ' 告警 / ' + mb(FAIL) + ' 触发重构评估。')
  console.log('说明：微信云数据库 SDK 请求有超时，写失败时 mutate() 回滚内存并报错，不会自动重试普通网络错误。')
}

const docPath = valueOf('--doc')
let b
let isReal = false
if (docPath) {
  const raw = JSON.parse(fs.readFileSync(docPath, 'utf8'))
  const doc = raw.doc || raw // 允许直接传 {doc, rev} 或裸 doc
  b = scanDoc(doc)
  isReal = true
} else {
  b = BASELINE
}

if (flag('--json')) {
  console.log(JSON.stringify({ baseline: b, projections: [30, 60, 120, 160].map((d) => project(b, d)), isReal }, null, 2))
} else {
  printReport(b, isReal)
}
if (isReal && b.total > FAIL) {
  console.error('\n门禁未通过：真实 doc 已超过 1 MB，需先处理体积再发版。')
  process.exit(1)
}
if (isReal && b.total > WARN) {
  console.log('\n告警：真实 doc 已超过 512 KB，建议按报告压一次体积。')
}
