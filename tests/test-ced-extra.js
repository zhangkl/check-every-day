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

  const totalBefore = store.todayOverview().total
  const balBefore = store.balance()

  /* 1. 学生加项 → pending */
  const add = await store.addExtraToday('自己练了一页口算', 8, true)
  ok(add.ok, '学生可以加临时项')
  const ov1 = store.todayOverview()
  const pendItem = ov1.groups.flatMap(g => g.items).filter(i => i.title === '自己练了一页口算')[0]
  ok(!!pendItem, '临时项出现在今天清单')
  ok(pendItem.status === 'pending', '状态为待同意')
  ok(ov1.total === totalBefore, '待同意项不计入 total')
  ok(store.balance() === balBefore, '待同意不加积分')

  /* 2. 学生不能打卡待同意项 */
  const t1 = await store.toggleItem(day, pendItem.id)
  ok(!t1.ok, '学生打卡待同意项被拦截')

  /* 3. 家长改分值 */
  const up = await store.updateExtraPoints(day, pendItem.id, 10)
  ok(up.ok && up.points === 10, '家长改分值为 10')
  const ov2 = store.todayOverview()
  ok(ov2.groups.flatMap(g => g.items).filter(i => i.id === pendItem.id)[0].points === 10, '清单里分值已更新')

  /* 4. 家长勾选同意 */
  const ap = await store.approveExtra(day, pendItem.id)
  ok(ap.ok && ap.points === 10, '家长同意成功')
  const ov3 = store.todayOverview()
  ok(ov3.total === totalBefore + 1, '同意后计入 total')
  ok(ov3.groups.flatMap(g => g.items).filter(i => i.id === pendItem.id)[0].status === 'approved', '状态变为已同意')

  /* 5. 同意后学生可以打卡得分 */
  const t2 = await store.toggleItem(day, pendItem.id)
  ok(t2.ok && t2.done, '同意后学生能打卡')
  ok(store.balance() === balBefore + 10, '打卡 +10 分入账')

  /* 6. 拒绝：再造一个学生临时项，家长拒绝 */
  await store.addExtraToday('想多看一集动画片', 3, true)
  const ov4 = store.todayOverview()
  const p2 = ov4.groups.flatMap(g => g.items).filter(i => i.title === '想多看一集动画片')[0]
  const rj = await store.rejectExtra(day, p2.id)
  ok(rj.ok, '家长可以拒绝')
  ok(!store.todayOverview().groups.flatMap(g => g.items).some(i => i.id === p2.id), '拒绝后从清单消失')
  // 模板任务也删掉了
  const doc = db.families[0].doc
  ok(!doc.tasks.some(t => t.title === '想多看一集动画片'), '模板里的临时任务也删掉')

  /* 7. 家长自己的临时项不受影响（直接生效） */
  const before7 = store.todayOverview().total
  await store.addExtraToday('家长临时加的', 5, false)
  const ov5 = store.todayOverview()
  const p3 = ov5.groups.flatMap(g => g.items).filter(i => i.title === '家长临时加的')[0]
  ok(p3.status === 'approved', '家长加项直接生效')
  ok(ov5.total === before7 + 1, '家长加项直接计入 total')

  /* 8. 待同意项不挡满勤：全新本地场景，只剩待同意项未打卡时 percent=100 */
  const store3 = freshStore()
  store3.startLocal('满勤测试', '朵朵')
  const day3 = require(path.join(ROOT, 'utils/date')).today()
  await store3.addExtraToday('临时想加的', 5, true)
  const ovA = store3.todayOverview()
  for (const g of ovA.groups) {
    for (const it of g.items) {
      if (it.status !== 'pending' && !it.done) await store3.toggleItem(day3, it.id)
    }
  }
  const ovB = store3.todayOverview()
  ok(ovB.total > 0 && ovB.done === ovB.total && ovB.percent === 100, '只剩待同意项未打卡时仍算满勤进度')
  ok(ovB.groups.flatMap(g => g.items).some(i => i.status === 'pending'), '待同意项仍然可见')

  /* 9. 老数据兼容：手工把 status 字段去掉 → 视为已同意 */
  const items = doc.sheets[day].items
  const first = items[0]
  delete first.status
  Object.keys(require.cache).forEach(k => { if (k.indexOf(path.join(ROOT, 'utils')) === 0) delete require.cache[k] })
  const store2 = freshStore()
  await store2.bootstrap()
  const ov6 = store2.todayOverview()
  const first2 = ov6.groups.flatMap(g => g.items).filter(i => i.id === first.id)[0]
  ok(first2.status === 'approved', '老数据无 status 自动视为已同意')

  /* 10. 改分值只对待同意项生效 */
  const up2 = await store2.updateExtraPoints(day, first2.id, 99)
  ok(!up2.ok, '已同意的项不能改分值')
  const rj2 = await store2.rejectExtra(day, first2.id)
  ok(!rj2.ok, '已同意的项不能拒绝')

  console.log('学生临时加项审批：通过 ' + pass + ' 条')
  if (process.exitCode) process.exit(1)
}
main().catch(e => { console.error('测试异常:', e); process.exit(1) })
