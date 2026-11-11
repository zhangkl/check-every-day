/* 周中/周末清单配置链路测试 */
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
  db.session = { user: { id: 'u1', name: 'parent' } }
  const store = freshStore()
  store.startLocal('开关点赞', '朵朵')
  const day = require(path.join(ROOT, 'utils/date')).today()
  const item = store.todayOverview().groups[0].items[0]
  const v = await store.appendItemVoice(day, item.id, { path: 'wxfile://a.mp3', duration: 10, at: Date.now() })
  const v2 = await store.appendItemVoice(day, item.id, { path: 'wxfile://b.mp3', duration: 9, at: Date.now() })

  const bal0 = store.balance()

  /* 1. 点赞 → +1 分 */
  const r1 = await store.toggleVoiceLike(day, item.id, v.voiceId)
  ok(r1.ok && r1.liked === true && r1.likes === 1, '点赞 liked=true')
  ok(store.balance() === bal0 + 1, '点赞 +1 分')

  /* 2. 再点一次 = 取消，扣回 1 分 */
  const r2 = await store.toggleVoiceLike(day, item.id, v.voiceId)
  ok(r2.ok && r2.liked === false && r2.likes === 0, '再点取消赞')
  ok(store.balance() === bal0, '取消赞扣回 1 分，余额回到起点')
  const unlogs = store.logs(50).filter(l => l.kind === 'voice_unlike')
  ok(unlogs.length === 1 && unlogs[0].amount === -1, '流水记了 voice_unlike -1')

  /* 3. 取消后再点，正常再 +1 */
  const r3 = await store.toggleVoiceLike(day, item.id, v.voiceId)
  ok(r3.ok && r3.liked === true && r3.likes === 1, '取消后再点赞')
  ok(store.balance() === bal0 + 1, '余额 +1')

  /* 4. 两条语音互不影响 */
  ok(store.todayOverview().groups.flatMap(g => g.items).filter(i => i.id === item.id)[0].voices[1].liked === false, '另一条语音未受影响')

  /* 5. 老数据迁移：likes=3 → liked=true、likes 封顶 1（历史积分不追溯） */
  const docRaw = wx.getStorageSync('ced_local_doc_v1')
  docRaw.sheets[day].items.filter(i => i.id === item.id)[0].voices[0].likes = 3
  docRaw.sheets[day].items.filter(i => i.id === item.id)[0].voices[0].liked = undefined
  wx.setStorageSync('ced_local_doc_v1', docRaw)
  Object.keys(require.cache).forEach(k => { if (k.indexOf(path.join(ROOT, 'utils')) === 0) delete require.cache[k] })
  const store2 = freshStore()
  await store2.bootstrap()
  const migrated = store2.todayOverview().groups.flatMap(g => g.items).filter(i => i.id === item.id)[0].voices[0]
  ok(migrated.liked === true && migrated.likes === 1, '老数据 likes=3 迁移为已赞、封顶 1')

  /* 6. 迁移后取消赞只扣 1 分（不追溯历史多给的积分） */
  const bal1 = store2.balance()
  const r4 = await store2.toggleVoiceLike(day, item.id, v.voiceId)
  ok(r4.ok && r4.liked === false, '迁移后可取消赞')
  ok(store2.balance() === bal1 - 1, '取消只扣回 1 分')

  console.log('开关式点赞：通过 ' + pass + ' 条')
  if (process.exitCode) process.exit(1)
}
main().catch(e => { console.error('测试异常:', e); process.exit(1) })
