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
function eq(a, b, l) { ok(a === b, l + '（期望 ' + b + '，实际 ' + a + '）') }

async function main() {
  const tc3 = require(path.join(ROOT, 'utils/tc3'))

  /* ---- 1. SHA-256 标准测试向量（FIPS 180） ---- */
  eq(tc3.sha256Hex(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', 'sha256 空串')
  eq(tc3.sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad', 'sha256 abc')
  eq(
    tc3.sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'),
    '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    'sha256 448bit 向量'
  )
  // 长度跨过多个分块（>55 字节触发填充进位）
  const longStr = new Array(200).join('x')
  eq(
    tc3.sha256Hex(longStr),
    require('crypto').createHash('sha256').update(longStr).digest('hex'),
    'sha256 长串对照 node crypto'
  )
  // 中文 UTF-8
  eq(
    tc3.sha256Hex('今天数学课学了分数'),
    require('crypto').createHash('sha256').update('今天数学课学了分数', 'utf8').digest('hex'),
    'sha256 中文 UTF-8 对照'
  )

  /* ---- 2. HMAC-SHA256 RFC 4231 向量 ---- */
  const nodeHmac = (k, m) => require('crypto').createHmac('sha256', k).update(m).digest('hex')
  eq(
    tc3.toHex(tc3.hmacSha256('key', 'The quick brown fox jumps over the lazy dog')),
    'f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8',
    'hmac RFC 向量'
  )
  eq(tc3.toHex(tc3.hmacSha256('TC3Gu5t9xGARNpq86cd98joQYCN3Example', '2019-02-25')), nodeHmac('TC3Gu5t9xGARNpq86cd98joQYCN3Example', '2019-02-25'), 'hmac 对照 node')
  // 超 64 字节 key（触发 key = sha256(key) 分支）
  const bigKey = new Array(100).join('k')
  eq(tc3.toHex(tc3.hmacSha256(bigKey, 'msg')), nodeHmac(bigKey, 'msg'), 'hmac 超 64 字节 key')

  /* ---- 3. TC3 完整签名链路对照 node crypto ---- */
  // 用与 asr.callApi 相同的拼装方式在 node 里算一遍期望值
  // 仅作 HMAC 签名向量对照的测试假值；不用真实凭据格式，避免密钥扫描误判
  const SECRET_KEY = 'unit-test-only-key-not-a-credential'
  const ts = 1551113065
  const date = new Date(ts * 1000).toISOString().slice(0, 10)
  const payload = JSON.stringify({ Limit: 10, Offset: 0 })
  const hashedPayload = require('crypto').createHash('sha256').update(payload).digest('hex')
  const canonicalRequest = 'POST\n/\n\n' + 'content-type:application/json; charset=utf-8\nhost:asr.tencentcloudapi.com\n' + '\n' + 'content-type;host\n' + hashedPayload
  const stringToSign = 'TC3-HMAC-SHA256\n' + ts + '\n' + date + '/asr/tc3_request\n' + require('crypto').createHash('sha256').update(canonicalRequest).digest('hex')
  const kDate = nodeHmac('TC3' + SECRET_KEY, date)
  const kService = require('crypto').createHmac('sha256', Buffer.from(kDate, 'hex')).update('asr').digest('hex')
  const kSigning = require('crypto').createHmac('sha256', Buffer.from(kService, 'hex')).update('tc3_request').digest('hex')
  const expectSig = require('crypto').createHmac('sha256', Buffer.from(kSigning, 'hex')).update(stringToSign).digest('hex')
  const gotSig = tc3.toHex(
    tc3.hmacSha256(tc3.hmacSha256(tc3.hmacSha256('TC3' + SECRET_KEY, date), 'asr'), 'tc3_request' && require('crypto').createHash('sha256').update('tc3_request').digest() ? tc3.utf8Bytes('tc3_request') : null)
  )
  // 直接逐步对照
  eq(tc3.toHex(tc3.hmacSha256('TC3' + SECRET_KEY, date)), kDate, 'kDate 一致')
  eq(tc3.toHex(tc3.hmacSha256(Buffer.from(kDate, 'hex'), 'asr')), kService, 'kService 一致')
  eq(tc3.toHex(tc3.hmacSha256(Buffer.from(kService, 'hex'), 'tc3_request')), kSigning, 'kSigning 一致')
  eq(tc3.toHex(tc3.hmacSha256(Buffer.from(kSigning, 'hex'), stringToSign)), expectSig, '最终签名一致')

  console.log('TC3 加密库：通过 ' + pass + ' 条')
  if (process.exitCode) process.exit(1)
}
main().catch(e => { console.error('测试异常:', e); process.exit(1) })
