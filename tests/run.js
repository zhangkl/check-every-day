#!/usr/bin/env node
/*
 * PDCA 好习惯 · 回归测试统一入口
 *
 *   node tests/run.js                 跑默认套件（跳过 3 个历史遗留）
 *   node tests/run.js --all           连历史遗留一起跑（预期会红，用于还债进度）
 *   node tests/run.js --only activity,adjust   只跑指定套件（名字可省略 test-ced- 前缀）
 *   node tests/run.js --list          列出所有套件与状态
 *   node tests/run.js --verbose       打印每套完整输出
 *
 * 每个套件是独立进程：测试里会 hook Module._load 伪造 wx / 云数据库 / 存储，
 * 同进程跑会互相污染。任何一套失败，进程退出码为失败套件数。
 *
 * 历史遗留（默认跳过，文件已入仓留档，待按新 API 重写）：
 *   store  —— 早期「纯本地存储」版单测，store 云同步改造后 setup() 等 API 已移除，
 *             开场就 TypeError: store.setup is not a function。
 *   asr    —— 腾讯云 ASR mock 与当前 utils/asr.js 契约脱节（返回值 undefined），
 *             且真实凭据文件 utils/asr.config.js 被 .gitignore 排除，离线不可复现。
 *   speech —— 语音转文字降级链路同样与当前实现脱节，2 条断言固定失败。
 * 这三套不是「功能坏了」，是「测试过期」；修完前不要拿它们判断发版质量。
 */
const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

const ROOT = path.resolve(__dirname, '..')
const DIR = __dirname
const PREFIX = 'test-ced-'
const SKIP = {
  store: '早期本地存储版单测，store 云同步改造后 API 已移除（setup is not a function）',
  asr: 'ASR mock 与当前 utils/asr.js 契约脱节，且依赖被 gitignore 的真实凭据',
  speech: '语音转文字降级链路断言与当前实现脱节（2 条固定失败）'
}

const args = process.argv.slice(2)
const flag = (name) => args.indexOf(name) >= 0
const valueOf = (name) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] && args[i + 1][0] !== '-' ? args[i + 1] : ''
}

function suites() {
  return fs
    .readdirSync(DIR)
    .filter((f) => f.startsWith(PREFIX) && f.endsWith('.js'))
    .sort()
    .map((f) => f.slice(PREFIX.length, -3))
}

function selected() {
  const only = valueOf('--only')
  let list = suites()
  if (only) {
    const wanted = only.split(',').map((s) => s.trim().replace(/^test-ced-/, '')).filter(Boolean)
    const unknown = wanted.filter((w) => list.indexOf(w) < 0)
    if (unknown.length) {
      console.error('未知套件: ' + unknown.join(', '))
      process.exit(2)
    }
    list = wanted
  } else if (!flag('--all')) {
    list = list.filter((n) => !SKIP[n])
  }
  return list
}

if (flag('--list')) {
  const all = suites()
  console.log('共 ' + all.length + ' 套：\n')
  all.forEach((n) => {
    const state = SKIP[n] ? 'SKIP  ' : 'RUN   '
    console.log('  ' + state + n.padEnd(16) + (SKIP[n] || ''))
  })
  console.log('\n默认跑 ' + all.filter((n) => !SKIP[n]).length + ' 套，--all 连遗留一起跑。')
  process.exit(0)
}

const list = selected()
const verbose = flag('--verbose')
const skipped = flag('--all') ? [] : suites().filter((n) => SKIP[n] && list.indexOf(n) < 0)
const failed = []
const started = Date.now()

console.log('PDCA 好习惯 · 回归测试（' + list.length + ' 套）\n')
list.forEach((name, i) => {
  const r = spawnSync(process.execPath, [path.join(DIR, PREFIX + name + '.js')], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 120000
  })
  const out = ((r.stdout || '') + (r.stderr || '')).trim()
  const last = out ? out.split('\n').filter((l) => l.trim()).slice(-1)[0].trim() : '(无输出)'
  const okRun = r.status === 0 && !r.error && !r.signal
  if (!okRun) failed.push({ name, out, status: r.status, error: r.error, signal: r.signal })
  const tag = okRun ? '\x1b[32mOK  \x1b[0m' : '\x1b[31mFAIL\x1b[0m'
  console.log('[' + String(i + 1).padStart(2) + '/' + list.length + '] ' + tag + ' ' + name.padEnd(16) + last.slice(0, 110))
  if (verbose && out) console.log(out + '\n')
})

if (!verbose) {
  console.log('')
  failed.forEach((f) => {
    console.log('===== ' + f.name + ' (exit ' + f.status + ') =====')
    console.log(f.out.split('\n').slice(-25).join('\n'))
    console.log('')
  })
}
if (skipped.length) {
  console.log('跳过历史遗留：' + skipped.join(', ') + '（--list 看原因，--all 强制运行）')
}
const sec = ((Date.now() - started) / 1000).toFixed(1)
console.log('\n结果：' + (list.length - failed.length) + ' 套通过 / ' + failed.length + ' 套失败 / ' + skipped.length + ' 套跳过，' + sec + 's')
process.exit(failed.length ? 1 : 0)
