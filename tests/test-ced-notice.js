/* 消息中心：收件人定向、排除自己、广播、已读隔离、老数据兼容 */
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

// 以某账号某身份重新进入：每次都从云端拉最新文档，模拟另一台设备
async function as(uid, role) {
  db.session = { user: { id: uid } }
  const st = freshStore()
  const r = await st.bootstrap()
  st.setRole(role)
  return { st, r }
}
function kinds(st) { return st.listNotices().map(n => n.kind) }
function find(st, kind) { return st.listNotices().filter(n => n.kind === kind)[0] }

async function main() {
  // 建家：家长1 + 孩子 + 家长2（验证多家长广播）
  let a = await as('u-p1', 'parent')
  ok(a.r.needSetup || a.r.ok, '家长1 首启')
  ok((await a.st.createFamily('测试家', '墨墨')).ok, '创建家庭')
  a.st.setRole('parent')
  await a.st.setMyLabel('帅爹')
  const code = a.st.getInviteCode()

  db.session = { user: { id: 'u-c1' } }
  let kidStore = freshStore()
  ok((await kidStore.joinFamily(code, { role: 'child' })).ok, '孩子用码加入')
  await kidStore.bootstrap()
  kidStore.setRole('child')
  await kidStore.setMyLabel('墨墨')

  db.session = { user: { id: 'u-p2' } }
  let p2Store = freshStore()
  ok((await p2Store.joinFamily(code, { role: 'parent' })).ok, '家长2 用码加入')
  await p2Store.bootstrap()
  p2Store.setRole('parent')
  await p2Store.setMyLabel('母上')

  const day = dateUtil.today()
  let kid = (await as('u-c1', 'child')).st
  const item = kid.todayOverview().groups[0].items[0]
  ok(!!item, '能取到清单项')

  // ① 精确收件人：孩子录语音 → 家长1 点赞 → 只有孩子收到
  const vr = await kid.appendItemVoice(day, item.id, { path: 'cloud://x.mp3', duration: 5 })
  ok(vr.ok, '孩子录语音' + err(vr))
  const voiceId = vr.voiceId
  let p1 = (await as('u-p1', 'parent')).st
  ok((await p1.toggleVoiceLike(day, item.id, voiceId)).ok, '家长1 点赞')
  kid = (await as('u-c1', 'child')).st
  ok(!!find(kid, 'like'), '孩子收到「被点赞」消息')
  ok(find(kid, 'like').fromName === '帅爹', '消息带发起者称呼')
  ok(find(kid, 'like').unread, '新消息是未读')
  p1 = (await as('u-p1', 'parent')).st
  ok(kinds(p1).indexOf('like') < 0, '点赞的家长自己收不到')
  let p2 = (await as('u-p2', 'parent')).st
  ok(kinds(p2).indexOf('like') < 0, '另一位家长也收不到（精确投递）')

  // ② 自己的语音自己评论：不给自己发消息
  const before = kid.listNotices().length
  ok((await kid.addVoiceComment(day, item.id, voiceId, '我自己说两句')).ok, '孩子评论自己的语音')
  kid = (await as('u-c1', 'child')).st
  ok(kid.listNotices().length === before, '自己评论自己不产生消息')

  // ③ 家长评论孩子语音 → 孩子收到；家长删评论 → 孩子收到
  p1 = (await as('u-p1', 'parent')).st
  const cr = await p1.addVoiceComment(day, item.id, voiceId, '说得真好')
  ok(cr.ok, '家长1 评论语音' + err(cr))
  kid = (await as('u-c1', 'child')).st
  ok(!!find(kid, 'comment'), '孩子收到「被评论」消息')
  p1 = (await as('u-p1', 'parent')).st
  ok((await p1.removeVoiceComment(day, item.id, voiceId, cr.commentId)).ok, '家长删掉自己发的评论')
  kid = (await as('u-c1', 'child')).st
  ok(!find(kid, 'comment_delete'), '删自己的评论不打扰别人')

  // ④ 全家广播：家长发留言 → 孩子和另一位家长收到，发起者不收
  p1 = (await as('u-p1', 'parent')).st
  ok((await p1.addNote('今天早点睡')).ok, '家长1 发留言')
  kid = (await as('u-c1', 'child')).st
  ok(!!find(kid, 'note'), '孩子收到留言提醒')
  p2 = (await as('u-p2', 'parent')).st
  ok(!!find(p2, 'note'), '另一位家长收到留言提醒')
  p1 = (await as('u-p1', 'parent')).st
  ok(kinds(p1).indexOf('note') < 0, '发起者自己不收自己的留言提醒')

  // ⑤ 已读按读者隔离：孩子读掉留言，家长2 仍是未读
  const noteMsg = find(kid, 'note')
  const mr = await kid.markNoticesRead([noteMsg.id])
  ok(mr.ok && mr.marked === 1, '孩子标记单条已读')
  kid = (await as('u-c1', 'child')).st
  ok(find(kid, 'note').unread === false, '孩子端这条已变已读')
  p2 = (await as('u-p2', 'parent')).st
  ok(find(p2, 'note').unread === true, '另一位家长的同一条消息仍为未读')

  // ⑥ 角色广播：孩子申请加项 → 所有家长；家长同意 → 孩子
  kid = (await as('u-c1', 'child')).st
  ok((await kid.addExtraToday('练琴 20 分钟', 5, true)).ok, '孩子申请临时加项')
  p1 = (await as('u-p1', 'parent')).st
  ok(!!find(p1, 'extra_apply'), '家长1 收到待同意提醒')
  p2 = (await as('u-p2', 'parent')).st
  ok(!!find(p2, 'extra_apply'), '家长2 也收到待同意提醒')
  kid = (await as('u-c1', 'child')).st
  ok(kinds(kid).indexOf('extra_apply') < 0, '申请者自己不收待同意提醒')
  const extra = p1.todayOverview().groups.filter(g => g.title === '其它补充')[0]
  ok(!!extra, '能找到其它补充分组')
  const pending = extra.items.filter(it => it.status === 'pending')[0]
  ok(!!pending, '能找到待同意项')
  p1 = (await as('u-p1', 'parent')).st
  ok((await p1.approveExtra(day, pending.id)).ok, '家长同意加项')
  kid = (await as('u-c1', 'child')).st
  ok(!!find(kid, 'extra_ok'), '孩子收到审批结果')
  p1 = (await as('u-p1', 'parent')).st
  ok(kinds(p1).indexOf('extra_ok') < 0, '审批的家长自己不收结果消息')

  // ⑦ 家长调分/撤销 → 孩子
  p1 = (await as('u-p1', 'parent')).st
  ok((await p1.adjustPoints(3, '表现好')).ok, '家长调积分')
  kid = (await as('u-c1', 'child')).st
  ok(!!find(kid, 'adjust'), '孩子收到调分提醒')

  // ⑧ 全部已读 + 幂等
  kid = (await as('u-c1', 'child')).st
  const unreadBefore = kid.unreadNoticeCount()
  ok(unreadBefore > 0, '孩子有未读消息')
  const all = await kid.markNoticesRead()
  ok(all.ok && all.marked === unreadBefore, '一键全部已读')
  ok(kid.unreadNoticeCount() === 0, '未读数清零')
  const again = await kid.markNoticesRead()
  ok(again.ok && again.marked === 0, '重复标记已读不产生多余写入')

  // ⑨ 老数据兼容：文档里没有 notices 字段
  delete db.families[0].doc.notices
  const old = (await as('u-c1', 'child')).st
  ok(Array.isArray(old.getDoc().notices) && old.getDoc().notices.length === 0, '老文档自动补 notices: []')
  ok(old.listNotices().length === 0, '老数据下消息列表为空不报错')

  // ⑩ 消息上限：连续投递后只留最近 100 条
  p1 = (await as('u-p1', 'parent')).st
  for (let i = 0; i < 105; i++) await p1.addNote('第 ' + i + ' 条')
  ok(p1.getDoc().notices.length === 100, '消息只保留最近 100 条')

  console.log('消息中心：通过 ' + pass + ' 条' + (process.exitCode ? '，有失败' : '，失败 0 条'))
}
main().catch(e => { console.error(e); process.exit(1) })
