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
  const day = require(path.join(ROOT, 'utils/date')).today()
  const ov0 = store.todayOverview()
  const first = ov0.groups[0].items[0]

  /* 1. 学生长按申请删除 */
  const r1 = await store.requestDelete(day, first.id)
  ok(r1.ok, '学生可以申请删除未完成项')
  ok(store.todayOverview().groups.flatMap(g => g.items).filter(i => i.id === first.id)[0].status === 'del-pending', '状态变为 del-pending')

  /* 2. 待删除期间不能打卡 */
  const t1 = await store.toggleItem(day, first.id)
  ok(!t1.ok, '待删除项不能打卡')
  ok(store.todayOverview().groups.some(g => g.items.some(i => i.id === first.id)), '待删除项仍在清单展示')

  /* 3. 学生重复申请被拦 */
  const r2 = await store.requestDelete(day, first.id)
  ok(!r2.ok, '重复申请被拦截')

  /* 4. 学生取消申请 */
  const r3 = await store.cancelDeleteRequest(day, first.id)
  ok(r3.ok, '学生可以取消申请')
  ok(store.todayOverview().groups.flatMap(g => g.items).filter(i => i.id === first.id)[0].status === 'approved', '取消后恢复 approved')
  ok((await store.toggleItem(day, first.id)).ok, '恢复后能打卡')
  // toggle 一次即为已完成，供第 5 步拦截测试

  /* 5. 已完成项不能申请删除，家长也不能直接删 */
  ok(!(await store.requestDelete(day, first.id)).ok, '已完成项不能申请删除')
  ok(!(await store.deleteItemToday(day, first.id)).ok, '已完成项不能直接删除')
  ok(!(await store.approveDelete(day, first.id)).ok, '非 del-pending 不能走同意删除')

  /* 6. 家长直接删除另一个未完成项：只影响今天，模板不动 */
  const ov1 = store.todayOverview()
  const second = ov1.groups[0].items[1]
  const totalBefore = ov1.total
  const d1 = await store.deleteItemToday(day, second.id)
  ok(d1.ok && d1.title === second.title, '家长可以删除未完成项')
  const ov2 = store.todayOverview()
  ok(ov2.total === totalBefore - 1, '删除后 total 减一')
  ok(!ov2.groups.flatMap(g => g.items).some(i => i.id === second.id), '清单里已消失')
  // 找个未来日期验证模板还在
  const dateUtil = require(path.join(ROOT, 'utils/date'))
  let future = null
  for (let i = 20; i <= 40; i++) {
    const k = dateUtil.addDays(dateUtil.today(), i)
    if (dateUtil.weekday(k) === 3) { future = k; break }
  }
  const futureSheet = store.ensureSheet(future)
  ok(futureSheet.items.some(i => i.title === second.title), '模板未动：未来日期该项照常出现')

  /* 7. 学生申请 → 家长拒绝 → 恢复可打卡 */
  const third = store.todayOverview().groups.flatMap(g => g.items).find(i => !i.done && i.status === 'approved')
  await store.requestDelete(day, third.id)
  const rj = await store.rejectDelete(day, third.id)
  ok(rj.ok && rj.title === third.title, '家长可以拒绝删除申请')
  ok(store.todayOverview().groups.flatMap(g => g.items).filter(i => i.id === third.id)[0].status === 'approved', '拒绝后恢复 approved')

  /* 8. 学生申请 → 家长同意 → 今天消失、模板不动 */
  const fourth = store.todayOverview().groups.flatMap(g => g.items).find(i => !i.done && i.status === 'approved')
  await store.requestDelete(day, fourth.id)
  const ap = await store.approveDelete(day, fourth.id)
  ok(ap.ok && ap.title === fourth.title, '家长同意删除')
  ok(!store.todayOverview().groups.flatMap(g => g.items).some(i => i.id === fourth.id), '同意后从今天清单消失')
  ok(store.ensureSheet(future).items.some(i => i.title === fourth.title), '模板未动：未来日期该项照常出现')

  /* 9. 待删除项不挡满勤口径与 pending 一致性：del-pending 计入 total */
  const fifth = store.todayOverview().groups.flatMap(g => g.items).find(i => !i.done && i.status === 'approved')
  const totBefore = store.todayOverview().total
  await store.requestDelete(day, fifth.id)
  ok(store.todayOverview().total === totBefore, '待删除项仍计入 total（还没删掉）')

  /* 10. 老数据兼容：无 status 字段的项可申请删除 */
  const doc = db.families[0].doc
  const sixth = store.todayOverview().groups.flatMap(g => g.items).find(i => !i.done && i.status === 'approved')
  delete doc.sheets[day].items.filter(i => i.id === sixth.id)[0].status
  Object.keys(require.cache).forEach(k => { if (k.indexOf(path.join(ROOT, 'utils')) === 0) delete require.cache[k] })
  const store2 = freshStore()
  await store2.bootstrap()
  const sixth2 = store2.todayOverview().groups.flatMap(g => g.items).filter(i => i.id === sixth.id)[0]
  ok(sixth2.status === 'approved', '老数据无 status 视为 approved')
  ok((await store2.requestDelete(day, sixth.id)).ok, '老数据项也能申请删除')

  console.log('删除今日项链路：通过 ' + pass + ' 条')
  if (process.exitCode) process.exit(1)
}
main().catch(e => { console.error('测试异常:', e); process.exit(1) })
