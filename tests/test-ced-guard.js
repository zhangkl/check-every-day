/* 家长专属写守卫：孩子越权被拒、伪造本地身份无效、双端操作不受影响 */
const path = require('path')
const Module = require('module')
const ROOT = path.resolve(__dirname, '..')
const ORIGINAL_LOAD = Module._load

const storage = {}
global.wx = {
  getStorageSync(k) { return storage[k] === undefined ? '' : storage[k] },
  setStorageSync(k, v) { storage[k] = JSON.parse(JSON.stringify(v)) },
  removeStorageSync(k) { delete storage[k] },
  login(o) { o.success({ code: 'fake-code' }) },
  getAccountInfoSync() { return { miniProgram: { appId: 'wxtestappid' } } },
  showToast() {}, showLoading() {}, hideLoading() {}
}
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)))
const db = { families: [], members: [], seq: 0, session: null, uid: () => db.session && db.session.user.id }

class Builder {
  constructor(table, op, payload) {
    this.table = table; this.op = op; this.payload = payload
    this.filters = []; this.cols = '*'; this.isSingle = false
  }
  select(cols) { this.cols = cols || '*'; return this }
  eq(c, v) { this.filters.push([c, v]); return this }
  single() { this.isSingle = true; return this }
  maybeSingle() { this.isSingle = true; return this }
  then(res, rej) { return this.run().then(res, rej) }
  tableRows() { return this.table === 'ced_families' ? db.families : db.members }
  visible(row) {
    if (this.table === 'ced_members') return row.owner_id === db.uid()
    const mine = db.members.filter((m) => m.owner_id === db.uid()).map((m) => String(m.family_id))
    return row.owner_id === db.uid() || mine.indexOf(String(row.id)) >= 0
  }
  match(row) { return this.filters.every(([c, v]) => String(row[c]) === String(v)) }
  shape(row) {
    if (!row) return null
    if (this.cols === '*') return clone(row)
    const out = {}
    this.cols.split(',').forEach((c) => { out[c.trim()] = clone(row[c.trim()]) })
    return out
  }
  async run() {
    const rows = this.tableRows().filter((r) => this.visible(r) && this.match(r))
    if (this.op === 'insert') {
      db.seq += 1
      const row = Object.assign({ id: db.seq, owner_id: db.uid(), rev: 1 }, clone(this.payload))
      this.tableRows().push(row)
      return { data: [this.shape(row)], error: null }
    }
    if (this.op === 'update') {
      rows.forEach((r) => Object.assign(r, clone(this.payload)))
      return { data: rows.map((r) => this.shape(r)), error: null }
    }
    if (this.isSingle) {
      if (rows.length !== 1) return { data: null, error: { code: 'PGRST116' } }
      return { data: this.shape(rows[0]), error: null }
    }
    return { data: rows.map((r) => this.shape(r)), error: null }
  }
}
const fakeCloud = {
  auth: {
    async getSession() { return { data: db.session ? { user: db.session.user } : null, error: null } },
    async signOut() { return { error: null } },
    async signInWithWechat() { return { error: null } }
  },
  database: {
    from(t) {
      const b = new Builder(t, 'select')
      b.insert = (p) => new Builder(t, 'insert', p)
      b.update = (p) => new Builder(t, 'update', p)
      return b
    },
    rpc(name, params) {
      const fam = db.families.filter((f) => f.invite_code === String(params.p_code || '').toUpperCase())[0]
      if (!fam) return Promise.resolve({ data: null, error: { code: 'P0002', message: 'CODE_NOT_FOUND' } })
      const uid = db.uid()
      if (!db.members.some((m) => m.family_id === fam.id && m.owner_id === uid)) {
        db.seq += 1
        db.members.push({ id: db.seq, family_id: fam.id, owner_id: uid, member_role: params.p_role || 'child' })
      }
      return Promise.resolve({ data: [{ out_family_id: fam.id, out_family_name: fam.doc.family.name }], error: null })
    }
  }
}
Module._load = function (request) {
  if (request === '@tencent-ai/workbuddy-cloud-sdk/miniprogram') return { createMiniProgramWorkBuddyCloud: () => fakeCloud }
  if (request === './workbuddy-cloud-diagnostics') return { createDiagnosticWx: (wx) => wx }
  return ORIGINAL_LOAD.apply(this, arguments)
}
function freshStore() {
  Object.keys(require.cache).forEach((k) => { if (k.indexOf(path.join(ROOT, 'utils')) === 0) delete require.cache[k] })
  return require(path.join(ROOT, 'utils/store.js'))
}
const dateUtil = require(path.join(ROOT, 'utils/date'))

