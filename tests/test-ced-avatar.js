/* 头像（个人资料）链路测试 */
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
  // 家长建家庭
  db.session = { user: { id: 'u-parent', name: 'parent' } }
  const store = freshStore()
  ok((await store.createFamily('测试家', '朵朵')).ok, '创建家庭')

  // 家庭信息修改：改名称和昵称、读回、校验
  ok((await store.setFamilyInfo('墨墨之家', '墨墨')).ok, '改家庭信息')
  ok(store.getFamily().name === '墨墨之家' && store.getFamily().childName === '墨墨', '家庭信息读回')
  ok(!store.setFamilyInfo('', '墨墨').ok, '空家庭名被拒')
  ok(!store.setFamilyInfo('家', '').ok, '空昵称被拒')
  ok((await store.setFamilyInfo('一二三四五六七八九十一二三四五六', '朵朵')).ok, '超长家庭名截断不报错')
  ok(store.getFamily().name === '一二三四五六七八九十一二三四五六'.slice(0, 12), '家庭名截断到 12 字')
  ok(Array.isArray(store.AVATARS) && store.AVATARS.length === 5, '基础头像池 5 款')
  ok(store.AVATARS.every(a => typeof a === 'string' && a), '头像池都是非空字符串')

  // 未设置时为空（UI 回退到角色默认头像）
  ok(store.getMyAvatar() === '', '未设置时返回空')

  // 非法输入
  ok(!store.setMyAvatar('').ok, '空头像被拒绝')
  ok(!store.setMyAvatar(null).ok, 'null 被拒绝')

  // 设置与读取
  ok((await store.setMyAvatar('🦊')).ok, '家长设置头像')
  ok(store.getMyAvatar() === '🦊', '读回自己的头像')
  ok((await store.setMyAvatar('⭐')).ok, '换成第二个')
  ok(store.getMyAvatar() === '⭐', '换头像生效（开关式覆盖）')

  // 老数据兼容：doc 里没有 profile 字段不报错（normalizeDoc 迁移）
  const famRow = db.families[0]
  delete famRow.doc.profile
  const store2 = freshStore()
  ok((await store2.bootstrap()).ok, '无 profile 字段的老数据能正常加载')
  ok(store2.getMyAvatar() === '', '老数据读头像为空不报错')
  ok((await store2.setMyAvatar('🐼')).ok, '老数据上设置头像成功')
  ok(store2.getMyAvatar() === '🐼', '老数据读回头像')

  // 持久化：mutate 写回了家庭文档（rev 变化、doc.profile 落库）
  ok(famRow.doc.profile && famRow.doc.profile['u-parent|p'] && famRow.doc.profile['u-parent|p'].avatar === '🐼', '头像写进家庭文档（uid|p 键）')

  // 多用户隔离：孩子（另一 uid）按真实流程加入家庭，设置头像不影响家长
  const invite = famRow.invite_code
  function switchUser(id, name) {
    db.session = { user: { id: id, name: name } }
    // 模拟换一台设备：清掉本地偏好/缓存（真实场景两台手机各自独立）
    Object.keys(storage).forEach(function (k) { delete storage[k] })
  }
  switchUser('u-child', 'child')
  const store3 = freshStore()
  ok((await store3.joinFamily(invite)).ok, '孩子用邀请码加入家庭')
  ok((await store3.bootstrap()).ok, '孩子端加载')
  ok(store3.getMyAvatar() === '', '孩子看到自己的头像为空（不受家长影响）')
  ok((await store3.setMyAvatar('🐸')).ok, '孩子设置头像')
  ok(store3.getMyAvatar() === '🐸', '孩子读回自己的头像')
  switchUser('u-parent', 'parent')
  const store4 = freshStore()
  ok((await store4.bootstrap()).ok, '家长端重新加载')
  ok(store4.getMyAvatar() === '🐼', '家长头像不受孩子影响')
  console.log('头像链路：通过 ' + pass + ' 条，失败 ' + (process.exitCode ? 1 : 0) + ' 组')
}
main().catch(e => { console.error(e); process.exit(1) })
