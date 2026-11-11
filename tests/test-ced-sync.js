/* 家长改模板后当天清单即时生效链路测试（syncTodaySheet） */
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
    rpc() { return Promise.resolve({ data: null, error: { code: 'P0002', message: 'CODE_NOT_FOUND' } }) }
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
  const dateUtil = require(path.join(ROOT, 'utils/date'))
  ok((await store.createFamily('测试家', '朵朵')).ok, '创建家庭')
  const today = dateUtil.today()
  const yesterday = dateUtil.addDays(today, -1)

  // 基线：今天和昨天都生成清单
  const sheetY = store.ensureSheet(yesterday)
  const sheetT = store.ensureSheet(today)
  ok(sheetT.items.length > 0, '今天清单已生成')
  ok(sheetT.items.every(it => it.taskId), '新快照每项都带 taskId')

  const g0 = store.listTaskGroups()[0]
  const g0child = g0.children[0]
  const item0 = sheetT.items.filter(it => it.taskId === g0child.id)[0]
  ok(!!item0, '今天清单里能找到第一个子项')

  // 1. 改子项标题+分值 → 当天立即生效
  await store.updateChild(g0child.id, { title: '语文朗读', points: 12 })
  let s = store.getSheet(today)
  let it0 = s.items.filter(x => x.id === item0.id)[0]
  ok(it0.title === '语文朗读' && it0.points === 12, '改标题分值当天生效')
  const y0 = sheetY.items.filter(x => x.taskId === g0child.id)[0]
  ok(y0 && y0.title === g0child.title && y0.points === g0child.points, '昨天的快照不受影响')

  // 2. 已打卡的项改分值 → done 保留、分数按新分值
  await store.toggleItem(today, item0.id)
  s = store.getSheet(today)
  it0 = s.items.filter(x => x.id === item0.id)[0]
  ok(it0.done === true, '打卡成功')
  await store.updateChild(g0child.id, { points: 20 })
  s = store.getSheet(today)
  it0 = s.items.filter(x => x.id === item0.id)[0]
  ok(it0.done === true && it0.points === 20, '已打卡项同步新分值且保留勾选')

  // 3. 子项改出现日期（不含今天）→ 今天消失
  const g1 = store.listTaskGroups()[1]
  const g1child = g1.children[0]
  await store.updateChild(g1child.id, { repeatDays: [1, 2, 3, 4, 5] }) // 假设今天周六/周日则保留，先看今天周几
  s = store.getSheet(today)
  const todayWd = dateUtil.weekday(today)
  const gone = !s.items.some(x => x.taskId === g1child.id)
  ok(gone === (todayWd >= 6), '改出现日期后按今天周几正确出现/消失')

  // 4. 原本不含今天 → 改成含今天 → 今天新增
  await store.updateChild(g1child.id, { repeatDays: [todayWd] })
  s = store.getSheet(today)
  let back = s.items.filter(x => x.taskId === g1child.id)[0]
  ok(back && back.status === 'approved' && back.done === false, '改回含今天后当天新增该项')

  // 5. 删除子项 → 未完成的今天消失
  await store.removeChild(g1child.id)
  s = store.getSheet(today)
  ok(!s.items.some(x => x.taskId === g1child.id), '删除子项后今天消失')

  // 6. 加子项 → 今天立即出现
  await store.addChild(g0.groupKey, '口算加练', 6)
  s = store.getSheet(today)
  const added = s.items.filter(x => x.title === '口算加练')[0]
  ok(added && added.points === 6 && added.taskId, '加子项当天立即出现')

  // 7. 停用整个组 → 整组未完成项消失
  const g2 = store.listTaskGroups()[2]
  const g2itemBefore = store.getSheet(today).items.filter(x => x.groupKey === g2.groupKey)
  await store.updateGroup(g2.groupKey, { active: false })
  s = store.getSheet(today)
  const g2left = s.items.filter(x => x.groupKey === g2.groupKey && !x.done && x.status === 'approved')
  ok(g2itemBefore.length > 0 && g2left.length === 0, '停用大项后未完成项当天消失')

  // 8. 已打卡项在模板移除后保留
  const g3 = store.listTaskGroups().filter(g => g.groupKey === g0.groupKey)[0]
  const g3child2 = g3.children.filter(c => c.id !== g0child.id)[0]
  if (g3child2) {
    const itB = store.getSheet(today).items.filter(x => x.taskId === g3child2.id)[0]
    if (itB) {
      await store.toggleItem(today, itB.id) // 打卡
      await store.removeChild(g3child2.id)
      s = store.getSheet(today)
      ok(s.items.some(x => x.id === itB.id && x.done), '已打卡项删除模板后当天保留')
    } else {
      pass++ // 该子项今天不存在则跳过
    }
  } else {
    pass++
  }

  // 9. 学生申请中的项（pending）不被同步删除
  const before = store.getSheet(today).items.length
  const r = await store.addExtraToday('自己加的口算', 5, true)
  ok(r.ok, '学生加项成功')
  s = store.getSheet(today)
  const pend = s.items.filter(x => x.status === 'pending')[0]
  ok(!!pend, 'pending 项存在')
  await store.updateChild(g0child.id, { title: '语文朗读第二版' })
  s = store.getSheet(today)
  ok(s.items.some(x => x.status === 'pending' && x.title === '自己加的口算'), '改模板后 pending 项保留')
  ok(s.items.some(x => x.taskId === g0child.id && x.title === '语文朗读第二版'), '改模板后标题继续同步')

  // 10. 删除整个大项 → 未完成项当天消失
  const lastGroup = store.listTaskGroups().filter(g => g.active && g.groupKey !== g0.groupKey)[0]
  if (lastGroup) {
    await store.removeGroup(lastGroup.groupKey)
    s = store.getSheet(today)
    ok(!s.items.some(x => x.groupKey === lastGroup.groupKey && x.status === 'approved' && !x.done), '删除大项后未完成项当天消失')
  }

  console.log('模板当天生效：通过 ' + pass + ' 条' + (process.exitCode ? '，存在失败' : ''))
}

main()
