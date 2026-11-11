/* 语音多条 + 点赞加分 + 撤销 回归测试（复用假云 mock 思路） */
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
  constructor(table, op, payload) {
    this.table = table
    this.op = op
    this.payload = payload
    this.filters = []
    this.cols = '*'
    this.isSingle = false
  }
  select(cols) { this.cols = cols || '*'; return this }
  eq(col, val) { this.filters.push([col, val]); return this }
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
      const rows = db[this.table === 'ced_families' ? 'families' : 'members']
        .filter(r => this.visible(r) && this.match(r))
      if (this.isSingle) {
        if (rows.length !== 1) return { data: null, error: { code: 'PGRST116', message: 'exactly one row expected' } }
        return { data: this.shape(rows[0]), error: null }
      }
      return { data: rows.map(r => this.shape(r)), error: null }
    }
    if (this.op === 'insert') {
      const uid = db.uid()
      db.seq += 1
      const row = Object.assign({ id: db.seq, owner_id: uid, rev: 1 }, clone(this.payload))
      if (this.table === 'ced_families') db.families.push(row)
      else db.members.push(row)
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
    async getSession() {
      return db.session ? { data: { user: db.session.user }, error: null } : { data: null, error: null }
    },
    async signOut() { db.session = null; return { error: null } }
  },
  database: {
    from(table) { return new Builder(table, 'select') },
    rpc(name, params) {
      const code = String(params.p_code || '').toUpperCase()
      const fam = db.families.filter(f => f.invite_code === code)[0]
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

const originalFrom = fakeCloud.database.from
fakeCloud.database.from = function (table) {
  const b = originalFrom.call(this, table)
  b.insert = (payload) => new Builder(table, 'insert', payload)
  b.update = (payload) => new Builder(table, 'update', payload)
  return b
}

Module._load = function (request, parent, isMain) {
  if (request === '@tencent-ai/workbuddy-cloud-sdk/miniprogram') {
    return { createMiniProgramWorkBuddyCloud: () => fakeCloud }
  }
  if (request === './workbuddy-cloud-diagnostics') return { createDiagnosticWx: (wx) => wx }
  return ORIGINAL_LOAD.apply(this, arguments)
}

function freshStore() {
  Object.keys(require.cache).forEach(k => {
    if (k.indexOf(path.join(ROOT, 'utils')) === 0) delete require.cache[k]
  })
  return require(path.join(ROOT, 'utils/store.js'))
}

let pass = 0
const fails = []
function ok(cond, label) {
  if (cond) { pass += 1; return }
  fails.push(label)
  console.log('  FAIL ' + label)
}
function eq(a, e, l) { ok(a === e, l + '（期望 ' + e + '，实际 ' + a + '）') }

async function main() {
  db.session = { user: { id: 'u1', name: 'parent' } }
  const store = freshStore()

  /* 1. 建家庭（家长身份） */
  const created = await store.createFamily('测试家', '朵朵')
  ok(created.ok, '创建家庭')
  const day = require(path.join(ROOT, 'utils/date')).today()

  /* 2. 勾选第一项 */
  let ov = store.todayOverview()
  const it1 = ov.groups[0].items[0]
  const t1 = await store.toggleItem(day, it1.id)
  ok(t1.ok && t1.done, '勾选成功')
  const earnedBefore = store.todayOverview().earned

  /* 3. 追加两条语音 */
  const v1 = await store.appendItemVoice(day, it1.id, { path: 'shared/u/voices/a.mp3', duration: 12, at: Date.now() })
  ok(v1.ok && v1.voiceId, '追加语音 1')
  const v2 = await store.appendItemVoice(day, it1.id, { path: 'shared/u/voices/b.mp3', duration: 8, at: Date.now() })
  ok(v2.ok && v2.voiceId !== v1.voiceId, '追加语音 2（id 不同）')
  ov = store.todayOverview()
  const itemNow = ov.groups[0].items[0]
  eq(itemNow.voices.length, 2, '一个项上有两条语音')

  /* 4. 家长点赞（开关式）：点赞 +1 分，再点取消扣回 */
  const balBefore = store.balance()
  const r1 = await store.toggleVoiceLike(day, it1.id, v1.voiceId)
  ok(r1.ok && r1.liked === true && r1.likes === 1, '首次点赞 liked=true likes=1')
  eq(store.balance(), balBefore + 1, '点赞 +1 分计入余额')
  eq(store.todayOverview().earned, earnedBefore + 1, '点赞分计入当天 earned')
  const r2 = await store.toggleVoiceLike(day, it1.id, v1.voiceId)
  ok(r2.ok && r2.liked === false && r2.likes === 0, '再次点击取消赞')
  eq(store.balance(), balBefore, '取消赞扣回 1 分')
  const r3 = await store.toggleVoiceLike(day, it1.id, v1.voiceId)
  eq(r3.likes, 1, '取消后可再点赞')
  const likeLogs = store.logs(50).filter(l => l.kind === 'voice_like')
  eq(likeLogs.length, 2, '积分流水 voice_like 有 2 条')

  /* 5. 撤销仍然可用（家长长按走的就是这个 store 接口） */
  const rv = await store.revokeItem(day, it1.id)
  ok(rv.ok, '家长撤销成功')
  ov = store.todayOverview()
  eq(ov.groups[0].items[0].done, false, '撤销后回到未完成')
  eq(ov.groups[0].items[0].voices.length, 2, '撤销后语音仍保留')

  /* 6. 老数据迁移：手造一份 item.voice 单条旧文档 */
  const s = require(path.join(ROOT, 'utils/store'))
  Object.keys(require.cache).forEach(k => {
    if (k.indexOf(path.join(ROOT, 'utils')) === 0) delete require.cache[k]
  })
  const store2 = freshStore()
  const rawDoc = db.families[0].doc
  const someSheetKey = Object.keys(rawDoc.sheets)[0]
  const rawItem = rawDoc.sheets[someSheetKey].items[0]
  rawItem.voice = { path: 'shared/u/voices/old.mp3', duration: 20, at: 1699000000000 }
  delete rawItem.voices
  const norm = store2.__normalize ? store2.__normalize(rawDoc) : null
  // normalizeDoc 未导出，直接走 bootstrap 读取路径
  db.families[0].doc = rawDoc
  const boot = await store2.bootstrap()
  ok(boot.ok, '重新 bootstrap 成功')
  const ov2 = store2.todayOverview()
  const migrated = ov2.groups.flatMap(g => g.items).filter(i => i.id === rawItem.id)[0]
  ok(!!migrated, '迁移后的项还在清单里')
  eq(migrated.voices.length, 1, '旧单条 voice 迁移为 voices[0]')
  eq(migrated.voices[0].duration, 20, '迁移保留时长')
  eq(migrated.voices[0].likes, 0, '迁移默认 0 赞')
  eq(migrated.voices[0].liked, false, '迁移默认未点赞')
  ok(migrated.voice === undefined, '旧字段 voice 已删除')
  // 迁移后的语音可以被点赞
  const lv = await store2.toggleVoiceLike(day, migrated.id, migrated.voices[0].id)
  ok(lv.ok && lv.liked === true && lv.likes === 1, '迁移后的语音可以点赞')

  /* 7. 本地模式追加语音 */
  const store3 = freshStore()
  store3.startLocal('本地家', '朵朵')
  const day3 = require(path.join(ROOT, 'utils/date')).today()
  const ov3 = store3.todayOverview()
  const it3 = ov3.groups[0].items[0]
  const a1 = await store3.appendItemVoice(day3, it3.id, { path: 'wxfile://tmp_1.mp3', duration: 5, at: Date.now() })
  const a2 = await store3.appendItemVoice(day3, it3.id, { path: 'wxfile://tmp_2.mp3', duration: 6, at: Date.now() })
  ok(a1.ok && a2.ok, '本地模式追加两条语音')
  const ov3b = store3.todayOverview()
  eq(ov3b.groups[0].items[0].voices.length, 2, '本地模式两条语音都在')

  console.log('')
  console.log('通过 ' + pass + ' 条，失败 ' + fails.length + ' 条')
  if (fails.length) process.exit(1)
}

main().catch(e => { console.error('测试异常:', e); process.exit(1) })
