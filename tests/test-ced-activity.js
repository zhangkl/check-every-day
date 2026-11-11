/* 操作流水：动作列 + 非积分动作 + 老数据兼容 + 不污染积分账本 */
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
async function as(uid, role) {
  db.session = { user: { id: uid } }
  const st = freshStore()
  const r = await st.bootstrap()
  st.setRole(role)
  return { st, r }
}
const acts = st => st.listActivity()
const top = st => st.listActivity()[0]

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
  await kid.setMyLabel('墨墨')

  const day = dateUtil.today()
  let p = (await as('u-p1', 'parent')).st
  ok(Array.isArray(p.listActivity()), '新文档有操作流水接口')

  // ① 积分动作：动作列 + 对象 + 分值 + 谁
  const item = p.todayOverview().groups[0].items[0]
  ok((await p.toggleItem(day, item.id)).ok, '打卡')
  let r = top(p)
  ok(r.action === '完成打卡', '打卡动作是「完成打卡」：' + r.action)
  ok(r.detail === item.title, '详情是任务名，不再混动作')
  ok(r.hasAmount && r.amount === item.points && r.amount > 0, '带分值')
  ok(r.uid === 'u-p1' && r.role === 'parent', '记录操作人和身份')

  // ② 手动加/扣分：动作按金额区分，原因在详情列
  ok((await p.adjustPoints(5, '主动练琴')).ok, '手动加分')
  r = top(p)
  ok(r.action === '手动加分' && r.detail === '主动练琴' && r.amount === 5, '加分：动作+原因+分值')
  ok((await p.adjustPoints(-2, '拖到很晚')).ok, '手动扣分')
  r = top(p)
  ok(r.action === '手动扣分' && r.detail === '拖到很晚' && r.amount === -2, '扣分：动作+原因+分值')

  // ③ 非积分动作：申请加项 / 同意 / 改分值（孩子端发起，家长端处理）
  const bal0 = p.balance()
  kid = (await as('u-c1', 'child')).st
  ok((await kid.addExtraToday('练琴 20 分钟', 5, true)).ok, '孩子申请加项')
  r = top(kid)
  ok(r.action === '申请加项' && r.detail === '练琴 20 分钟', '申请加项有动作和对象')
  ok(!r.hasAmount && r.amount === 0, '零分动作显示「—」而不是 +0 分')
  ok(r.uid === 'u-c1' && r.role === 'child', '记录是孩子操作的')

  const pend = kid.todayOverview().groups.map(g => g.items).reduce((x, y) => x.concat(y), []).filter(i => i.status === 'pending')[0]
  ok(!!pend, '能找到待同意项')
  p = (await as('u-p1', 'parent')).st
  ok((await p.updateExtraPoints(day, pend.id, 8)).ok, '改分值')
  ok(top(p).action === '改分值' && top(p).detail.indexOf('8 分') >= 0, '改分值记下新分值')
  ok((await p.approveExtra(day, pend.id)).ok, '同意加项')
  ok(top(p).action === '同意加项' && top(p).detail === '练琴 20 分钟', '同意加项有动作')

  // ④ 留言 / 公告 / 删留言
  const nr = await p.addNote('今天早点睡')
  ok(nr.ok, '发留言')
  ok(top(p).action === '发留言' && top(p).detail === '今天早点睡', '发留言有动作')
  ok((await p.pinNote(nr.noteId)).ok, '设公告')
  ok(top(p).action === '设为公告', '设公告有动作')
  ok((await p.pinNote(nr.noteId)).ok, '取消公告')
  ok(top(p).action === '取消公告', '取消公告也记')
  ok((await p.removeNote(nr.noteId)).ok, '删留言')
  ok(top(p).action === '删留言', '删留言有动作')

  // ⑤ 清单配置 / 礼物 / 心愿 / 兑换 / 护身符
  const gr = await p.addGroup('周末专项', '📌')
  ok(gr.ok && top(p).action === '新增大项', '新增大项')
  ok((await p.updateGroup(gr.groupKey, { title: '周末加餐' })).ok, '改大项')
  ok(top(p).action === '改大项', '改大项')
  ok((await p.removeGroup(gr.groupKey)).ok, '删大项')
  ok(top(p).action === '删大项', '删大项')
  ok((await p.addGift('小贴纸', '🎁', 10)).ok, '新增礼物')
  ok(top(p).action === '新增礼物', '新增礼物')
  const gift = p.listAllGifts().filter(g => g.name === '小贴纸')[0]
  ok((await p.updateGift(gift.id, { name: '贴纸一张' })).ok, '改礼物')
  ok(top(p).action === '改礼物', '改礼物')

  kid = (await as('u-c1', 'child')).st
  ok((await kid.addWish('去动物园')).ok, '许心愿')
  ok(top(kid).action === '许心愿', '许心愿')
  const wish = kid.listWishes()[0]
  p = (await as('u-p1', 'parent')).st
  ok((await p.decideWish(wish.id, true)).ok, '同意心愿')
  ok(top(p).action === '同意心愿', '同意心愿')
  kid = (await as('u-c1', 'child')).st
  const cheap = kid.listGifts()[0]
  ok((await kid.requestRedeem(cheap.id)).ok, '申请兑换')
  ok(top(kid).action === '申请兑换', '申请兑换')
  p = (await as('u-p1', 'parent')).st
  const red = p.listRedemptions()[0]
  ok((await p.decideRedeem(red.id, false)).ok, '驳回兑换')
  ok(top(p).action === '驳回兑换', '驳回兑换')
  ok((await p.useCoupon(day)).ok, '用护身符')
  ok(top(p).action === '用护身符', '用护身符')

  // ⑥ 零分动作不能污染积分账本（balance 只从 logs 求和）
  p = (await as('u-p1', 'parent')).st
  ok(p.balance() === bal0, '一堆零分动作后余额不变')
  ok(p.logs().every(l => l.kind !== 'note_add' && l.kind !== 'wish_apply'), '积分账本里没有混进零分动作')

  // ⑦ 老数据：没有 activities 字段 + note 里混着动作前缀
  const fam = db.families[0]
  const now = Date.now()
  delete fam.doc.activities
  fam.doc.logs.push({ id: 'old1', kind: 'voice_like', amount: 1, day: day, note: '点赞语音 · 英语', uid: 'u-p1', role: 'parent', at: now - 1000 })
  fam.doc.logs.push({ id: 'old2', kind: 'adjust', amount: 2, day: day, note: '家长额外奖励', uid: 'u-p1', role: 'parent', at: now - 2000 })
  p = (await as('u-p1', 'parent')).st
  const olds = p.listActivity().filter(x => x.id === 'old1' || x.id === 'old2')
  ok(olds.length === 2, '老日志照样出现在流水里')
  const old1 = olds.filter(x => x.id === 'old1')[0]
  const old2 = olds.filter(x => x.id === 'old2')[0]
  ok(old1.action === '点赞语音' && old1.detail === '英语', '老日志剥掉动作前缀，详情只留对象')
  ok(old2.action === '手动加分' && old2.detail === '', '老日志的兜底文案不重复显示')
  ok(Array.isArray(p.getDoc().activities), '老文档补上 activities 空数组')
  // 老日志在加载时已一次性洗成纯对象名，并打上迁移标记
  const cleaned1 = p.getDoc().logs.filter(l => l.id === 'old1')[0]
  const cleaned2 = p.getDoc().logs.filter(l => l.id === 'old2')[0]
  ok(cleaned1.note === '英语', '迁移后 note 里不再留中文动作前缀')
  ok(cleaned2.note === '', '迁移后纯兜底文案被清空')
  ok(p.getDoc().migrations.legacyNotesV2 === true, '文档带上迁移标记')
  const migratedDoc = p.getDoc()
  migratedDoc.logs.forEach(l => { if (l && l.note) ok(!/^(取消勾选|家长撤销|点赞语音|取消赞|兑换)\s*·\s*/.test(l.note), '全量日志无残留前缀') })

  // ⑧ 排序与 limit
  const all = p.listActivity()
  ok(all.every((x, i) => i === 0 || all[i - 1].at >= x.at), '按时间倒序')
  ok(p.listActivity(3).length === 3, 'limit 生效')
  ok(all.every(x => !!x.action), '每条都有动作名')

  console.log('  ' + pass + ' 项通过')
}
main().catch(e => { console.error(e); process.exitCode = 1 })
