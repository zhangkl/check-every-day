#!/usr/bin/env node
/*
 * 弱网写入压测（发布前门禁）
 *
 *   node tests/check-weaknet.js                跑矩阵 + 一次真实延迟写入
 *   node tests/check-weaknet.js --no-real     只跑虚拟时钟矩阵（CI 快）
 *   node tests/check-weaknet.js --json        机器可读
 *
 * 做法：用内存假云（PostgREST 语义 + rev 乐观锁）接住 utils/store.js 的真实写入链路，
 * 按上行带宽把 doc 字节数换算成传输耗时，注入 RTT 与超时。
 * 「虚拟时钟」不真的 sleep，用于快速跑完 3 档网络 × 3 档体积的矩阵；
 * 末尾另跑一次真实 setTimeout 的弱网写入，验链路在真实延迟下 rev / 余额 / 流水都正确。
 *
 * 假设：请求超时 15s（微信云数据库 SDK 实际值受配置影响，这里取保守值）；
 * 传输耗时 = payload 字节 / 上行带宽，不含服务端处理与重传。
 * 关注：写失败时 mutate() 是否正确回滚、重试是否重复加分、成功时 rev 是否递增。
 */
const path = require('path')
const Module = require('module')
const ROOT = path.resolve(__dirname, '..')

/* ---------------- wx / 云 假实现 ---------------- */
const storage = {}
global.wx = {
  getStorageSync(k) { return storage[k] === undefined ? '' : storage[k] },
  setStorageSync(k, v) { storage[k] = JSON.parse(JSON.stringify(v)) },
  removeStorageSync(k) { delete storage[k] },
  getAccountInfoSync() { return { miniProgram: { appId: 'wxtestappid' } } },
  login(o) { o.success && o.success({ code: 'fake-code' }) },
  showToast() {}, showLoading() {}, hideLoading() {}
}
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const net = {
  rttMs: 80,
  upBps: 2 * 1024 * 1024 / 8,
  timeoutMs: 15000,
  failEvery: 0, // 0 = 不注入随机失败；n = 每 n 次写失败 1 次
  real: false,
  scale: 1,
  clockMs: 0,
  writes: 0,
  timeouts: 0,
  injected: 0
}

const db = {
  session: { user: { id: 'u-p1' } },
  families: [],
  members: []
}
const UID = () => db.session && db.session.user.id

async function transmit(payloadBytes) {
  const ms = Math.round(net.rttMs + payloadBytes / net.upBps * 1000)
  net.clockMs += ms
  if (net.real) await sleep(Math.min(Math.round(ms * net.scale), 4000))
  return ms
}

class Builder {
  constructor(table, op, payload) {
    this.table = table; this.op = op; this.payload = payload
    this.filters = []; this.cols = '*'; this.isSingle = false
  }
  select(cols) { this.cols = cols || '*'; return this }
  eq(c, v) { this.filters.push([c, v]); return this }
  single() { this.isSingle = true; return this }
  maybeSingle() { this.isSingle = true; return this }
  then(res, rej) { return this.run().then(res, rej) }
  rows() {
    return this.table === 'ced_families' ? db.families : db.members
  }
  visible(row) {
    if (this.table === 'ced_members') return row.owner_id === UID()
    const mine = db.members.filter((m) => m.owner_id === UID()).map((m) => String(m.family_id))
    return row.owner_id === UID() || mine.indexOf(String(row.id)) >= 0
  }
  match(row) { return this.filters.every(([c, v]) => String(row[c]) === String(v)) }
  shape(row) {
    if (!row) return null
    if (this.cols === '*') return clone(row)
    const out = {}
    this.cols.split(',').forEach((c) => { out[c.trim()] = clone(row[c.trim()]) })
    return out
  }
  async run() {
    const payloadBytes = this.op === 'update' ? Buffer.byteLength(JSON.stringify(this.payload)) : 1200
    const ms = await transmit(payloadBytes)
    if (ms > net.timeoutMs) {
      net.timeouts += 1
      return { data: null, error: { message: 'network timeout', code: 'ETIMEDOUT' } }
    }
    if (this.op === 'update') {
      net.writes += 1
      if (net.failEvery && net.writes % net.failEvery === 0) {
        net.injected += 1
        return { data: null, error: { message: 'network dropped', code: 'ENETUNREACH' } }
      }
      const rows = this.rows().filter((r) => this.visible(r) && this.match(r))
      rows.forEach((r) => Object.assign(r, clone(this.payload)))
      return { data: rows.map((r) => this.shape(r)), error: null }
    }
    if (this.op === 'insert') {
      const row = Object.assign({ id: db.families.length + 1, owner_id: UID(), rev: 1 }, clone(this.payload))
      this.rows().push(row)
      return { data: [this.shape(row)], error: null }
    }
    const rows = this.rows().filter((r) => this.visible(r) && this.match(r))
    if (this.isSingle) {
      if (rows.length !== 1) return { data: null, error: { code: 'PGRST116' } }
      return { data: this.shape(rows[0]), error: null }
    }
    return { data: rows.map((r) => this.shape(r)), error: null }
  }
}
const fakeCloud = {
  auth: {
    async getSession() { return { data: { user: db.session.user }, error: null } },
    async signOut() { return { error: null } },
    async signInWithWechat() { return { error: null } }
  },
  database: {
    from(t) {
      const b = new Builder(t, 'select')
      b.insert = (p) => new Builder(t, 'insert', p)
      b.update = (p) => new Builder(t, 'update', p)
      return b
    },
    rpc() { return Promise.resolve({ data: [], error: null }) }
  }
}
const ORIGINAL_LOAD = Module._load
Module._load = function (request) {
  if (request === '@tencent-ai/workbuddy-cloud-sdk/miniprogram') return { createMiniProgramWorkBuddyCloud: () => fakeCloud }
  if (request === './workbuddy-cloud-diagnostics') return { createDiagnosticWx: (wx) => wx }
  return ORIGINAL_LOAD.apply(this, arguments)
}
function freshStore() {
  Object.keys(require.cache).forEach((k) => { if (k.indexOf(path.join(ROOT, 'utils')) === 0) delete require.cache[k] })
  return require(path.join(ROOT, 'utils/store.js'))
}

