/* 家庭动态融合页：feed 统一查询、双端全量一致、消息仍定向、不重复、已读隔离 */
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
const dateUtil = require(path.join(ROOT, 'utils/date'))

let pass = 0
function ok(c, l) { if (c) { pass++; return } console.log('  FAIL ' + l); process.exitCode = 1 }
function err(r) { return r && r.ok ? '' : '(' + (r && r.error) + ')' }

async function as(uid, role) {
  db.session = { user: { id: uid } }
  const st = freshStore()
  const r = await st.bootstrap()
  st.setRole(role)
  return { st, r }
}
function signature(arr) {
  return arr.map(x => [x.id, x.kind, x.action, x.detail, x.uid, x.role, x.amount, x.hasAmount].join('|')).join('\n')
}

async function main() {
  // 建家：家长 + 孩子
  let a = await as('u-p1', 'parent')
  ok(a.r.needSetup || a.r.ok, '家长首启')
  ok((await a.st.createFamily('测试家', '墨墨')).ok, '创建家庭')
  a.st.setRole('parent')
  await a.st.setMyLabel('帅爹')
  const code = a.st.getInviteCode()

  db.session = { user: { id: 'u-c1' } }
  const kidStore = freshStore()
  ok((await kidStore.joinFamily(code, { role: 'child' })).ok, '孩子加入家庭')
  await kidStore.bootstrap()
  kidStore.setRole('child')
  await kidStore.setMyLabel('墨墨')

  const day = dateUtil.today()
  let kid = (await as('u-c1', 'child')).st
  const item = kid.todayOverview().groups[0].items[0]
  ok(!!item, '能取到清单项')

  // 造出三类动作：打卡（积分）、留言（零分动作 + 广播消息）、家长调分（积分 + 定向消息）
  const tRes = await kid.toggleItem(day, item.id)
  ok(tRes.ok, '孩子打卡' + err(tRes))
  ok((await kid.addNote('今天早点睡')).ok, '孩子留言')
  let p1 = (await as('u-p1', 'parent')).st
  ok((await p1.adjustPoints(5, '主动练琴')).ok, '家长手动加分')

  // ① feed 基本结构
  p1 = (await as('u-p1', 'parent')).st
  const f = p1.feed()
  ok(Array.isArray(f.notices) && Array.isArray(f.activities), 'feed 返回消息 + 流水两个列表')
  ok(f.activities.length >= 3, '流水含多个动作（实际 ' + f.activities.length + '）')
  ok(f.activities.every(x => x.source === 'activity'), '流水条目都标 source=activity')
  ok(f.notices.every(x => x.source === 'notice'), '消息条目都标 source=notice')
  ok(f.activities.every(x => !!x.action), '每条流水都有动作标签')
  ok(f.activities.some(x => x.hasAmount), '存在带分值的积分记录')
  ok(f.activities.some(x => !x.hasAmount), '存在零分动作')
  ok(f.activities.every(x => typeof x.at === 'number'), '流水带时间戳可排序')
  ok(f.activities.every((x, i) => i === 0 || f.activities[i - 1].at >= x.at), '流水按时间倒序')

  // ② 双端可见范围完全一致（用户拍板：全家完全一致）
  kid = (await as('u-c1', 'child')).st
  const kf = kid.feed()
  ok(kf.activities.length === f.activities.length, '两端流水条数一致')
  ok(signature(kf.activities) === signature(f.activities), '两端流水逐字段完全一致')
  ok(kf.activities.some(x => x.role === 'parent'), '学生端能看到家长动作')
  ok(kf.activities.some(x => x.kind === 'adjust'), '学生端能看到手动加分动作')
  ok(kf.activities.some(x => x.detail && x.detail.indexOf('练琴') >= 0), '学生端能看到加分原因全文')

  // ③ 消息仍按收件人定向，不因融合变成全家广播
  ok(kf.notices.some(n => n.kind === 'adjust'), '孩子收到调分消息')
  ok(!f.notices.some(n => n.kind === 'adjust'), '发起的家长不收到自己发的调分消息')
  ok(kf.notices.some(n => !f.notices.some(m => m.id === n.id)), '两端消息集合按收件人不同')

  // ④ 不重复：同一次调分在两个 tab 各一行，不在同一列表出现两遍
  ok(kf.activities.filter(x => x.kind === 'adjust').length === 1, '流水里调分只记一次')
  ok(kf.notices.filter(n => n.kind === 'adjust').length === 1, '消息里调分只一条')
  const allIds = kf.activities.map(x => x.id).concat(kf.notices.map(n => n.id))
  ok(new Set(allIds).size === allIds.length, '两个列表没有重复条目')

  // ⑤ 已读隔离：家长看过后孩子端仍是未读
  const kidBefore = kid.feed().notices.filter(n => n.unread).length
  ok(kidBefore > 0, '孩子端存在未读消息')
  p1 = (await as('u-p1', 'parent')).st
  const p1Before = p1.feed().notices.filter(n => n.unread).length
  ok(p1Before > 0, '家长端存在未读消息')
  ok((await p1.markNoticesRead()).ok, '家长标记全部已读')
  ok(p1.feed().notices.every(n => !n.unread), '家长端已全部已读')
  kid = (await as('u-c1', 'child')).st
  ok(kid.feed().notices.filter(n => n.unread).length === kidBefore, '家长已读不影响孩子端未读')
  ok((await kid.markNoticesRead()).ok, '孩子标记全部已读')
  ok(kid.feed().notices.every(n => !n.unread), '孩子端已全部已读')

  // ⑥ limit 与纯读语义
  ok(p1.feed(2).activities.length <= 2, 'limit 只截断流水')
  ok(p1.feed(2).notices.length === p1.feed().notices.length, 'limit 不影响消息列表')
  const revBefore = db.families[0].rev
  p1.feed()
  kid.feed()
  ok(db.families[0].rev === revBefore, 'feed 是纯读，不写云端文档')

  // ⑦ 老数据：没有 activities / notices 字段也不崩
  delete db.families[0].doc.activities
  delete db.families[0].doc.notices
  const old = (await as('u-c1', 'child')).st
  const of2 = old.feed()
  ok(Array.isArray(of2.activities), '老数据流水返回数组')
  ok(Array.isArray(of2.notices), '老数据消息返回数组')
  ok(of2.activities.length > 0, '老数据的积分日志仍能显示')

  console.log('动态页融合：通过 ' + pass + ' 条，失败 ' + (process.exitCode ? '有' : '0') + ' 条')
}
main().catch(e => { console.error(e); process.exit(1) })