let pass = 0
function ok(c, l) { if (c) { pass++; return } console.log('  FAIL ' + l); process.exitCode = 1 }
async function as(uid, role) {
  db.session = { user: { id: uid } }
  const st = freshStore()
  await st.bootstrap()
  st.setRole(role)
  return st
}
const rev = () => db.families[0].rev

// 与 utils/store.js 里 mutateParent(fn) 的调用点一一对应（24 个）
const PARENT_ONLY = [
  ['setFamilyInfo', ['新家', '墨墨']], ['revokeItem', ['2026-11-11', 'x1']],
  ['adjustPoints', [5, '主动练琴']], ['pinNote', ['n1']], ['setPin', ['1234']],
  ['addGroup', ['新大项', '📚']], ['updateGroup', ['g1', { title: '改名' }]], ['removeGroup', ['g1']],
  ['addChild', ['g1', '新小项', 2]], ['updateChild', ['t1', { points: 3 }]], ['removeChild', ['t1']],
  ['approveExtra', ['2026-11-11', 'x1']], ['updateExtraPoints', ['2026-11-11', 'x1', 3]],
  ['rejectExtra', ['2026-11-11', 'x1']], ['approveDelete', ['2026-11-11', 'x1']],
  ['rejectDelete', ['2026-11-11', 'x1']], ['deleteItemToday', ['2026-11-11', 'x1']],
  ['addGift', ['漫画书', '📕', 100]], ['updateGift', ['g1', { cost: 50 }]], ['removeGift', ['g1']],
  ['decideWish', ['w1', true]], ['decideRedeem', ['r1', true]], ['fulfillRedeem', ['r1']],
  ['resetAll', []]
]