/* ---------------- 构造目标体积的 doc ---------------- */
function makeDoc(targetBytes) {
  const doc = {
    v: 1,
    family: { name: '压测家', childName: '墨墨' },
    groups: [], templates: [], gifts: [], wishes: [], redemptions: [], coupons: [],
    sheets: {}, logs: [], activities: [], notices: [], profile: {}
  }
  const day0 = new Date('2026-08-01T00:00:00Z')
  let d = 0
  // 最多造 150 天：超过 160 天会触发 store.prune() 裁剪，压测就不是这个体积了
  while (Buffer.byteLength(JSON.stringify(doc)) < targetBytes && d < 150) {
    const day = new Date(day0.getTime() + d * 86400000).toISOString().slice(0, 10)
    const items = []
    for (let i = 0; i < 11; i++) {
      items.push({
        id: 'it' + d + '_' + i, taskId: 'tk' + i, groupKey: 'g1', groupTitle: '校内作业',
        groupIcon: '📚', groupSort: 0, title: '第' + i + '项', points: 2, sort: i,
        done: i % 2 === 0, doneAt: day0.getTime() + d * 86400000, status: 'approved',
        voices: i % 3 === 0 ? [{
          id: 'v' + d + '_' + i, uid: 'u-c1', role: 'child', path: 'cloud://shared/voice/x.mp3',
          duration: 18, at: day0.getTime(), text: '今天完成了这一项，还有一些想说的话'.repeat(30),
          likes: 0, liked: false, comments: []
        }] : []
      })
    }
    doc.sheets[day] = { items }
    doc.logs.push({ id: 'l' + d, kind: 'task', amount: 2, day, note: '第1项', refId: null, uid: 'u-c1', role: 'child', at: day0.getTime() + d * 86400000 })
    d += 1
  }
  return doc
}

function resetDb(doc) {
  Object.keys(storage).forEach((k) => delete storage[k])
  db.families = [{ id: 7, owner_id: 'u-p1', rev: 1, doc: clone(doc), invite_code: 'ABC123', parent_invite_code: 'ABC123' }]
  db.members = [{ id: 1, family_id: 7, owner_id: 'u-p1', member_role: 'parent' }]
  net.clockMs = 0; net.writes = 0; net.timeouts = 0; net.injected = 0
}

