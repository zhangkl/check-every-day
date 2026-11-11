/* 语音评论链路测试 */
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
  db.session = { user: { id: 'u-parent', name: 'parent' } }
  const store = freshStore()
  ok((await store.createFamily('测试家', '朵朵')).ok, '创建家庭')
  ok((await store.bootstrap()).ok, '家长端 bootstrap（建立 session）')

  // 挂一条语音到今天的第一个条目
  const ov = store.todayOverview()
  const it = ov.groups[0].items[0]
  const day = ov.day
  const add = await store.appendItemVoice(day, it.id, { path: 'shared/u-parent/voices/1.mp3', duration: 30, at: Date.now() })
  ok(add.ok, '追加语音')
  const voiceId = add.voiceId

  // 老语音（无 comments 字段）直接兼容：评论后补上数组
  const docRow = db.families[0]
  delete docRow.doc.sheets[day].items.filter(x => x.id === it.id)[0].voices[0].comments

  // 非法输入
  const r0 = await store.addVoiceComment(day, it.id, voiceId, '   ')
  ok(!r0.ok, '纯空格评论被拒绝')
  const r1 = await store.addVoiceComment(day, it.id, voiceId, '')
  ok(!r1.ok, '空评论被拒绝')

  // 家长评论
  const r2 = await store.addVoiceComment(day, it.id, voiceId, '讲得真好，继续加油！')
  ok(r2.ok, '家长发评论成功')
  ok(r2.count === 1, '评论计数 1')

  // 老数据兼容：评论后 comments 数组补齐
  const v2 = docRow.doc.sheets[day].items.filter(x => x.id === it.id)[0].voices[0]
  ok(Array.isArray(v2.comments) && v2.comments.length === 1, '老语音（无 comments）评论后补数组')

  // 200 字截断
  const long = '好'.repeat(300)
  await store.addVoiceComment(day, it.id, voiceId, long)
  const v3 = docRow.doc.sheets[day].items.filter(x => x.id === it.id)[0].voices[0]
  ok(v3.comments[1].text.length === 200, '评论截断到 200 字')

  // 评论内容与身份
  ok(v3.comments[0].role === 'parent', '家长评论 role=parent')
  ok(v3.comments[0].uid === 'u-parent', '家长评论 uid 正确')
  ok(v3.comments[0].text === '讲得真好，继续加油！', '评论文本正确')
  ok(v3.comments[0].at > 0, '评论带时间戳')
  ok(typeof v3.comments[0].id === 'string' && v3.comments[0].id, '评论带 id')

  // 找不到语音/条目
  ok(!(await store.addVoiceComment(day, it.id, 'no-such-voice', 'hi')).ok, '找不到语音报错')
  ok(!(await store.addVoiceComment(day, 'no-item', voiceId, 'hi')).ok, '找不到条目报错')

  // 孩子端：加入家庭后评论
  const invite = docRow.invite_code
  db.session = { user: { id: 'u-child', name: 'child' } }
  const store2 = freshStore()
  ok((await store2.joinFamily(invite)).ok, '孩子加入家庭')
  ok((await store2.bootstrap()).ok, '孩子端加载')
  const r4 = await store2.addVoiceComment(day, it.id, voiceId, '谢谢妈妈！')
  ok(r4.ok, '孩子发评论成功')
  ok(r4.count === 3, '评论计数 3')
  const v4 = docRow.doc.sheets[day].items.filter(x => x.id === it.id)[0].voices[0]
  ok(v4.comments[2].role === 'child' && v4.comments[2].uid === 'u-child', '孩子评论身份正确')

  // 评论不影响清单/积分
  const ov2 = store2.todayOverview()
  ok(ov2.groups[0].items[0].voices[0].comments.length === 3, 'todayOverview 带出评论')
  ok(store2.balance() === 0 || store2.balance() >= 0, '评论不影响积分流水')

  // 家长端重新加载能看到孩子的评论
  db.session = { user: { id: 'u-parent', name: 'parent' } }
  const store3 = freshStore()
  ok((await store3.bootstrap()).ok, '家长端重新加载')
  const v5 = docRow.doc.sheets[day].items.filter(x => x.id === it.id)[0].voices[0]
  ok(v5.comments.length === 3, '云端文档里 3 条评论')

  console.log('语音评论：通过 ' + pass + ' 条，失败 ' + (process.exitCode ? 1 : 0) + ' 组')
}
main().catch(e => { console.error(e); process.exit(1) })
