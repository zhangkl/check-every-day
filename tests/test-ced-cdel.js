/* 语音评论删除链路测试：家长可删任何人的，孩子只能删自己的 */
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

async function main() {
  db.session = { user: { id: 'u-parent', name: 'parent' } }
  let store = freshStore()
  const bs = await store.bootstrap()
  ok(bs.needSetup || bs.ok, '家长 bootstrap')
  ok((await store.createFamily('测试家', '朵朵')).ok, '创建家庭')
  const day = dateUtil.today()
  const item = store.todayOverview().groups[0].items[0]
  const vr = await store.appendItemVoice(day, item.id, { path: 'cloud://x.mp3', duration: 5 })
  ok(vr.ok, '家长录一段语音')
  const voiceId = vr.voiceId

  ok((await store.addVoiceComment(day, item.id, voiceId, '爸爸说：真棒')).ok, '家长发评论 c1')
  const code = store.getInviteCode()

  db.session = { user: { id: 'u-kid', name: 'kid' } }
  const store2 = freshStore()
  ok((await store2.joinFamily(code, { role: 'child' })).ok, '孩子加入')
  ok((await store2.bootstrap()).ok, '孩子 bootstrap')
  ok((await store2.addVoiceComment(day, item.id, voiceId, '孩子说：谢谢爸爸')).ok, '孩子发评论 c2')
  ok((await store2.addVoiceComment(day, item.id, voiceId, '孩子又说了一句')).ok, '孩子发评论 c3')

  // 孩子删家长的 → 拒
  const c1 = store2.getDoc().sheets[day].items.filter(i => i.id === item.id)[0].voices.filter(v => v.id === voiceId)[0].comments[0]
  const deny = await store2.removeVoiceComment(day, item.id, voiceId, c1.id)
  ok(!deny.ok && /只能删自己发的/.test(deny.error), '孩子删家长评论被拒')

  // 孩子删自己的 → 成
  const commentsNow = (st) => st.getDoc().sheets[day].items.filter(i => i.id === item.id)[0].voices.filter(v => v.id === voiceId)[0].comments
  const own = commentsNow(store2)[1]
  const r2 = await store2.removeVoiceComment(day, item.id, voiceId, own.id)
  ok(r2.ok && commentsNow(store2).length === 2, '孩子删自己的评论成功')

  // 家长删孩子的 → 成
  db.session = { user: { id: 'u-parent', name: 'parent' } }
  store = freshStore()
  ok((await store.bootstrap()).ok, '家长重新进入')
  store.setRole('parent') // 测试共用 storage，孩子的角色偏好会覆盖，真实设备各自独立
  ok(store.getRole() === 'parent', '家长身份就位')
  const kidComment = commentsNow(store).filter(c => c.uid === 'u-kid')[0]
  ok(!!kidComment, '还能找到孩子评论')
  const r3 = await store.removeVoiceComment(day, item.id, voiceId, kidComment.id)
  ok(r3.ok && commentsNow(store).length === 1, '家长删孩子评论成功')

  // 家长删自己的 → 成，删空
  const mine = commentsNow(store)[0]
  const r4 = await store.removeVoiceComment(day, item.id, voiceId, mine.id)
  ok(r4.ok && commentsNow(store).length === 0, '家长删自己评论成功，清空')

  // 删不存在的评论
  const r5 = await store.removeVoiceComment(day, item.id, voiceId, 'no-such-id')
  ok(!r5.ok, '删不存在的评论被拒')

  console.log('评论删除：通过 ' + pass + ' 条' + (process.exitCode ? '，有失败' : '，失败 0 条'))
}

main().catch(e => { console.error(e); process.exit(1) })