async function runCase(label, sizeName, docBytes, link, opts) {
  net.rttMs = link.rtt
  net.upBps = link.bps
  net.timeoutMs = 15000
  net.real = !!opts.real
  net.scale = opts.scale || 1
  net.failEvery = opts.failEvery || 0
  const doc = makeDoc(docBytes)
  const realBytes = Buffer.byteLength(JSON.stringify(doc))
  resetDb(doc)
  const st = freshStore()
  const boot = await st.bootstrap()
  st.setRole('parent')
  if (!boot.ok) return { label, sizeName, error: 'bootstrap: ' + JSON.stringify(boot) }
  const before = st.balance()
  const rev0 = db.families[0].rev
  const ms0 = net.clockMs

  const t0 = Date.now()
  const r1 = await st.adjustPoints(1, '弱网压测')
  const elapsed = net.clockMs - ms0
  const ok1 = !!r1.ok
  const bal1 = st.balance()
  const rev1 = db.families[0].rev

  // 二次写入：模拟用户手动重试，此时网络已恢复；验证回滚后不重复加分
  net.failEvery = 0
  net.rttMs = 80
  net.upBps = 2 * 1024 * 1024 / 8
  const r2 = await st.adjustPoints(1, '弱网压测2')
  const bal2 = st.balance()

  const consistent = ok1
    ? (bal1 === before + 1 && rev1 === rev0 + 1)
    : (bal1 === before && rev1 === rev0)
  const retryOk = !!r2.ok && bal2 === bal1 + 1
  const wall = Date.now() - t0
  const timeout = elapsed > net.timeoutMs
  return {
    label, sizeName, docBytes: realBytes, ok1, elapsed, wall, timeout,
    consistent, retryOk, bal0: before, bal1, bal2,
    timeouts: net.timeouts, injected: net.injected
  }
}

const LINKS = [
  { name: '4G 良好 2 Mbps', rtt: 80, bps: 2 * 1024 * 1024 / 8 },
  { name: '弱网 200 Kbps', rtt: 600, bps: 200 * 1024 / 8 },
  { name: '极弱 50 Kbps', rtt: 1200, bps: 50 * 1024 / 8 }
]
const SIZES = [
  { name: '当前规模', bytes: 48 * 1024 },
  { name: '中期规模', bytes: 500 * 1024 },
  { name: '保留上限', bytes: 1024 * 1024 }
]

async function main() {
  const args = process.argv.slice(2)
  const noReal = args.indexOf('--no-real') >= 0
  const asJson = args.indexOf('--json') >= 0
  const rows = []
  for (const size of SIZES) {
    for (const link of LINKS) {
      rows.push(await runCase(link.name, size.name, size.bytes, link, {}))
    }
  }
  // 丢包注入：当前体积 + 弱网，第 1 次写失败，验证回滚与重试
  const drop = await runCase('弱网 + 丢包注入', '当前规模', 48 * 1024, LINKS[1], { failEvery: 1 })
  // 真实等待一次：当前体积 + 弱网（约 2s），验证真实延迟下链路正确
  let real = null
  if (!noReal) {
    real = await runCase('真实延迟 弱网 200 Kbps', '当前 48 KB', 48 * 1024, LINKS[1], { real: true, scale: 1 })
  }

  const all = rows.concat([drop], real ? [real] : [])
  const broken = all.filter((r) => r.error || !r.consistent || !r.retryOk)
  if (asJson) {
    console.log(JSON.stringify({ rows, drop, real, broken }, null, 2))
  } else {
    console.log('\n=== 弱网写入压测（mutate → flush 真实链路，超时假设 15s）===')
    console.log('体积档位'.padEnd(18) + '实际'.padEnd(10) + '网络'.padEnd(20) + '首次写'.padEnd(10) + '预估耗时'.padEnd(12) + '回滚/重试(网络恢复后)')
    rows.concat([drop]).forEach((r) => {
      const state = r.error ? 'ERROR' : r.ok1 ? '成功' : (r.timeout ? '超时' : '失败')
      console.log(
        r.sizeName.padEnd(18) + (Math.round(r.docBytes / 1024) + 'KB').padEnd(10) +
        r.label.padEnd(20) + state.padEnd(10) +
        (r.elapsed / 1000).toFixed(1).padStart(5) + ' s     ' +
        (r.consistent ? '回滚正确' : '不一致!') + ' / ' + (r.retryOk ? '重试正常' : '重试异常!')
      )
    })
    if (real) {
      console.log('\n真实等待写入：' + (real.ok1 ? '成功' : '失败') +
        '，墙钟 ' + (real.wall / 1000).toFixed(1) + 's，rev/余额一致=' + real.consistent + '，重试正常=' + real.retryOk)
    }
    console.log('\n一致性异常：' + broken.length + ' 例')
    console.log('说明：普通网络错误不会自动重试，mutate() 直接回滚内存并报错，用户需手动再点一次。')
  }
  process.exit(broken.length ? 1 : 0)
}
main().catch((e) => { console.error(e); process.exit(1) })
