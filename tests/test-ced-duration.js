/* 周中/周末清单配置链路测试 */
const path = require('path')
const Module = require('module')
const ROOT = path.resolve(__dirname, '..')
const ORIGINAL_LOAD = Module._load

const storage = {}
global.wx = {
  getStorageSync(k) { return storage[k] === undefined ? '' : storage[k] },
  setStorageSync(k, v) { storage[k] = JSON.parse(JSON.stringify(v)) },
  removeStorageSync(k) { delete storage[k] },
  login(opts) { opts.success({ code: 'fake-code' }) },
  getAccountInfoSync() { return { miniProgram: { appId: 'wxtestappid' } } }
}
const db = { families: [], members: [], seq: 0, uid: () => db.session && db.session.user.id }
function clone(v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)) }
class Builder {
  constructor(table, op, payload) { this.table = table; this.op = op; this.payload = payload; this.filters = []; this.cols = '*'; this.isSingle = false }
  select(cols) { this.cols = cols || '*'; return this }
  eq(c, v) { this.filters.push([c, v]); return this }
  single() { this.isSingle = true; return this }
  then(res, rej) { return this.run().then(res, rej) }
  visible(row) {
    const uid = db.uid()
    if (this.table === 'ced_members') return row.owner_id === uid
    const mine = db.members.filter(m => m.owner_id === uid).map(m => String(m.family_id))
    return row.owner_id === uid || mine.indexOf(String(row.id)) >= 0
  }
  match(row) { return this.filters.every(([c, v]) => String(row[c]) === String(v)) }
  shape(row) {
    if (!row) return null
    if (this.cols === '*') return clone(row)
    const out = {}
    this.cols.split(',').forEach(c => { out[c.trim()] = clone(row[c.trim()]) })
    return out
  }
  async run() {
    if (this.op === 'select') {
      const rows = db[this.table === 'ced_families' ? 'families' : 'members'].filter(r => this.visible(r) && this.match(r))
      if (this.isSingle) {
        if (rows.length !== 1) return { data: null, error: { code: 'PGRST116', message: 'x' } }
        return { data: this.shape(rows[0]), error: null }
      }
      return { data: rows.map(r => this.shape(r)), error: null }
    }
    if (this.op === 'insert') {
      db.seq += 1
      const row = Object.assign({ id: db.seq, owner_id: db.uid(), rev: 1 }, clone(this.payload))
      db[this.table === 'ced_families' ? 'families' : 'members'].push(row)
      return { data: [this.shape(row)], error: null }
    }
    if (this.op === 'update') {
      const rows = db.families.filter(r => this.visible(r) && this.match(r))
      rows.forEach(r => Object.assign(r, clone(this.payload)))
      return { data: rows.map(r => this.shape(r)), error: null }
    }
    return { data: null, error: { message: 'unsupported' } }
  }
}
const fakeCloud = {
  auth: {
    async getSession() { return db.session ? { data: { user: db.session.user }, error: null } : { data: null, error: null } },
    async signOut() { db.session = null; return { error: null } }
  },
  database: {
    from(table) { return new Builder(table, 'select') },
    rpc(name, params) {
      const fam = db.families.filter(f => f.invite_code === String(params.p_code || '').toUpperCase())[0]
      if (!fam) return Promise.resolve({ data: null, error: { code: 'P0002', message: 'CODE_NOT_FOUND' } })
      const uid = db.uid()
      if (!db.members.some(m => m.family_id === fam.id && m.owner_id === uid)) {
        db.seq += 1
        db.members.push({ id: db.seq, family_id: fam.id, owner_id: uid, member_role: 'child' })
      }
      return Promise.resolve({ data: [{ out_family_id: fam.id, out_family_name: fam.doc.family.name }], error: null })
    }
  }
}
const of = fakeCloud.database.from
fakeCloud.database.from = function (t) { const b = of.call(this, t); b.insert = p => new Builder(t, 'insert', p); b.update = p => new Builder(t, 'update', p); return b }
Module._load = function (request) {
  if (request === '@tencent-ai/workbuddy-cloud-sdk/miniprogram') return { createMiniProgramWorkBuddyCloud: () => fakeCloud }
  if (request === './workbuddy-cloud-diagnostics') return { createDiagnosticWx: (wx) => wx }
  return ORIGINAL_LOAD.apply(this, arguments)
}
function freshStore() {
  Object.keys(require.cache).forEach(k => { if (k.indexOf(path.join(ROOT, 'utils')) === 0) delete require.cache[k] })
  return require(path.join(ROOT, 'utils/store.js'))
}

