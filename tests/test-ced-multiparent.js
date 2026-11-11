/* 多家长 + 称呼链路测试 */
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
    // 模拟线上 ced_join_family：孩子码 → child，家长码 → parent；已是成员则身份不变
    rpc(name, params) {
      // 模拟线上 ced_join_family：家长码(旧) → parent；否则按 p_role，设了 parentPin 要核对
      const code = String(params.p_code || '').toUpperCase()
      const fam = db.families.filter(f => f.invite_code === code || f.parent_invite_code === code)[0]
      if (!fam) {
        return Promise.resolve({ data: null, error: { code: 'P0002', message: 'CODE_NOT_FOUND' } })
      }
      const uid = db.uid()
      const mine = db.members.filter(m => m.family_id === fam.id && m.owner_id === uid)[0]
      let role
      if (mine) {
        role = mine.member_role
      } else {
        role = fam.parent_invite_code === code ? 'parent' : (String(params.p_role || 'child') === 'parent' ? 'parent' : 'child')
        const pin = fam.doc && fam.doc.parentPin
        if (role === 'parent' && fam.parent_invite_code !== code && pin && String(params.p_pin || '') !== String(pin)) {
          return Promise.resolve({ data: null, error: { code: 'P0002', message: 'PIN_REQUIRED' } })
        }
        db.seq += 1
        db.members.push({ id: db.seq, family_id: fam.id, owner_id: uid, member_role: role })
      }
      return Promise.resolve({
        data: [{ out_family_id: fam.id, out_family_name: (fam.doc.family || {}).name || '我们家', out_role: role }],
        error: null
      })
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
function switchUser(id, name) {
  db.session = { user: { id: id, name: name } }
  Object.keys(storage).forEach(function (k) { delete storage[k] })
}
function freshStore() {
  Object.keys(require.cache).forEach(k => { if (k.indexOf(path.join(ROOT, 'utils')) === 0) delete require.cache[k] })
  return require(path.join(ROOT, 'utils/store.js'))
}

let pass = 0
function ok(c, l) { if (c) { pass++; return } console.log('  FAIL ' + l); process.exitCode = 1 }

async function main() {
  switchUser('u-mama', 'mama')
  const store = freshStore()
  await store.bootstrap() // 建立 session（真实流程登录后必走）
  ok((await store.createFamily('测试家', '朵朵')).ok, '妈妈创建家庭')
  const famRow = db.families[0]

  // 双码机制
  ok(typeof famRow.parent_invite_code === 'string' && /^[A-Z0-9]{6}$/.test(famRow.parent_invite_code), '家长码生成且为 6 位')
  ok(famRow.parent_invite_code !== famRow.invite_code, '家长码与孩子码不同')
  ok(store.getParentInviteCode() === famRow.parent_invite_code, '家长码可读取')
  ok(store.getInviteCode() === famRow.invite_code, '孩子码可读取')

  // 称呼：设置/读取/截断/非法输入
  ok(store.getMyLabel() === '', '未设置称呼为空')
  ok(!store.setMyLabel('').ok, '空称呼被拒绝')
  ok(!store.setMyLabel('   ').ok, '纯空格称呼被拒绝')
  ok((await store.setMyLabel('妈妈-plus-plus-plus-plus')).ok, '超长称呼可提交')
  ok(store.getMyLabel().length === 6, '称呼截断到 6 字')
  ok((await store.setMyLabel('妈妈')).ok, '改成正常称呼')
  ok(store.getMyLabel() === '妈妈', '称呼读回')
  console.log('profile keys:', Object.keys(famRow.doc.profile || {}), 'uid from label:', JSON.stringify(store.getMyLabel())); ok(famRow.doc.profile['u-mama|p'] && famRow.doc.profile['u-mama|p'].label === '妈妈', '称呼写进家庭文档（uid|p 键）')

  // labelFor：有称呼用称呼，没称呼按身份回退
  ok(store.labelFor('u-mama', 'parent') === '妈妈', '有称呼显示称呼')
  ok(store.labelFor('u-nobody', 'parent') === '家长', '无称呼家长回退「家长」')
  ok(store.labelFor('u-child-uid', 'child') === '朵朵', '无称呼孩子回退昵称')

  // 另一位家长用家长码加入 → parent 身份
  const parentCode = famRow.parent_invite_code
  switchUser('u-baba', 'baba')
  const store2 = freshStore()
  const jr = await store2.joinFamily(parentCode)
  ok(jr.ok, '爸爸用家长码加入成功')
  ok(jr.role === 'parent', '家长码加入后身份是 parent')
  const memberRow = db.members.filter(m => m.owner_id === 'u-baba')[0]
  ok(memberRow.member_role === 'parent', '成员表落库为 parent')
  ok((await store2.bootstrap()).ok, '爸爸端加载')
  ok(store2.getRole() === 'parent', 'bootstrap 后角色是家长')
  ok(store2.getParentInviteCode() === parentCode, '新家长也能读家长码')

  // 爸爸设称呼，妈妈端同步可见（labelFor 跨端）
  ok((await store2.setMyLabel('爸爸')).ok, '爸爸设置称呼')
  const store3 = freshStore()
  ok((await store3.bootstrap()).ok, '妈妈端重新加载')
  ok(store3.labelFor('u-baba', 'parent') === '爸爸', '妈妈端看到爸爸的称呼')

  // 孩子码加入仍是孩子
  switchUser('u-child', 'child')
  const store4 = freshStore()
  const cr = await store4.joinFamily(famRow.invite_code)
  await store4.bootstrap()
  ok(cr.ok && cr.role === 'child', '孩子码加入身份是 child')
  ok(store4.labelFor('u-child', 'child') === '朵朵', '孩子称呼回退昵称')

  // 一码双身份：用同一个孩子码选「家长」身份加入
  // 1) 家里没设家长密码 → 直接进家长端
  switchUser('u-yeye', 'yeye')
  const store6 = freshStore()
  const r6 = await store6.joinFamily(famRow.invite_code, { role: 'parent' })
  ok(r6.ok && r6.role === 'parent', '共用码 + 家长身份（未设密码）直接进家长端')
  // 2) 设了家长密码后：不带密码 → needPin；带错密码 → 拒；带对密码 → 进家长端
  switchUser('u-mama', 'mama')
  const store7 = freshStore()
  await store7.bootstrap()
  ok((await store7.setPin('2026')).ok, '家里设置家长密码')
  switchUser('u-waima', 'waima')
  const store8 = freshStore()
  const r8 = await store8.joinFamily(famRow.invite_code, { role: 'parent' })
  ok(!r8.ok && r8.needPin, '设了密码后不带密码被拒（needPin）')
  const r9 = await store8.joinFamily(famRow.invite_code, { role: 'parent', pin: '0000' })
  ok(!r9.ok && r9.needPin, '密码错误被拒')
  const r10 = await store8.joinFamily(famRow.invite_code, { role: 'parent', pin: '2026' })
  ok(r10.ok && r10.role === 'parent', '密码正确进家长端')
  // 3) 同一个码选孩子身份不受密码影响
  switchUser('u-didi', 'didi')
  const store9 = freshStore()
  const r11 = await store9.joinFamily(famRow.invite_code, { role: 'child' })
  ok(r11.ok && r11.role === 'child', '孩子身份加入不受家长密码影响')

  // 老数据兼容：doc 无 profile 字段不报错
  delete famRow.doc.profile
  switchUser('u-mama', 'mama')
  const store5 = freshStore()
  ok((await store5.bootstrap()).ok, '无 profile 老数据加载')
  ok(store5.getMyLabel() === '', '老数据称呼为空不报错')
  ok(store5.labelFor('u-baba', 'parent') === '家长', '老数据下无称呼家长回退正常')

  console.log('多家长与称呼：通过 ' + pass + ' 条，失败 ' + (process.exitCode ? 1 : 0) + ' 组')
}
main().catch(e => { console.error(e); process.exit(1) })
