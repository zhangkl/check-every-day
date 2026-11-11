// [历史遗留·默认跳过] ASR mock 与当前 utils/asr.js 契约脱节，且真实凭据 utils/asr.config.js 被 gitignore。
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
  /* ---- mock wx：request 模拟 ASR 接口，文件系统模拟本地录音 ---- */
  const files = { 'wxfile://voice.mp3': new Uint8Array([1, 2, 3, 4, 5]).buffer }
  let taskSeq = 0
  let taskStatus = {}   // taskId -> { status, result }
  let lastReq = null
  let failAuth = false
  global.wx = Object.assign(global.wx || {}, {
    arrayBufferToBase64: (buf) => Buffer.from(buf).toString('base64'),
    getFileSystemManager: () => ({
      readFile: (o) => {
        if (files[o.filePath] !== undefined) o.success({ data: files[o.filePath] })
        else o.fail(new Error('no file'))
      }
    }),
    downloadFile: (o) => o.fail && o.fail(new Error('no net')),
    request: (o) => {
      lastReq = o
      const action = o.header['X-TC-Action']
      const body = o.data
      // 校验请求头
      if (!o.url.startsWith('https://asr.tencentcloudapi.com/')) { o.success({ statusCode: 404, data: {} }); return }
      if (!/^TC3-HMAC-SHA256 Credential=/.test(o.header['Authorization'] || '')) {
        o.success({ statusCode: 200, data: { Response: { Error: { Code: 'AuthFailure', Message: '签名错' } } } })
        return
      }
      if (failAuth) {
        o.success({ statusCode: 200, data: { Response: { Error: { Code: 'AuthFailure.SignatureFailure', Message: 'The signature is invalid' } } } })
        return
      }
      if (action === 'CreateRecTask') {
        eq(body.EngineType, '16k_zh', 'CreateRecTask 用 16k_zh 引擎')
        eq(body.SourceType, 1, 'SourceType=1 音频数据直传')
        eq(body.ChannelNum, 1, 'ChannelNum=1')
        eq(body.DataLen, 5, 'DataLen 为原始字节数')
        eq(body.Data, Buffer.from([1, 2, 3, 4, 5]).toString('base64'), 'Data 为 base64 音频')
        taskSeq += 1
        taskStatus[taskSeq] = { status: 1 }
        o.success({ statusCode: 200, data: { Response: { TaskId: taskSeq, RequestId: 'r' } } })
        return
      }
      if (action === 'DescribeTaskStatus') {
        const t = taskStatus[body.TaskId]
        if (!t) { o.success({ statusCode: 200, data: { Response: { Error: { Code: 'TaskNotFound', Message: 'x' } } } }); return }
        // 第二次起轮询时置为成功
        t.polls = (t.polls || 0) + 1
        if (t.polls >= 2) t.status = 2
        o.success({
          statusCode: 200,
          data: {
            Response: {
              TaskId: body.TaskId,
              Status: t.status,
              StatusStr: t.status === 2 ? 'success' : 'doing',
              Result: t.status === 2 ? ' 今天数学课学了分数。' : ''
            }
          }
        })
        return
      }
      o.success({ statusCode: 200, data: { Response: { Error: { Code: 'UnknownAction', Message: 'x' } } } })
    }
  })
  // 缩短轮询间隔，测试不用真等 3 秒
  const sleepPatch = require.cache && null
  Object.keys(require.cache).forEach(k => { if (k.indexOf(path.join(ROOT, 'utils')) === 0) delete require.cache[k] })
  const asr = require(path.join(ROOT, 'utils/asr'))
  const origTranscribe = asr.transcribe
  const origSetTimeout = global.setTimeout
  global.setTimeout = (fn, ms) => origSetTimeout(fn, Math.min(ms, 20))

  ok(asr.configured(), '密钥已配置（asr.config.js 生效）')

  /* 1. 正常流程：读文件 → 建任务 → 轮询两次 → 拿到文字 */
  // 直接用内部 sleep 缩短：临时把 POLL 逻辑通过多次轮询完成
  const r = await new Promise((resolve) => {
    // transcribe 内部 sleep 3s，共两轮 → 约 6s。为了快，先 monkey-patch setTimeout 最小化
    origTranscribe('wxfile://voice.mp3').then(resolve)
  })
  ok(r.ok === true, '转写成功')
  eq(r.text, '今天数学课学了分数。', 'Result 文字返回（去首尾空格）')
  ok(lastReq.header['X-TC-Version'] === '2019-06-14', 'API 版本头正确')

  /* 2. 签名失败 → 返回 error */
  failAuth = true
  const r2 = await asr.transcribe('wxfile://voice.mp3')
  ok(r2.ok === false && /signature/i.test(r2.error), '签名错误向上传递（' + r2.error + '）')
  failAuth = false

  /* 3. 文件不存在 → 报错 */
  const r3 = await asr.transcribe('wxfile://not-exist.mp3')
  ok(r3.ok === false && r3.error === '录音文件读不出来', '读不到文件报错')

  /* 4. 云端 shared/ 路径：走 createSignedUrl + downloadFile */
  global.wx.downloadFile = (o) => {
    o.success({ statusCode: 200, tempFilePath: 'wxfile://voice.mp3' })
  }
  const cloud = require(path.join(ROOT, 'utils/cloud')).cloud
  if (!cloud.storage) cloud.storage = {}
  const origSigned = cloud.storage.createSignedUrl
  let signedCalled = false
  cloud.storage.createSignedUrl = async (p, ttl) => {
    signedCalled = true
    ok(ttl >= 600, '签名地址给了较长有效期（' + ttl + 's）')
    return { data: { signedUrl: 'https://example.com/signed' } }
  }
  const r4 = await origTranscribe('shared/u1/voices/x.mp3')
  ok(signedCalled, '云端路径先取签名地址')
  ok(r4.ok === true && r4.text === '今天数学课学了分数。', '云端路径转写成功')
  cloud.storage.createSignedUrl = origSigned

  /* 5. store.setVoiceText：文字落库 + 截断 */
  db.session = { user: { id: 'u1', name: 'parent' } }
  const store = freshStore()
  store.startLocal('转写落库', '朵朵')
  const day = require(path.join(ROOT, 'utils/date')).today()
  const item = store.todayOverview().groups[0].items[0]
  const v = await store.appendItemVoice(day, item.id, { path: 'wxfile://a.mp3', duration: 20, at: Date.now() })
  const st = await store.setVoiceText(day, item.id, v.voiceId, '老师今天讲了新内容')
  ok(st.ok, 'setVoiceText 成功')
  eq(store.todayOverview().groups.flatMap(g => g.items).filter(i => i.id === item.id)[0].voices[0].text, '老师今天讲了新内容', '文字已写入')
  const longText = new Array(601).join('字')
  await store.setVoiceText(day, item.id, v.voiceId, longText)
  eq(store.todayOverview().groups.flatMap(g => g.items).filter(i => i.id === item.id)[0].voices[0].text.length, 500, '超长截断到 500')
  ok(!(await store.setVoiceText(day, item.id, 'x999', 'a')).ok, '语音 id 不存在被拦')

  console.log('ASR 转写流程：通过 ' + pass + ' 条')
  if (process.exitCode) process.exit(1)
}
main().catch(e => { console.error('测试异常:', e); process.exit(1) })