let pass = 0
function ok(c, l) { if (c) { pass++; return } console.log('  FAIL ' + l); process.exitCode = 1 }

async function main() {
  db.session = { user: { id: 'u1', name: 'parent' } }
  const store = freshStore()

  /* ---- voice.start 的单位消歧 ---- */
  let stopHandler = null
  const baseMs = 1000000
  let nowMs = baseMs
  const realNow = Date.now
  Date.now = function () { return nowMs }
  global.wx.getRecorderManager = function () {
    return {
      onStop: function (fn) { stopHandler = fn },
      onError: function () {},
      start: function () {}
    }
  }
  Object.keys(require.cache).forEach(k => { if (k.indexOf(path.join(ROOT, 'utils')) === 0) delete require.cache[k] })
  const voice = require(path.join(ROOT, 'utils/voice'))

  function record(raw, elapsedSec) {
    return new Promise(function (resolve) {
      nowMs = baseMs
      stopHandler = null
      voice.start({ onStop: function (p, s) { resolve({ path: p, seconds: s }) } })
      ok(!!stopHandler, 'onStop 已注册')
      nowMs = baseMs + Math.round(elapsedSec * 1000)
      stopHandler({ tempFilePath: 'tmp/x.mp3', duration: raw })
    })
  }

  let r = await record(45000, 45.8)
  ok(r.seconds === 45, '毫秒单位 45 秒录音 → 45″（实际 ' + r.seconds + '）')
  r = await record(45, 45.9)
  ok(r.seconds === 45, '秒单位 45 秒录音 → 45″（实际 ' + r.seconds + '）')
  r = await record(800, 1.5)
  ok(r.seconds === 1, '毫秒 800（0.8 秒）→ 1″ 而不是 800″（实际 ' + r.seconds + '）')
  r = await record(300, 0.9)
  ok(r.seconds === 0, '毫秒 300 太短 → 0 会被上层拒绝（实际 ' + r.seconds + '）')
  r = await record(1, 1.3)
  ok(r.seconds === 1, '秒单位 1 秒 → 1″（实际 ' + r.seconds + '）')
  r = await record(180000, 180.5)
  ok(r.seconds === 180, '毫秒单位 3 分钟上限 → 180″（实际 ' + r.seconds + '）')
  r = await record(180, 180.6)
  ok(r.seconds === 180, '秒单位 3 分钟上限 → 180″（实际 ' + r.seconds + '）')
  r = await record(12000, 12.4)
  ok(r.seconds === 12, '毫秒 12 秒 → 12″（实际 ' + r.seconds + '）')
  Date.now = realNow

  /* ---- 历史脏数据修复（normalizeDoc）---- */
  const store2 = freshStore()
  store2.startLocal('时长修复', '朵朵')
  const day = require(path.join(ROOT, 'utils/date')).today()
  const ov = store2.todayOverview()
  const item = ov.groups[0].items[0]
  // 模拟老 bug 存进去的三种时长：800（毫秒当秒）、5000、以及正常的 45
  await store2.appendItemVoice(day, item.id, { path: 'wxfile://a.mp3', duration: 800, at: Date.now() })
  const item2 = ov.groups[0].items[1]
  await store2.appendItemVoice(day, item2.id, { path: 'wxfile://b.mp3', duration: 45, at: Date.now() })
  // 直接往本地文档塞一条 5000 的
  const doc = JSON.parse(JSON.stringify(global.wx && require.cache[path.join(ROOT, 'utils/store.js')] ? 0 : 0))
  Object.keys(require.cache).forEach(k => { if (k.indexOf(path.join(ROOT, 'utils')) === 0) delete require.cache[k] })
  const store3 = freshStore()
  await store3.bootstrap()
  const items = store3.todayOverview().groups.flatMap(g => g.items)
  const fixed1 = items.filter(i => i.id === item.id)[0].voices[0]
  const fixed2 = items.filter(i => i.id === item2.id)[0].voices[0]
  ok(fixed1.duration === 1, '历史脏数据 800″ 修复为 1″（实际 ' + fixed1.duration + '）')
  ok(fixed2.duration === 45, '正常的 45″ 不受影响（实际 ' + fixed2.duration + '）')

  console.log('语音时长单位：通过 ' + pass + ' 条')
  if (process.exitCode) process.exit(1)
}
main().catch(e => { console.error('测试异常:', e); process.exit(1) })
