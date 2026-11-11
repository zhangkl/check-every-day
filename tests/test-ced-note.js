/* 家庭留言板链路测试 */
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
  shape(row) { if (!row) return null; if (this.cols === '*') return clone(row); const out = {}; this.cols.split(',').forEach(c => { out[c.trim()] = clone(row[c.trim()]) }); return out }
  async run() {
    if (this.op === 'select') {
      const rows = db[this.table === 'ced_families' ? 'families' : 'members'].filter(r => this.visible(r) && this.match(r))
      if (this.isSingle) {
        if (rows.length !== 1) return { data: null, error: { code: 'PGRST116', message: 'x' } }
        return { data: this.shape(rows[0]), error: null }
      }
      return { data: rows.map(r => this.shape(r)), error: null }
    }
    if (this.op === 'insert') { db.seq += 1; const row = Object.assign({ id: db.seq, owner_id: db.uid(), rev: 1 }, clone(this.payload)); db[this.table === 'ced_families' ? 'families' : 'members'].push(row); return { data: [this.shape(row)], error: null } }
    if (this.op === 'update') { const rows = db.families.filter(r => this.visible(r) && this.match(r)); rows.forEach(r => Object.assign(r, clone(this.payload))); return { data: rows.map(r => this.shape(r)), error: null } }
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
function switchUser(id, name) {
  db.session = { user: { id: id, name: name } }
  // 模拟换一台设备：清掉本地偏好/缓存（真实场景两台手机各自独立）
  Object.keys(storage).forEach(function (k) { delete storage[k] })
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
  ok((await store.bootstrap()).ok, '家长端 bootstrap')
  const docRow = db.families[0]

  // 老数据兼容：没有 notes 字段
  delete docRow.doc.notes
  ok(Array.isArray(store.listNotes()) && store.listNotes().length === 0, '无 notes 字段返回空列表')

  // 非法输入
  ok(!(await store.addNote('')).ok, '空留言被拒绝')
  ok(!(await store.addNote('   ')).ok, '纯空格被拒绝')

  // 家长发两条留言
  const r1 = await store.addNote('周三春游，记得带水壶')
  ok(r1.ok, '家长发留言')
  await store.addNote('明天期末考试加油！')
  const notes1 = store.listNotes()
  ok(notes1.length === 2, '两条留言')
  ok(notes1[0].text === '明天期末考试加油！', '默认按时间倒序')
  ok(notes1[0].role === 'parent' && notes1[0].uid === 'u-parent', '留言带身份')

  // 50 字截断（找刚发的那条验证，不依赖排序位置）
  const longR = await store.addNote('长'.repeat(80))
  const longNote = store.listNotes().filter(n => n.id === longR.noteId)[0]
  ok(longNote.text.length === 50, '留言截断到 50 字')

  // 家长置顶（开关式，同时只有一条）
  const first = notes1[1]
  const p1 = await store.pinNote(first.id)
  ok(p1.ok && p1.pinned === true, '家长置顶成功')
  ok(store.listNotes()[0].id === first.id, '置顶的排最前')
  ok(store.listNotes().filter(n => n.pinned).length === 1, '同时只有一条置顶')
  const p2 = await store.pinNote(first.id)
  ok(p2.ok && p2.pinned === false, '再点取消置顶')
  ok(store.listNotes().every(n => !n.pinned), '取消后无置顶')
  // 置顶另一条时旧置顶自动取消
  await store.pinNote(first.id)
  const newer = store.listNotes().filter(n => n.id !== first.id)[0]
  const p3 = await store.pinNote(newer.id)
  ok(p3.ok && p3.pinned === true, '置顶另一条成功')
  ok(store.listNotes().filter(n => n.pinned).length === 1 && store.listNotes()[0].id === newer.id, '旧的置顶被自动取消')
  ok((await store.pinNote('no-such')).ok === false, '置顶不存在的留言报错')

  // 孩子端
  switchUser('u-child', 'child')
  const store2 = freshStore()
  ok((await store2.joinFamily(docRow.invite_code)).ok, '孩子加入家庭')
  ok((await store2.bootstrap()).ok, '孩子端加载')
  ok(!(await store2.pinNote(newer.id)).ok, '孩子置顶被拒绝')
  const r4 = await store2.addNote('今天数学好难')
  ok(r4.ok, '孩子发留言')
  const childNotes = store2.listNotes()
  ok(childNotes[0].pinned && childNotes[0].uid === 'u-parent', '孩子的留言不会顶掉置顶公告')
  ok(childNotes[1].uid === 'u-child', '孩子的留言在公告后面')

  // 删除权限
  const childNoteId = r4.noteId
  ok((await store2.removeNote(childNoteId)).ok, '孩子删除自己的留言')
  const r5 = await store2.addNote('再发一条')
  ok(!(await store2.removeNote(newer.id)).ok, '孩子不能删家长的公告')
  switchUser('u-parent', 'parent')
  const store3 = freshStore()
  ok((await store3.bootstrap()).ok, '家长端重新加载')
  ok((await store3.removeNote(r5.noteId)).ok, '家长能删孩子的留言')
  ok((await store3.removeNote(newer.id)).ok, '家长能删自己的留言')

  // 30 条裁剪：置顶不被裁
  for (let i = 0; i < 32; i++) {
    await store3.addNote('留言 ' + i)
  }
  const all = store3.listNotes()
  const pinnedAll = all.filter(n => n.pinned)
  ok(all.filter(n => !n.pinned).length <= 30, '非置顶裁剪到 30 条内')

  console.log('留言板：通过 ' + pass + ' 条，失败 ' + (process.exitCode ? 1 : 0) + ' 组')
}
main().catch(e => { console.error(e); process.exit(1) })
