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

  const groups = store.listTaskGroups()
  const g2 = groups.filter(g => g.children.length === 2)[0]
  ok(!!g2, '找到两子项的组')
  const gk = g2.groupKey
  const children = g2.children
  ok(children.length >= 2, '组内有子项')
  const c0 = children[0]
  const c1 = children[1]

  // c0 仅周末，c1 保持每天
  ok((await store.updateChild(c0.id, { repeatDays: [6, 7] })).ok, '子项设为仅周末')

  let w = null, e = null
  for (let i = 1; i <= 30; i++) {
    const k = dateUtil.addDays(dateUtil.today(), i)
    const wd = dateUtil.weekday(k)
    if (!w && wd === 1) w = k
    if (!e && wd === 6) e = k
  }
  const sheetW = store.ensureSheet(w)
  const sheetE = store.ensureSheet(e)
  const wTitles = sheetW.items.filter(i => i.groupKey === gk).map(i => i.title)
  const eTitles = sheetE.items.filter(i => i.groupKey === gk).map(i => i.title)
  ok(wTitles.indexOf(c0.title) < 0, '周一清单不含「仅周末」子项')
  ok(wTitles.indexOf(c1.title) >= 0, '周一清单含每天子项')
  ok(eTitles.indexOf(c0.title) >= 0, '周六清单含「仅周末」子项')
  ok(eTitles.indexOf(c1.title) >= 0, '周六清单含每天子项')

  // 组内子项全部设为仅周末 → 周中该组整体消失
  await store.updateChild(c1.id, { repeatDays: [6, 7] })
  let w2 = null, e2 = null
  for (let i = 31; i <= 60; i++) {
    const k = dateUtil.addDays(dateUtil.today(), i)
    const wd = dateUtil.weekday(k)
    if (!w2 && wd === 2) w2 = k
    if (!e2 && wd === 7) e2 = k
  }
  const sheetW2 = store.ensureSheet(w2)
  const sheetE2 = store.ensureSheet(e2)
  ok(!sheetW2.items.some(i => i.groupKey === gk), '子项全为周末时，周中整组不出现')
  ok(sheetE2.items.some(i => i.groupKey === gk), '周末整组正常出现')

  // repeatDays 传空数组 → 回退为每天
  await store.updateChild(c0.id, { repeatDays: [] })
  const listed = store.listTaskGroups()
  const c0b = listed.filter(g => g.groupKey === gk)[0].children.filter(c => c.id === c0.id)[0]
  ok(c0b.repeatDays.length === 7, '空 repeatDays 回退为每天')

  // 老数据兼容：子项没有 repeatDays 字段 → 按每天处理
  db.families[0].doc.tasks.forEach(t => { if (t.id === c0.id) delete t.repeatDays })
  Object.keys(require.cache).forEach(k => { if (k.indexOf(path.join(ROOT, 'utils')) === 0) delete require.cache[k] })
  const store2 = freshStore()
  await store2.bootstrap()
  let w3 = null
  for (let i = 61; i <= 90; i++) {
    const k = dateUtil.addDays(dateUtil.today(), i)
    if (dateUtil.weekday(k) === 3) { w3 = k; break }
  }
  const sheetW3 = store2.ensureSheet(w3)
  ok(sheetW3.items.some(i => i.title === c0.title), '老数据无 repeatDays 的子项按每天处理')

  console.log('子项星期过滤：通过 ' + pass + ' 条')
  if (process.exitCode) process.exit(1)
}
main().catch(e => { console.error('测试异常:', e); process.exit(1) })
