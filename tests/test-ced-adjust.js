/* 手动调分：一句原因要同时进积分流水 + 孩子的消息；超长/空值要兜底 */
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
        if (rows.length !== 1) return { data: null, error: { code: 'PGRST116' } }
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
        db.members.push({ id: db.seq, family_id: fam.id, owner_id: uid, member_role: params.p_role || 'child' })
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
async function as(uid, role) {
  db.session = { user: { id: uid } }
  const st = freshStore()
  const r = await st.bootstrap()
  st.setRole(role)
  return { st, r }
}
const adjusts = st => st.listNotices().filter(n => n.kind === 'adjust')

async function main() {
  let a = await as('u-p1', 'parent')
  ok((await a.st.createFamily('测试家', '墨墨')).ok, '创建家庭')
  a.st.setRole('parent')
  await a.st.setMyLabel('帅爹')
  const code = a.st.getInviteCode()

  db.session = { user: { id: 'u-c1' } }
  let kid = freshStore()
  ok((await kid.joinFamily(code, { role: 'child' })).ok, '孩子用码加入')
  await kid.bootstrap()
  kid.setRole('child')

  // ① 加分带说明：流水记原因，孩子收到带原因的消息
  let p = (await as('u-p1', 'parent')).st
  ok((await p.adjustPoints(5, '主动练琴')).ok, '加分保存')
  let l = p.logs(1)[0]
  ok(l.kind === 'adjust' && l.amount === 5, '流水记 5 分')
  ok(l.note === '主动练琴', '流水里写明原因，而不是「家长额外奖励」')
  ok(adjusts(p).length === 0, '操作的家长自己不收提醒')
  kid = (await as('u-c1', 'child')).st
  ok(adjusts(kid).length === 1, '孩子收到一条调分提醒')
  ok(adjusts(kid)[0].text === '给你加了 5 分（主动练琴）', '孩子消息里能看到原因')

  // ② 扣分也带说明
  p = (await as('u-p1', 'parent')).st
  ok((await p.adjustPoints(-3, '拖到很晚才睡')).ok, '扣分保存')
  l = p.logs(1)[0]
  ok(l.amount === -3 && l.note === '拖到很晚才睡', '扣分流水带原因')
  kid = (await as('u-c1', 'child')).st
  ok(adjusts(kid)[0].text === '给你减了 3 分（拖到很晚才睡）', '扣分消息带原因')

  // ③ 说明清洗：换行/空白合并、超长截断
  p = (await as('u-p1', 'parent')).st
  ok((await p.adjustPoints('2', '  主动 \n 帮忙  做家务还叠了被子  ')).ok, '带脏字符的说明也能存')
  l = p.logs(1)[0]
  ok(l.note === '主动 帮忙 做家务还叠了' && !/\s{2,}|\n/.test(l.note), '空白合并且截到 12 字：' + l.note)
  ok(l.amount === 2 && typeof l.amount === 'number', '分值转成数字，不会污染积分求和')

  // ④ 老调用/空说明：回退到原来的兜底文案
  p = (await as('u-p1', 'parent')).st
  ok((await p.adjustPoints(1)).ok, '不传说明不报错')
  ok(p.logs(1)[0].note === '家长额外奖励', '空说明回退默认文案')
  p = (await as('u-p1', 'parent')).st
  ok(p.balance() === 5 - 3 + 2 + 1, '积分总额正确')

  console.log('  ' + pass + ' 项通过')
}
main().catch(e => { console.error(e); process.exitCode = 1 })
