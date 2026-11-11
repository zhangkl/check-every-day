/* 家庭成员展示 + 操作流水（操作人）链路测试 */
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

let pass = 0
function ok(c, l) { if (c) { pass++; return } console.log('  FAIL ' + l); process.exitCode = 1 }

async function main() {
  // 家长建家庭（真实流程是登录后再建，所以先 bootstrap 拿到 session）
  db.session = { user: { id: 'u-parent', name: 'parent' } }
  let store = freshStore()
  const bs0 = await store.bootstrap()
  ok(bs0.needSetup || bs0.ok, '家长 bootstrap（首启无家庭时 needSetup）')
  ok((await store.createFamily('测试家', '朵朵')).ok, '创建家庭')
  ok((await store.setMyLabel('帅爹')).ok, '家长设置称呼')
  ok((await store.setMyAvatar('👨')).ok, '家长设置头像')

  // 成员列表：家长自己在列，称呼/头像来自 profile
  let ms = store.listMembers()
  ok(ms.length === 1, '初始只有家长一个成员')
  ok(ms[0].role === 'parent' && ms[0].name === '帅爹' && ms[0].avatar === '👨', '家长成员展示称呼+头像')
  ok(ms[0].tag === 'u-parent|parent', '成员 tag 是 uid|p 格式')

  // 流水：家长调整积分，日志记录 uid + role
  const adj = await store.adjustPoints(3, '测试调整')
  ok(adj.ok, '家长调整积分')
  const lg = store.logs()
  ok(lg.length >= 1 && lg[0].uid === 'u-parent' && lg[0].role === 'parent', '流水记录操作人 uid+role')
  ok(lg[0].note === '测试调整', '流水记录事项')

  // 孩子加入（join 自带 session 读取，加入后再 bootstrap 加载家庭文档）
  const code = store.getInviteCode()
  db.session = { user: { id: 'u-kid', name: 'kid' } }
  const store2 = freshStore()
  const jr = await store2.joinFamily(code, { role: 'child' })
  ok(jr.ok, '孩子用码加入')
  ok((await store2.bootstrap()).ok, '孩子 bootstrap')
  ok((await store2.setMyLabel('墨墨')).ok, '孩子设置称呼')
  ok((await store2.setMyAvatar('🦊')).ok, '孩子设置头像')

  // 孩子打卡 → 流水记孩子
  const ov = store2.todayOverview()
  const first = ov.groups && ov.groups.length && ov.groups[0].items && ov.groups[0].items[0]
  ok(first && first.id, '孩子端能看到清单项')
  const tr = await store2.toggleItem(require(path.join(ROOT, 'utils/date')).today(), first.id)
  ok(tr.ok, '孩子勾选一项：' + (tr.ok ? 'ok' : tr.error))
  const lg2 = store2.logs()
  ok(lg2[0].uid === 'u-kid' && lg2[0].role === 'child', '打卡流水记的是孩子')

  // 家长视角看成员列表：家长在前，孩子在后，各自身份正确
  const store3 = freshStore()
  ok((await store3.bootstrap()).ok, '家长重新加载')
  ms = store3.listMembers()
  ok(ms.length === 2, '两个成员（家长+孩子）')
  ok(ms[0].role === 'parent' && ms[0].name === '帅爹', '家长排第一')
  ok(ms[1].role === 'child' && ms[1].name === '墨墨' && ms[1].avatar === '🦊', '孩子展示称呼+头像')

  // 老数据兼容：无分隔符的 legacy profile 键视为家长
  const doc = store3.getDoc()
  doc.profile['u-grandpa'] = { label: '爷爷', avatar: '🐸', at: 1 }
  ms = store3.listMembers()
  ok(ms.some(m => m.name === '爷爷' && m.role === 'parent'), 'legacy 键回退为家长身份')

  // 幽灵分身：家长账号临时切学生端、只换了头像没设称呼 → 不该冒充第二个孩子
  doc.profile['u-parent|c'] = { avatar: '🐵', at: 2 }
  ms = store3.listMembers()
  ok(!ms.some(m => m.tag === 'u-parent|child'), '家长切学生端留下的空壳分身不列为成员')
  ok(ms.filter(m => m.role === 'child').length === 1, '只剩真正的孩子一个学生')

  // 不能误伤①：该账号真以学生身份操作过（流水有 child 记录）→ 保留
  if (!Array.isArray(doc.logs)) doc.logs = []
  doc.logs.unshift({ uid: 'u-parent', role: 'child', at: Date.now() })
  ms = store3.listMembers()
  ok(ms.some(m => m.tag === 'u-parent|child'), '有学生操作记录的家长分身仍保留')
  doc.logs.shift()

  // 不能误伤③：只留言 / 申请加项 / 发语音、从不打卡的孩子也算真孩子
  const ghost = 'u-parent|child'
  const keep = () => store3.listMembers().some(m => m.tag === ghost)
  doc.activities = [{ uid: 'u-parent', role: 'child', kind: 'extra_apply', at: Date.now() }]
  ok(keep(), '动作流水里有学生记录 → 保留')
  doc.activities = []
  doc.notes = [{ uid: 'u-parent', role: 'child', text: '今天早点睡' }]
  ok(keep(), '留言里有学生记录 → 保留')
  doc.notes = []
  doc.notices = [{ from: 'u-parent|c', text: '在留言板说了一句话' }]
  ok(keep(), '消息来源标记为学生 → 保留')
  doc.notices = []
  const someDay = Object.keys(doc.sheets || {})[0]
  if (someDay && doc.sheets[someDay].items && doc.sheets[someDay].items[0]) {
    doc.sheets[someDay].items[0].voices = [{ uid: 'u-parent', role: 'child' }]
    ok(keep(), '语音里有学生记录 → 保留')
    doc.sheets[someDay].items[0].voices = []
  }
  ok(!keep(), '清掉所有学生痕迹后，空壳分身仍被过滤')

  // 不能误伤②：双身份主动设了称呼 → 保留，且用自己的称呼
  doc.profile['u-parent|c'].label = '陪练'
  ms = store3.listMembers()
  ok(ms.some(m => m.tag === 'u-parent|child' && m.name === '陪练'), '主动设了称呼的双身份仍保留')

  // 空 profile 老数据：至少展示家庭里配置的孩子
  delete doc.profile
  ms = store3.listMembers()
  ok(ms.length === 1 && ms[0].role === 'child' && ms[0].name === '朵朵', '空 profile 时回退孩子昵称')

  console.log('成员与流水：通过 ' + pass + ' 条' + (process.exitCode ? '，有失败' : '，失败 0 条'))
}

main().catch(e => { console.error(e); process.exit(1) })
