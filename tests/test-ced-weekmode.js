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
  ok((await store.createFamily('测试家', '朵朵')).ok, '创建家庭')
  const dateUtil = require(path.join(ROOT, 'utils/date'))

  // 找一个周中日期和一个周末日期（未来 14 天内）
  let weekDay = null, weekendDay = null
  for (let i = 1; i <= 14; i++) {
    const k = dateUtil.addDays(dateUtil.today(), i)
    const wd = dateUtil.weekday(k)
    if (!weekDay && wd >= 1 && wd <= 5) weekDay = k
    if (!weekendDay && wd >= 6) weekendDay = k
  }
  ok(weekDay && weekendDay, '找到周中和周末测试日期')

  // 默认模板每天都出现
  const sw = store.ensureSheet(weekDay)
  const se = store.ensureSheet(weekendDay)
  ok(sw.items.length > 0 && se.items.length > 0, '默认模板周中周末都有清单')

  // 把第一个大项设为仅周末，第二个设为仅周中
  const groups = store.listTaskGroups()
  ok(groups.length >= 2, '默认模板至少两个大项')
  const gWeekend = groups[0]
  const gWeek = groups[1]
  ok((await store.updateGroup(gWeekend.groupKey, { repeatDays: [6, 7] })).ok, '大项1设为仅周末')
  ok((await store.updateGroup(gWeek.groupKey, { repeatDays: [1, 2, 3, 4, 5] })).ok, '大项2设为仅周中')

  const sw2 = store.todayOverviewFor ? null : null
  // 用新的一天日期验证（ensureSheet 已缓存旧日期）
  let w1 = null, w2 = null
  for (let i = 15; i <= 28; i++) {
    const k = dateUtil.addDays(dateUtil.today(), i)
    const wd = dateUtil.weekday(k)
    if (!w1 && wd >= 1 && wd <= 5) w1 = k
    if (!w2 && wd >= 6) w2 = k
  }
  const sheetWeek = store.ensureSheet(w1)
  const sheetWeekend = store.ensureSheet(w2)
  const weekKeys = [...new Set(sheetWeek.items.map(i => i.groupKey))]
  const weekendKeys = [...new Set(sheetWeekend.items.map(i => i.groupKey))]
  ok(weekKeys.indexOf(gWeekend.groupKey) < 0, '周中清单不含「仅周末」大项')
  ok(weekKeys.indexOf(gWeek.groupKey) >= 0, '周中清单含「仅周中」大项')
  ok(weekendKeys.indexOf(gWeekend.groupKey) >= 0, '周末清单含「仅周末」大项')
  ok(weekendKeys.indexOf(gWeek.groupKey) < 0, '周末清单不含「仅周中」大项')

  // listTaskGroups 的 todayOn 标记（供配置页计数）
  const listed = store.listTaskGroups()
  const l1 = listed.filter(g => g.groupKey === gWeekend.groupKey)[0]
  const l2 = listed.filter(g => g.groupKey === gWeek.groupKey)[0]
  ok(!l1.todayOn && l2.todayOn, 'todayOn 按今天星期正确标记')

  console.log('周中/周末链路：通过 ' + pass + ' 条')
  if (process.exitCode) process.exit(1)
}
main().catch(e => { console.error('测试异常:', e); process.exit(1) })