async function main() {
  const parent = await as('u-p1', 'parent')
  ok((await parent.createFamily('守卫家', '墨墨')).ok, '创建家庭')
  parent.setRole('parent')
  const code = parent.getInviteCode()

  db.session = { user: { id: 'u-c1' } }
  const kidFresh = freshStore()
  ok((await kidFresh.joinFamily(code, { role: 'child' })).ok, '孩子用邀请码加入')
  await kidFresh.bootstrap()
  kidFresh.setRole('child')
  ok(kidFresh.getRole() === 'child', '孩子端当前身份是 child')

  // ① 孩子端：24 个家长专属操作全部被拒，且不产生任何云端写入
  const rev0 = rev()
  for (const [name, args] of PARENT_ONLY) {
    const r = await kidFresh[name].apply(kidFresh, args)
    ok(r && r.ok === false && /只有家长/.test(r.error || ''), '孩子越权被拒：' + name + ' → ' + (r && r.error))
  }
  ok(rev() === rev0, '越权尝试一次云端写入都没有（rev 未变）')

  // ② 伪造本地身份：云端 member_role=child，即使把 role 改成 parent 也不放行
  kidFresh.setRole('parent')
  ok(kidFresh.getRole() === 'parent', '本地身份已被改成 parent（模拟改缓存）')
  const forged = await kidFresh.adjustPoints(99, '伪造')
  ok(forged.ok === false && /只有家长/.test(forged.error || ''), '云端孩子角色否决伪造的本地家长身份')
  ok(rev() === rev0, '伪造尝试同样没有写入')
  kidFresh.setRole('child')

  // ③ 双端操作不受守卫影响
  const day = dateUtil.today()
  const item = kidFresh.todayOverview().groups[0].items[0]
  ok((await kidFresh.toggleItem(day, item.id)).ok, '孩子仍能打卡')
  ok((await kidFresh.addNote('今天早点睡')).ok, '孩子仍能留言')
  ok((await kidFresh.addExtraToday('练琴 20 分钟', 5, true)).ok, '孩子仍能申请加项')
  ok((await kidFresh.addWish('去游乐园')).ok, '孩子仍能许愿')
  ok(rev() > rev0, '双端操作正常写云端')

  // ④ 家长：能操作；切到学生视角后不能操作（身份只决定看哪套界面）
  const p = await as('u-p1', 'parent')
  p.setRole('parent')
  const rev1 = rev()
  ok((await p.adjustPoints(3, '主动收拾')).ok, '家长手动加分成功')
  ok(rev() === rev1 + 1, '家长操作写入了云端')
  p.setRole('child')
  ok((await p.adjustPoints(3, '切视角')).ok === false, '家长切到学生视角后不能调分')
  p.setRole('parent')

  // ⑤ 本地模式：没有云端 member，回退当前身份
  const local = freshStore()
  local.startLocal('本地小家', '朵朵')
  ok(local.getRole() === 'parent', '本地模式默认家长')
  ok((await local.adjustPoints(2, '本地加分')).ok, '本地家长可以调分')
  local.setRole('child')
  ok((await local.adjustPoints(2, '本地越权')).ok === false, '本地孩子不能调分')

  // ⑥ 云端默认 child 的微信，用家长密码切到家长端后应能做家长操作（双身份设计）
  //    伪造本地身份、切回学生端、重启后未重新验证，都仍要拦住
  db.session = { user: { id: 'u-c1' } }
  // ⑤ 的本地模式会在共享 storage 里留下 mode=local，这里显式回到云端模式
  const mine = db.members.filter(function (m) { return m.owner_id === 'u-c1' })[0]
  global.wx.setStorageSync('ced_local_v2', {
    mode: '', familyId: String(mine.family_id), role: 'child', parentVerified: false
  })
  const k = freshStore()
  await k.bootstrap()
  k.setRole('child')
  ok((await k.adjustPoints(1, '孩子端')).ok === false, '⑥ 孩子端仍被拒')
  k.setRole('parent')
  ok(k.getRole() === 'parent', '⑥ 本地身份已改成 parent（未验证）')
  ok((await k.adjustPoints(1, '伪造')).ok === false, '⑥ 没有家长密码校验标记仍被拒')
  k.setRole('parent', true)
  ok((await k.adjustPoints(2, '密码通过后加分')).ok === true, '⑥ 通过家长密码切家长端后可以调分')
  ok((await k.setFamilyInfo('守卫家', '墨墨')).ok === true, '⑥ 家长端可以保存家庭信息')
  ok((await k.setMyLabel('王老师')).ok === true, '⑥ 家长端可以保存称呼')
  const prof = k.getDoc().profile || {}
  ok(Object.keys(prof).some(function (key) {
    return /\|p$/.test(key) && prof[key] && prof[key].label === '王老师'
  }), '⑥ 称呼写进了 uid|p 家长分身')

  const k2 = freshStore()
  await k2.bootstrap()
  ok(k2.getRole() === 'parent', '⑥ 重启后本地身份仍是家长端')
  ok((await k2.adjustPoints(1, '重启后加分')).ok === true, '⑥ 重启后家长权限仍有效')
  k2.setRole('child')
  ok((await k2.adjustPoints(1, '切回学生端')).ok === false, '⑥ 切回学生端立即失去家长权限')
  k2.setRole('parent')
  ok((await k2.adjustPoints(1, '未重新验证')).ok === false, '⑥ 再切家长端需重新输家长密码')

  console.log('家长权限守卫：通过 ' + pass + ' 条' + (process.exitCode ? '，有失败' : '，失败 0 条'))
}
main().catch((e) => { console.error(e); process.exitCode = 1 })
