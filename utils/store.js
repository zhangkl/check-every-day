/**
 * 数据层：家庭数据以「整份文档 + 版本号」的形式存在云数据库 ced_families.doc 里。
 * - 读：直接从内存快照读（同步），页面不用改成异步。
 * - 写：先改内存快照，再带 rev 版本号乐观锁写回云端；失败自动回滚并提示。
 */
const dateUtil = require('./date')
const { cloud } = require('./cloud')

const FAMILY_TABLE = 'ced_families'
const MEMBER_TABLE = 'ced_members'

const FULL_BONUS = 10
const STREAK_7_BONUS = 30
const STREAK_30_BONUS = 150

const LOCAL_KEY = 'ced_local_v2'
const CACHE_KEY = 'ced_cache_v2'
const LOCAL_DOC_KEY = 'ced_local_doc_v1'

const SHEET_KEEP_DAYS = 120
const LOG_KEEP = 800

const TEMPLATE = [
  {
    icon: '📚',
    title: '校内作业',
    children: [
      { title: '语文', points: 8 },
      { title: '数学', points: 7 },
      { title: '英语', points: 5 }
    ]
  },
  {
    icon: '📖',
    title: '明日课程预习',
    children: [
      { title: '语文', points: 4 },
      { title: '数学', points: 3 },
      { title: '英语', points: 3 }
    ]
  },
  {
    icon: '✏️',
    title: '课外加餐',
    children: [
      { title: '口算一页', points: 6 },
      { title: '课外阅读 20 分钟', points: 6 }
    ]
  },
  {
    icon: '🎒',
    title: '明日教材整理',
    children: [
      { title: '课本', points: 2 },
      { title: '作业本', points: 2 },
      { title: '文具盒', points: 2 }
    ]
  },
  {
    icon: '🌱',
    title: '其它补充',
    children: []
  }
]

const DEFAULT_GIFTS = [
  { icon: '🍦', name: '一次冰淇淋', cost: 80 },
  { icon: '✏️', name: '一支好看的中性笔', cost: 100 },
  { icon: '🎮', name: '30 分钟游戏时间', cost: 150 },
  { icon: '📚', name: '一本想要的书', cost: 400 },
  { icon: '🎬', name: '周末看一场电影', cost: 500 },
  { icon: '🧱', name: '心仪的乐高小套装', cost: 1200 }
]

const TITLES = [
  { at: 0, name: '小新星' },
  { at: 300, name: '坚持者' },
  { at: 800, name: '自律小达人' },
  { at: 2000, name: '时间管理师' },
  { at: 5000, name: 'PDCA 好习惯大师' }
]

const ALL_DAYS = [1, 2, 3, 4, 5, 6, 7]
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

const state = {
  session: null,
  member: null,
  familyId: null,
  doc: null,
  rev: 0,
  inviteCode: '',
  role: 'child',
  mode: '',
  error: ''
}

/* ---------------- 本地小工具 ---------------- */

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function readSync(key) {
  try {
    const raw = wx.getStorageSync(key)
    return raw && typeof raw === 'object' ? raw : null
  } catch (e) {
    return null
  }
}

function writeSync(key, value) {
  try {
    wx.setStorageSync(key, value)
  } catch (e) {
    // 本地缓存写不进去不影响云端数据
  }
}

// 删除存储键：removeStorageSync 在个别运行环境可能不可用，
// 失败时写一个空值兜底——readSync 只认对象，空值等同删除。
function removeSync(key) {
  try {
    wx.removeStorageSync(key)
  } catch (e) {
    try {
      wx.setStorageSync(key, '')
    } catch (e2) {}
  }
}

function readLocal() {
  return readSync(LOCAL_KEY) || {}
}

function writeLocal(patch) {
  const next = Object.assign({}, readLocal(), patch)
  writeSync(LOCAL_KEY, next)
  return next
}

function genCode() {
  let out = ''
  for (let i = 0; i < 6; i += 1) {
    out += CODE_ALPHABET.charAt(Math.floor(Math.random() * CODE_ALPHABET.length))
  }
  return out
}

/* ---------------- 文档骨架 ---------------- */

function blankDoc(familyName, childName) {
  const s = {
    v: 2,
    setupDone: true,
    family: {
      name: (familyName || '').trim() || '我们家',
      childName: (childName || '').trim() || '小朋友'
    },
    parentPin: '',
    tasks: [],
    sheets: {},
    logs: [],
    gifts: [],
    wishes: [],
    redemptions: [],
    coupons: [],
    maxStreak: 0,
    seq: 1000
  }
  seedDoc(s)
  return s
}

function newId(s) {
  s.seq += 1
  return 'x' + s.seq
}

function seedDoc(s) {
  TEMPLATE.forEach(function (g, gi) {
    const groupKey = newId(s)
    s.tasks.push({
      id: groupKey,
      groupKey: groupKey,
      level: 1,
      title: g.title,
      icon: g.icon,
      points: 0,
      sort: gi * 10,
      repeatDays: ALL_DAYS.slice(),
      active: true,
      extraDate: null,
      createdBy: 'system'
    })
    g.children.forEach(function (c, ci) {
      s.tasks.push({
        id: newId(s),
        groupKey: groupKey,
        level: 2,
        title: c.title,
        icon: g.icon,
        points: c.points,
        sort: ci * 10,
        repeatDays: ALL_DAYS.slice(),
        active: true,
        extraDate: null,
        createdBy: 'system'
      })
    })
  })
  DEFAULT_GIFTS.forEach(function (g, i) {
    s.gifts.push({
      id: newId(s),
      icon: g.icon,
      name: g.name,
      cost: g.cost,
      active: true,
      sort: i * 10
    })
  })
  return s
}

function normalizeDoc(raw) {
  const s = raw && typeof raw === 'object' ? raw : {}
  const out = Object.assign({}, s)
  out.family = s.family || { name: '我们家', childName: '小朋友' }
  out.parentPin = s.parentPin || ''
  out.tasks = Array.isArray(s.tasks) ? s.tasks : []
  out.sheets = s.sheets && typeof s.sheets === 'object' ? s.sheets : {}
  out.logs = Array.isArray(s.logs) ? s.logs : []
  out.gifts = Array.isArray(s.gifts) ? s.gifts : []
  out.wishes = Array.isArray(s.wishes) ? s.wishes : []
  out.redemptions = Array.isArray(s.redemptions) ? s.redemptions : []
  out.coupons = Array.isArray(s.coupons) ? s.coupons : []
  out.maxStreak = Number(s.maxStreak) || 0
  out.seq = Number(s.seq) || 1000
  out.setupDone = true
  out.v = 2
  // 老数据迁移：item.voice 单条 → item.voices[] 多条（每条补上 id 供点赞定位）
  // 顺带修历史 bug：录音上限 3 分钟，存出 200″ 以上的只可能是
  // 旧版单位判断把「毫秒」当「秒」存了 → 换算回秒
  function fixVoiceDuration(d) {
    const n = Number(d) || 0
    return n > 200 ? Math.max(1, Math.round(n / 1000)) : n
  }
  Object.keys(out.sheets).forEach(function (k) {
    const sheet = out.sheets[k]
    const items = sheet && Array.isArray(sheet.items) ? sheet.items : []
    items.forEach(function (it) {
      if (!Array.isArray(it.voices)) {
        if (it.voice && typeof it.voice === 'object') {
          out.seq += 1
          it.voices = [
            {
              id: 'x' + out.seq,
              path: it.voice.path,
              duration: fixVoiceDuration(it.voice.duration),
              at: Number(it.voice.at) || 0,
              likes: 0,
              liked: false
            }
          ]
        } else {
          it.voices = []
        }
        delete it.voice
      } else {
        it.voices.forEach(function (v) {
          v.duration = fixVoiceDuration(v.duration)
          // 点赞规则改为「每条最多一个赞，再点取消」：
          // 老数据里点赞数大于 0 的一律视为已点过一个赞，赞数封顶为 1
          if (v.liked === undefined) {
            v.liked = (Number(v.likes) || 0) > 0
          }
          v.likes = v.liked ? 1 : 0
        })
      }
      // 学生加的临时项带待同意状态；老数据一律视为已同意
      if (!it.status) it.status = 'approved'
    })
  })
  return out
}

// 控制单份文档体积：只保留最近 120 天的清单，日志保留最近 800 条
function prune(s) {
  const keys = Object.keys(s.sheets || {})
  if (keys.length > SHEET_KEEP_DAYS + 40) {
    const cutoff = dateUtil.addDays(dateUtil.today(), -SHEET_KEEP_DAYS)
    keys.forEach(function (k) {
      if (k < cutoff) delete s.sheets[k]
    })
  }
  if (s.logs.length > LOG_KEEP) {
    s.logs = s.logs.slice(s.logs.length - LOG_KEEP)
  }
}

function doc() {
  return state.doc
}

function cur() {
  return state.doc || blankDoc('', '')
}

/* ---------------- 云端读写 ---------------- */

function saveCache() {
  if (!state.familyId || !state.doc) return
  writeSync(CACHE_KEY, {
    familyId: state.familyId,
    rev: state.rev,
    savedAt: Date.now(),
    doc: state.doc
  })
}

function readCache() {
  const c = readSync(CACHE_KEY)
  const local = readLocal()
  if (!c || !c.doc) return null
  if (local.familyId && String(c.familyId) !== String(local.familyId)) return null
  return c
}

function describeError(error) {
  if (!error) return '操作失败，请稍后再试'
  const code = error.code || ''
  if (code === '42501') return '登录状态失效了，请重新登录'
  if (code === '42P01' || code === 'PGRST205') return '云端数据表还没准备好'
  if (code === '23505') return '数据重复了，请再试一次'
  const msg = error.message || ''
  if (/network|timeout|fail/i.test(msg)) return '网络不太稳，请再试一次'
  return msg || '操作失败，请稍后再试'
}

async function fetchMember() {
  const { data, error } = await cloud.database
    .from(MEMBER_TABLE)
    .select('family_id, member_role')
  if (error) throw error
  return Array.isArray(data) ? data : []
}

async function loadDoc() {
  const { data, error } = await cloud.database
    .from(FAMILY_TABLE)
    .select('id, doc, rev, invite_code')
    .eq('id', state.familyId)
    .single()
  if (error) throw error
  state.doc = normalizeDoc(data.doc)
  state.rev = Number(data.rev) || 1
  state.inviteCode = data.invite_code || ''
  saveCache()
}

async function flush() {
  if (!state.familyId || !state.doc) return
  prune(state.doc)
  const nextRev = state.rev + 1
  const { data, error } = await cloud.database
    .from(FAMILY_TABLE)
    .update({ doc: state.doc, rev: nextRev, updated_at: new Date().toISOString() })
    .eq('id', state.familyId)
    .eq('rev', state.rev)
    .select('rev')
  if (error) throw error
  const rows = Array.isArray(data) ? data : []
  if (rows.length === 0) {
    const conflict = new Error('数据已被另一台设备更新')
    conflict.conflict = true
    throw conflict
  }
  state.rev = nextRev
}

/**
 * 所有写操作的唯一入口。
 * fn 直接改内存快照并返回结果；返回 { ok: false } 时表示业务校验没过，不写云端。
 * 云端写失败会回滚内存快照；版本冲突会拉最新数据后重放一次。
 */
async function mutate(fn) {
  // 本地模式：不联网，直接写手机存储
  if (state.mode === 'local') {
    if (!state.doc) return { ok: false, error: '本地数据还没准备好，请重新进入' }
    const snapshot = clone(state.doc)
    let result
    try {
      result = fn(state.doc)
    } catch (e) {
      state.doc = snapshot
      return { ok: false, error: '操作出错了，请再试一次' }
    }
    if (result && result.ok === false) {
      state.doc = snapshot
      return result
    }
    prune(state.doc)
    writeSync(LOCAL_DOC_KEY, state.doc)
    return result || { ok: true }
  }
  if (!state.doc || !state.familyId) {
    return { ok: false, error: '数据还没加载好，请下拉刷新' }
  }
  let attempt = 0
  while (attempt < 3) {
    attempt += 1
    const snapshot = clone(state.doc)
    let result
    try {
      result = fn(state.doc)
    } catch (e) {
      state.doc = snapshot
      return { ok: false, error: '操作出错了，请再试一次' }
    }
    if (result && result.ok === false) {
      state.doc = snapshot
      return result
    }
    try {
      await flush()
      saveCache()
      return result || { ok: true }
    } catch (e) {
      if (e && e.conflict) {
        try {
          await loadDoc()
        } catch (e2) {
          state.doc = snapshot
          saveCache()
          return { ok: false, error: describeError(e2) }
        }
        continue
      }
      state.doc = snapshot
      saveCache()
      return { ok: false, error: describeError(e) }
    }
  }
  return { ok: false, error: '别的设备刚改过数据，请下拉刷新后再试' }
}

/* ---------------- 启动 / 登录 / 家庭 ---------------- */

let bootPromise = null

function bootstrap() {
  if (!bootPromise) bootPromise = doBootstrap()
  return bootPromise
}

function resetBootstrap() {
  bootPromise = null
}

async function doBootstrap() {
  state.error = ''
  const local = readLocal()
  // 本地模式：跳过登录和网络，直接读手机上的文档
  if (local.mode === 'local') {
    const doc = readSync(LOCAL_DOC_KEY)
    if (doc && doc.v) {
      state.mode = 'local'
      state.familyId = 'local'
      state.doc = normalizeDoc(doc)
      state.rev = 0
      state.role = local.role === 'parent' ? 'parent' : 'child'
      return { ok: true }
    }
    // 偏好残留但文档没了，回到登录选择
    writeLocal({ mode: '', familyId: '', role: '' })
  }
  state.mode = 'cloud'
  let session = null
  try {
    const res = await cloud.auth.getSession()
    session = res.data
  } catch (e) {
    session = null
  }
  if (!session) {
    state.doc = null
    return { needLogin: true }
  }
  state.session = session
  try {
    const members = await fetchMember()
    if (!members.length) {
      state.doc = null
      return { needSetup: true }
    }
    const chosen =
      members.filter(function (m) {
        return String(m.family_id) === String(local.familyId)
      })[0] || members[0]
    state.member = chosen
    state.familyId = chosen.family_id
    await loadDoc()
    const override = local.role === 'parent' || local.role === 'child' ? local.role : ''
    state.role = override || (chosen.member_role === 'parent' ? 'parent' : 'child')
    if (!override) writeLocal({ role: state.role })
    writeLocal({ familyId: state.familyId })
    return { ok: true }
  } catch (e) {
    state.error = describeError(e)
    const cached = readCache()
    if (cached) {
      state.familyId = cached.familyId
      state.rev = cached.rev
      state.doc = normalizeDoc(cached.doc)
      state.role = local.role === 'parent' ? 'parent' : 'child'
      return { ok: true, offline: true, error: state.error }
    }
    return { error: state.error }
  }
}

async function loginWithWechat() {
  return new Promise(function (resolve) {
    wx.login({
      async success(res) {
        try {
          const appid = wx.getAccountInfoSync().miniProgram.appId
          const out = await cloud.auth.signInWithWechat(res.code, appid)
          if (out.error) {
            resolve({ ok: false, error: out.error.message || '微信登录失败' })
            return
          }
          resetBootstrap()
          resolve({ ok: true })
        } catch (e) {
          resolve({ ok: false, error: '微信登录失败，请重试' })
        }
      },
      fail(err) {
        resolve({ ok: false, error: (err && err.errMsg) || '微信登录失败，请重试' })
      }
    })
  })
}

async function sendEmailCode(email) {
  const sent = await cloud.auth.sendOtp({ email: email })
  if (sent.error) return { ok: false, error: sent.error.message || '验证码发送失败' }
  return {
    ok: true,
    email: email,
    verificationId: sent.data.verificationId,
    isExistingUser: sent.data.isExistingUser
  }
}

async function verifyEmailCode(pending, code) {
  if (!pending) return { ok: false, error: '请先获取验证码' }
  const out = await cloud.auth.verifyOtp({
    email: pending.email,
    verificationId: pending.verificationId,
    isExistingUser: pending.isExistingUser,
    token: code
  })
  if (out.error) return { ok: false, error: out.error.message || '验证码不对' }
  resetBootstrap()
  return { ok: true }
}

async function signOut() {
  if (state.mode === 'local') {
    clearLocalData()
    return
  }
  try {
    await cloud.auth.signOut()
  } catch (e) {
    // 即使网络失败也把本地状态清掉
  }
  state.session = null
  state.member = null
  state.familyId = null
  state.doc = null
  state.rev = 0
  state.role = 'child'
  resetBootstrap()
  try {
    wx.removeStorageSync(CACHE_KEY)
    writeLocal({ familyId: '', role: '' })
  } catch (e) {}
}

async function createFamily(familyName, childName) {
  state.mode = 'cloud'
  const docNew = blankDoc(familyName, childName)
  let lastError = null
  for (let i = 0; i < 4; i += 1) {
    const code = genCode()
    const inserted = await cloud.database
      .from(FAMILY_TABLE)
      .insert({ invite_code: code, doc: docNew, rev: 1 })
      .select('id, invite_code')
    if (inserted.error) {
      lastError = inserted.error
      if (inserted.error.code === '23505') continue
      return { ok: false, error: '创建家庭失败：' + describeError(inserted.error) }
    }
    const rows = Array.isArray(inserted.data) ? inserted.data : []
    if (!rows.length) {
      lastError = { message: '没有拿到新家庭' }
      continue
    }
    const familyId = rows[0].id
    const member = await cloud.database
      .from(MEMBER_TABLE)
      .insert({ family_id: familyId, member_role: 'parent' })
      .select('id')
    if (member.error) {
      return { ok: false, error: '创建家庭失败：' + describeError(member.error) }
    }
    state.familyId = familyId
    state.doc = docNew
    state.rev = 1
    state.inviteCode = code
    state.member = { family_id: familyId, member_role: 'parent' }
    state.role = 'parent'
    writeLocal({ familyId: familyId, role: 'parent' })
    saveCache()
    resetBootstrap()
    return { ok: true, inviteCode: code, familyId: familyId }
  }
  return { ok: false, error: '创建家庭失败：' + describeError(lastError) }
}

async function joinFamily(code) {
  state.mode = 'cloud'
  const trimmed = String(code || '').trim().toUpperCase()
  if (!/^[A-Z0-9]{6}$/.test(trimmed)) {
    return { ok: false, error: '邀请码是 6 位字母或数字' }
  }
  const out = await cloud.database.rpc('ced_join_family', { p_code: trimmed })
  if (out.error) {
    if (/CODE_NOT_FOUND/.test(out.error.message || '')) {
      return { ok: false, error: '没找到这个邀请码，和爸爸妈妈再确认一下' }
    }
    return { ok: false, error: '加入家庭失败：' + describeError(out.error) }
  }
  const rows = Array.isArray(out.data) ? out.data : out.data ? [out.data] : []
  const row = rows[0]
  if (!row) return { ok: false, error: '加入家庭失败，请再试一次' }
  const familyId = row.out_family_id
  state.familyId = familyId
  state.member = { family_id: familyId, member_role: 'child' }
  state.role = 'child'
  writeLocal({ familyId: familyId, role: 'child' })
  try {
    await loadDoc()
    // 家长重复输入自家邀请码时，以真实成员身份为准
    const mine = (await fetchMember()).filter(function (m) {
      return String(m.family_id) === String(familyId)
    })[0]
    if (mine && mine.member_role === 'parent') {
      state.member = mine
      state.role = 'parent'
      writeLocal({ familyId: familyId, role: 'parent' })
    }
  } catch (e) {
    return { ok: false, error: '加入成功但读取数据失败：' + describeError(e) }
  }
  resetBootstrap()
  return { ok: true, familyId: familyId, familyName: row.out_family_name || '我们家' }
}

async function reload() {
  if (state.mode === 'local') return { ok: true }
  if (!state.familyId) return { ok: false }
  try {
    await loadDoc()
    return { ok: true }
  } catch (e) {
    return { ok: false, error: describeError(e) }
  }
}

/* ---------------- 本地模式（免登录） ---------------- */

function isLocal() {
  return state.mode === 'local' || state.familyId === 'local'
}

function hasLocalData() {
  const doc = readSync(LOCAL_DOC_KEY)
  return !!(doc && doc.v)
}

// 首次免登录使用：在手机上建一份本地家庭文档，默认家长身份（先配任务）
function startLocal(familyName, childName) {
  const docNew = blankDoc(familyName, childName)
  state.mode = 'local'
  state.familyId = 'local'
  state.doc = docNew
  state.rev = 0
  state.inviteCode = ''
  state.member = { family_id: 'local', member_role: 'parent' }
  state.role = 'parent'
  writeSync(LOCAL_DOC_KEY, docNew)
  writeLocal({ mode: 'local', familyId: 'local', role: 'parent' })
  resetBootstrap()
  return { ok: true }
}

// 退出本地模式但保留本机文档（供「登录并同步到云端」迁移用）
function exitLocal() {
  removeSync(LOCAL_KEY)
  state.mode = ''
  state.doc = null
  state.familyId = null
  state.member = null
  state.rev = 0
  state.inviteCode = ''
  state.role = 'child'
  resetBootstrap()
}

// 彻底清空本机数据：文档、偏好、缓存全删，回到登录选择
function clearLocalData() {
  removeSync(LOCAL_DOC_KEY)
  removeSync(LOCAL_KEY)
  removeSync(CACHE_KEY)
  state.mode = ''
  state.doc = null
  state.familyId = null
  state.member = null
  state.rev = 0
  state.inviteCode = ''
  state.role = 'child'
  resetBootstrap()
}

// 回到这台手机上已有的本地数据（exitLocal 退出但未清空时）
function resumeLocal() {
  const doc = readSync(LOCAL_DOC_KEY)
  if (!doc || !doc.v) return { ok: false, error: '这台手机上没有本地数据' }
  state.mode = 'local'
  state.familyId = 'local'
  state.doc = normalizeDoc(doc)
  state.rev = 0
  state.inviteCode = ''
  state.member = { family_id: 'local', member_role: 'parent' }
  state.role = 'parent'
  writeLocal({ mode: 'local', familyId: 'local', role: 'parent' })
  resetBootstrap()
  return { ok: true, childName: state.doc.family.childName }
}

// 登录并创建家庭后，把这台手机上的本地数据整体带到云端
async function importLocalToCloud() {
  const localDoc = readSync(LOCAL_DOC_KEY)
  if (!localDoc || !localDoc.v) return { ok: false, error: '这台手机上没有本地数据' }
  if (!state.familyId || state.familyId === 'local') {
    return { ok: false, error: '请先登录并创建家庭' }
  }
  const doc = normalizeDoc(localDoc)
  const nextRev = state.rev + 1
  const updated = await cloud.database
    .from(FAMILY_TABLE)
    .update({ doc: doc, rev: nextRev, updated_at: new Date().toISOString() })
    .eq('id', state.familyId)
    .eq('rev', state.rev)
    .select('rev')
  if (updated.error) return { ok: false, error: describeError(updated.error) }
  const rows = Array.isArray(updated.data) ? updated.data : []
  if (!rows.length) {
    return { ok: false, error: '云端数据刚被另一台设备更新过，请下拉刷新后再试' }
  }
  state.doc = doc
  state.rev = nextRev
  saveCache()
  try {
    wx.removeStorageSync(LOCAL_DOC_KEY)
  } catch (e) {}
  return { ok: true }
}

/* ---------------- 只读查询 ---------------- */

function isSetup() {
  return !!state.doc && !!state.doc.setupDone
}

function isLoggedIn() {
  return !!state.session
}

function getRole() {
  return state.role === 'parent' ? 'parent' : 'child'
}

function setRole(role) {
  state.role = role === 'parent' ? 'parent' : 'child'
  writeLocal({ role: state.role })
}

function getFamily() {
  return cur().family
}

function getPin() {
  return cur().parentPin || ''
}

function getInviteCode() {
  return state.inviteCode || ''
}

function sessionLabel() {
  const user = state.session && state.session.user ? state.session.user : null
  if (!user) return ''
  return user.name || user.email || ''
}

// 云存储 shared/<uid>/... 路径要用
function sessionUid() {
  const user = state.session && state.session.user ? state.session.user : null
  return user ? user.id || user.uid || '' : ''
}

/* ---------------- 清单模板 ---------------- */

function groupsForDay(s, day) {
  const wd = dateUtil.weekday(day)
  const groups = s.tasks.filter(function (t) {
    if (t.level !== 1 || !t.active) return false
    if (t.extraDate) return t.extraDate === day
    return t.repeatDays.indexOf(wd) >= 0
  })
  groups.sort(function (a, b) {
    return a.sort - b.sort
  })
  return groups
    .map(function (g) {
      const children = s.tasks
        .filter(function (t) {
          if (t.level !== 2 || t.groupKey !== g.groupKey || !t.active) return false
          if (t.extraDate) return t.extraDate === day
          // 老数据没有 repeatDays 视为每天
          const rd = Array.isArray(t.repeatDays) && t.repeatDays.length ? t.repeatDays : ALL_DAYS
          return rd.indexOf(wd) >= 0
        })
        .sort(function (a, b) {
          return a.sort - b.sort
        })
      return { group: g, children: children }
    })
    .filter(function (item) {
      return item.children.length > 0
    })
}

// 当天清单按模板现算，不落库；一旦有勾选会随整份文档一起存到云端
function ensureSheet(day) {
  const s = cur()
  if (s.sheets[day]) return s.sheets[day]
  const built = groupsForDay(s, day)
  const items = []
  built.forEach(function (entry, gi) {
    entry.children.forEach(function (c, ci) {
      items.push({
        id: newId(s),
        groupKey: entry.group.groupKey,
        groupTitle: entry.group.title,
        groupIcon: entry.group.icon,
        groupSort: gi * 10,
        title: c.title,
        points: c.points,
        sort: ci * 10,
        done: false,
        doneAt: null,
        revokedAt: null,
        status: 'approved'
      })
    })
  })
  s.sheets[day] = { day: day, items: items, createdAt: Date.now() }
  return s.sheets[day]
}

function getSheet(day) {
  const s = cur()
  return s.sheets[day] || null
}

function groupItems(items) {
  const map = {}
  const order = []
  items.forEach(function (it) {
    if (!map[it.groupKey]) {
      map[it.groupKey] = {
        key: it.groupKey,
        icon: it.groupIcon,
        title: it.groupTitle,
        sort: it.groupSort,
        items: [],
        doneCount: 0,
        pointsTotal: 0,
        pointsEarned: 0,
        activeTotal: 0
      }
      order.push(it.groupKey)
    }
    const g = map[it.groupKey]
    g.items.push(it)
    // 待同意的项只展示，不计入进度和分值
    if (it.status === 'pending') return
    g.activeTotal += 1
    g.pointsTotal += it.points
    if (it.done) {
      g.doneCount += 1
      g.pointsEarned += it.points
    }
  })
  order.sort(function (a, b) {
    return map[a].sort - map[b].sort
  })
  return order.map(function (k) {
    const g = map[k]
    g.items.sort(function (a, b) {
      return a.sort - b.sort
    })
    g.total = g.activeTotal
    g.allDone = g.doneCount === g.total && g.total > 0
    g.percent = g.total ? Math.round((g.doneCount / g.total) * 100) : 0
    return g
  })
}

/* ---------------- 积分 ---------------- */

function addLog(s, kind, amount, day, note, refId) {
  s.logs.push({
    id: newId(s),
    kind: kind,
    amount: amount,
    day: day,
    note: note || '',
    refId: refId || null,
    at: Date.now()
  })
}

function hasLog(s, kind, day) {
  return s.logs.some(function (l) {
    return l.kind === kind && l.day === day
  })
}

function balance() {
  return cur().logs.reduce(function (sum, l) {
    return sum + l.amount
  }, 0)
}

function earnedTotal() {
  return cur().logs.reduce(function (sum, l) {
    return l.amount > 0 ? sum + l.amount : sum
  }, 0)
}

function spentTotal() {
  return cur().logs.reduce(function (sum, l) {
    return l.amount < 0 && l.kind === 'redeem' ? sum - l.amount : sum
  }, 0)
}

function dayEarned(day) {
  return cur().logs.reduce(function (sum, l) {
    return l.day === day && l.amount > 0 ? sum + l.amount : sum
  }, 0)
}

/* ---------------- 连击 / 满勤 ---------------- */

function isComplete(s, day) {
  const sheet = s.sheets[day]
  if (!sheet || sheet.items.length === 0) {
    return s.coupons.some(function (c) {
      return c.day === day
    })
  }
  const allDone = sheet.items.every(function (it) {
    // 待同意的临时项不算未完成，不挡满勤
    return it.done || it.status === 'pending'
  })
  if (allDone) return true
  return s.coupons.some(function (c) {
    return c.day === day
  })
}

function streak() {
  const s = cur()
  const t = dateUtil.today()
  let cursor = t
  if (!isComplete(s, t)) cursor = dateUtil.addDays(t, -1)
  let n = 0
  while (n < 500) {
    if (isComplete(s, cursor)) {
      n += 1
      cursor = dateUtil.addDays(cursor, -1)
    } else {
      break
    }
  }
  if (n > (s.maxStreak || 0)) s.maxStreak = n
  return n
}

function settleDay(s, day) {
  const sheet = s.sheets[day]
  if (!sheet || sheet.items.length === 0) return
  const allDone = sheet.items.every(function (it) {
    return it.done
  })
  if (allDone && !hasLog(s, 'bonus_full', day)) {
    addLog(s, 'bonus_full', FULL_BONUS, day, '全部完成满勤奖', null)
  }
  if (!allDone && hasLog(s, 'bonus_full', day)) {
    s.logs = s.logs.filter(function (l) {
      return !(l.kind === 'bonus_full' && l.day === day)
    })
  }
  const cur0 = streak()
  if (cur0 >= 7 && !hasLog(s, 'bonus_streak7', day)) {
    addLog(s, 'bonus_streak7', STREAK_7_BONUS, day, '连续 7 天满勤', null)
  }
  if (cur0 >= 30 && !hasLog(s, 'bonus_streak30', day)) {
    addLog(s, 'bonus_streak30', STREAK_30_BONUS, day, '连续 30 天满勤', null)
  }
}

/* ---------------- 打卡动作 ---------------- */

function toggleItem(day, itemId) {
  return mutate(function (s) {
    ensureSheet(day)
    const sheet = s.sheets[day]
    if (!sheet) return { ok: false, error: '清单还没有生成' }
    const item = sheet.items.filter(function (it) {
      return it.id === itemId
    })[0]
    if (!item) return { ok: false, error: '找不到这一项' }
    if (item.status === 'pending') return { ok: false, error: '这一项要等家长同意' }
    if (item.status === 'del-pending') return { ok: false, error: '这一项在等家长处理删除申请' }
    if (item.done) {
      item.done = false
      item.doneAt = null
      addLog(s, 'untask', -item.points, day, '取消勾选 · ' + item.title, item.id)
      settleDay(s, day)
      return { ok: true, done: false, change: -item.points, allDone: isComplete(s, day) }
    }
    item.done = true
    item.doneAt = Date.now()
    item.revokedAt = null
    addLog(s, 'task', item.points, day, item.title, item.id)
    const allDone = isComplete(s, day)
    settleDay(s, day)
    return { ok: true, done: true, change: item.points, allDone: allDone }
  })
}

function revokeItem(day, itemId) {
  return mutate(function (s) {
    const sheet = s.sheets[day]
    if (!sheet) return { ok: false, error: '这一天没有清单' }
    const item = sheet.items.filter(function (it) {
      return it.id === itemId
    })[0]
    if (!item || !item.done) return { ok: false, error: '这一项已经是未完成' }
    item.done = false
    item.doneAt = null
    item.revokedAt = Date.now()
    addLog(s, 'revoke', -item.points, day, '家长撤销 · ' + item.title, item.id)
    settleDay(s, day)
    return { ok: true }
  })
}

function adjustPoints(amount, note) {
  return mutate(function (s) {
    addLog(s, 'adjust', amount, dateUtil.today(), note || '家长调整', null)
    return { ok: true }
  })
}

// 追加一条语音小结（同一项可有多条）；由调用方先把文件传到存储
function appendItemVoice(day, itemId, voice) {
  return mutate(function (s) {
    const sheet = s.sheets[day]
    if (!sheet) return { ok: false, error: '这一天没有清单' }
    const item = sheet.items.filter(function (it) {
      return it.id === itemId
    })[0]
    if (!item) return { ok: false, error: '找不到这一项' }
    if (!Array.isArray(item.voices)) item.voices = []
    const v = {
      id: newId(s),
      path: voice.path,
      duration: Number(voice.duration) || 0,
      at: Number(voice.at) || Date.now(),
      text: typeof voice.text === 'string' ? voice.text.slice(0, 500) : '',
      likes: 0,
      liked: false
    }
    item.voices.push(v)
    return { ok: true, voiceId: v.id }
  })
}

// 家长给语音点赞：可多次点赞，每赞 +1 分并记入积分流水
// 家长点赞/取消赞（开关式）：每条语音最多一个赞
// 点赞 → +1 分；再点一下取消 → 扣回 1 分
function toggleVoiceLike(day, itemId, voiceId) {
  return mutate(function (s) {
    const sheet = s.sheets[day]
    if (!sheet) return { ok: false, error: '这一天没有清单' }
    const item = sheet.items.filter(function (it) {
      return it.id === itemId
    })[0]
    if (!item) return { ok: false, error: '找不到这一项' }
    const v = (item.voices || []).filter(function (x) {
      return x.id === voiceId
    })[0]
    if (!v) return { ok: false, error: '找不到这段语音' }
    if (v.liked) {
      v.liked = false
      v.likes = 0
      addLog(s, 'voice_unlike', -1, day, '取消赞 · ' + item.title, v.id)
      return { ok: true, liked: false, likes: 0 }
    }
    v.liked = true
    v.likes = 1
    addLog(s, 'voice_like', 1, day, '点赞语音 · ' + item.title, v.id)
    return { ok: true, liked: true, likes: 1 }
  })
}

// 把转写出的文字写到某条语音上（转文字服务异步回调后调用）
function setVoiceText(day, itemId, voiceId, text) {
  return mutate(function (s) {
    const sheet = s.sheets[day]
    if (!sheet) return { ok: false, error: '这一天没有清单' }
    const item = sheet.items.filter(function (it) {
      return it.id === itemId
    })[0]
    if (!item) return { ok: false, error: '找不到这一项' }
    const v = (item.voices || []).filter(function (x) {
      return x.id === voiceId
    })[0]
    if (!v) return { ok: false, error: '找不到这段语音' }
    v.text = typeof text === 'string' ? text.slice(0, 500) : ''
    return { ok: true }
  })
}

// 学生删除自己的某条语音；带回文件路径，由调用方删存储文件
function removeVoice(day, itemId, voiceId) {
  return mutate(function (s) {
    const sheet = s.sheets[day]
    if (!sheet) return { ok: false, error: '这一天没有清单' }
    const item = sheet.items.filter(function (it) {
      return it.id === itemId
    })[0]
    if (!item) return { ok: false, error: '找不到这一项' }
    const voices = Array.isArray(item.voices) ? item.voices : []
    const v = voices.filter(function (x) {
      return x.id === voiceId
    })[0]
    if (!v) return { ok: false, error: '找不到这段语音' }
    item.voices = voices.filter(function (x) {
      return x.id !== voiceId
    })
    return { ok: true, path: v.path || '' }
  })
}

function setPin(pin) {
  return mutate(function (s) {
    s.parentPin = pin || ''
    return { ok: true }
  })
}

/* ---------------- 任务管理 ---------------- */

function listTaskGroups() {
  const s = cur()
  const wd = dateUtil.weekday(dateUtil.today())
  const groups = s.tasks
    .filter(function (t) {
      return t.level === 1 && !t.extraDate
    })
    .sort(function (a, b) {
      return a.sort - b.sort
    })
  return groups.map(function (g) {
    const children = s.tasks
      .filter(function (t) {
        return t.level === 2 && t.groupKey === g.groupKey && !t.extraDate
      })
      .sort(function (a, b) {
        return a.sort - b.sort
      })
      .map(function (c) {
        return Object.assign({}, c, {
          repeatDays: Array.isArray(c.repeatDays) && c.repeatDays.length ? c.repeatDays : ALL_DAYS
        })
      })
    const points = children.reduce(function (sum, c) {
      return sum + c.points
    }, 0)
    return {
      id: g.id,
      groupKey: g.groupKey,
      icon: g.icon,
      title: g.title,
      active: g.active,
      repeatDays: g.repeatDays,
      todayOn: g.repeatDays.indexOf(wd) >= 0,
      points: points,
      children: children
    }
  })
}

function addGroup(title, icon) {
  return mutate(function (s) {
    const groups = s.tasks.filter(function (t) {
      return t.level === 1
    })
    const maxSort = groups.reduce(function (m, g) {
      return g.sort > m ? g.sort : m
    }, 0)
    const groupKey = newId(s)
    s.tasks.push({
      id: groupKey,
      groupKey: groupKey,
      level: 1,
      title: title,
      icon: icon || '📌',
      points: 0,
      sort: maxSort + 10,
      repeatDays: ALL_DAYS.slice(),
      active: true,
      extraDate: null,
      createdBy: 'parent'
    })
    return { ok: true, groupKey: groupKey }
  })
}

function updateGroup(groupKey, patch) {
  return mutate(function (s) {
    s.tasks.forEach(function (t) {
      if (t.level === 1 && t.groupKey === groupKey) {
        if (patch.title !== undefined) t.title = patch.title
        if (patch.icon !== undefined) t.icon = patch.icon
        if (patch.active !== undefined) t.active = patch.active
        if (patch.repeatDays !== undefined) t.repeatDays = patch.repeatDays
      }
      if (t.level === 2 && t.groupKey === groupKey) {
        if (patch.icon !== undefined) t.icon = patch.icon
        if (patch.active !== undefined) t.active = patch.active
      }
    })
    return { ok: true }
  })
}

function removeGroup(groupKey) {
  return mutate(function (s) {
    s.tasks = s.tasks.filter(function (t) {
      return t.groupKey !== groupKey
    })
    return { ok: true }
  })
}

function addChild(groupKey, title, points) {
  return mutate(function (s) {
    const siblings = s.tasks.filter(function (t) {
      return t.level === 2 && t.groupKey === groupKey
    })
    const maxSort = siblings.reduce(function (m, c) {
      return c.sort > m ? c.sort : m
    }, -10)
    s.tasks.push({
      id: newId(s),
      groupKey: groupKey,
      level: 2,
      title: title,
      icon: '',
      points: Number(points) || 0,
      sort: maxSort + 10,
      repeatDays: ALL_DAYS.slice(),
      active: true,
      extraDate: null,
      createdBy: 'parent'
    })
    return { ok: true }
  })
}

function updateChild(id, patch) {
  return mutate(function (s) {
    s.tasks.forEach(function (t) {
      if (t.id === id && t.level === 2) {
        if (patch.title !== undefined) t.title = patch.title
        if (patch.points !== undefined) t.points = Number(patch.points) || 0
        if (patch.repeatDays !== undefined) {
          t.repeatDays = Array.isArray(patch.repeatDays) && patch.repeatDays.length
            ? patch.repeatDays
            : ALL_DAYS.slice()
        }
      }
    })
    return { ok: true }
  })
}

function removeChild(id) {
  return mutate(function (s) {
    s.tasks = s.tasks.filter(function (t) {
      return t.id !== id
    })
    return { ok: true }
  })
}

// 只加今天：不影响模板，追加进当天清单。byChild=true 时为学生发起，待家长同意
function addExtraToday(title, points, byChild) {
  return mutate(function (s) {
    const day = dateUtil.today()
    let group = s.tasks.filter(function (t) {
      return t.level === 1 && !t.extraDate && t.title === '其它补充'
    })[0]
    if (!group) {
      const maxSort = s.tasks.reduce(function (m, t) {
        return t.level === 1 && t.sort > m ? t.sort : m
      }, 0)
      const gk = newId(s)
      group = {
        id: gk,
        groupKey: gk,
        level: 1,
        title: '其它补充',
        icon: '🌱',
        points: 0,
        sort: maxSort + 10,
        repeatDays: ALL_DAYS.slice(),
        active: true,
        extraDate: null,
        createdBy: 'parent'
      }
      s.tasks.push(group)
    }
    const pts = Number(points) || 0
    const siblings = s.tasks.filter(function (t) {
      return t.level === 2 && t.groupKey === group.groupKey
    })
    // 先把当天清单生成出来，再压临时任务；
    // 否则 ensureSheet 会按模板把刚压入的任务生成为已同意的项
    const sheet = ensureSheet(day)
    const taskId = newId(s)
    s.tasks.push({
      id: taskId,
      groupKey: group.groupKey,
      level: 2,
      title: title,
      icon: '',
      points: pts,
      sort: siblings.length * 10,
      repeatDays: ALL_DAYS.slice(),
      active: true,
      extraDate: day,
      createdBy: byChild ? 'child' : 'parent'
    })
    const dup = sheet.items.some(function (it) {
      return it.title === title && it.groupKey === group.groupKey
    })
    if (!dup) {
      sheet.items.push({
        id: newId(s),
        taskId: taskId,
        groupKey: group.groupKey,
        groupTitle: group.title,
        groupIcon: group.icon,
        groupSort: group.sort,
        title: title,
        points: pts,
        sort: siblings.length * 10,
        done: false,
        doneAt: null,
        revokedAt: null,
        status: byChild ? 'pending' : 'approved'
      })
    }
    return { ok: true, taskId: taskId }
  })
}

// 家长同意学生发起的临时项：之后孩子可以正常打卡得分
function approveExtra(day, itemId) {
  return mutate(function (s) {
    const sheet = s.sheets[day]
    if (!sheet) return { ok: false, error: '这一天没有清单' }
    const item = sheet.items.filter(function (it) {
      return it.id === itemId
    })[0]
    if (!item) return { ok: false, error: '找不到这一项' }
    if (item.status !== 'pending') return { ok: false, error: '这一项不需要同意' }
    item.status = 'approved'
    return { ok: true, points: item.points, title: item.title }
  })
}

// 家长改待同意临时项的分值（清单和模板任务同步）
function updateExtraPoints(day, itemId, points) {
  return mutate(function (s) {
    const sheet = s.sheets[day]
    if (!sheet) return { ok: false, error: '这一天没有清单' }
    const item = sheet.items.filter(function (it) {
      return it.id === itemId
    })[0]
    if (!item) return { ok: false, error: '找不到这一项' }
    if (item.status !== 'pending') return { ok: false, error: '只有待同意的项能改分值' }
    const p = Number(points)
    if (!p || p <= 0) return { ok: false, error: '分值要是正数' }
    item.points = Math.round(p)
    if (item.taskId) {
      s.tasks.forEach(function (t) {
        if (t.id === item.taskId) t.points = item.points
      })
    }
    return { ok: true, points: item.points }
  })
}

// 家长拒绝学生发起的临时项：从今天清单和模板里都去掉
function rejectExtra(day, itemId) {
  return mutate(function (s) {
    const sheet = s.sheets[day]
    if (!sheet) return { ok: false, error: '这一天没有清单' }
    const item = sheet.items.filter(function (it) {
      return it.id === itemId
    })[0]
    if (!item) return { ok: false, error: '找不到这一项' }
    if (item.status !== 'pending') return { ok: false, error: '只有待同意的项能拒绝' }
    if (item.taskId) {
      s.tasks = s.tasks.filter(function (t) {
        return t.id !== item.taskId
      })
    }
    sheet.items = sheet.items.filter(function (it) {
      return it.id !== itemId
    })
    return { ok: true }
  })
}

/* ---------------- 删除今日项 ---------------- */

function findSheetItem(s, day, itemId) {
  const sheet = s.sheets[day]
  if (!sheet) return { error: { ok: false, error: '这一天没有清单' } }
  const item = sheet.items.filter(function (it) {
    return it.id === itemId
  })[0]
  if (!item) return { error: { ok: false, error: '找不到这一项' } }
  return { sheet: sheet, item: item }
}

// 学生申请删除今天的某一项：标记 del-pending，家长同意后才真正移除
function requestDelete(day, itemId) {
  return mutate(function (s) {
    const f = findSheetItem(s, day, itemId)
    if (f.error) return f.error
    const item = f.item
    if (item.done) return { ok: false, error: '做完的项不能申请删除' }
    if (item.status === 'pending') return { ok: false, error: '这一项还在等家长同意加项' }
    if (item.status === 'del-pending') return { ok: false, error: '已经申请过了，等家长处理' }
    item.status = 'del-pending'
    return { ok: true, title: item.title }
  })
}

// 学生取消删除申请
function cancelDeleteRequest(day, itemId) {
  return mutate(function (s) {
    const f = findSheetItem(s, day, itemId)
    if (f.error) return f.error
    if (f.item.status !== 'del-pending') return { ok: false, error: '这一项没有待处理的删除申请' }
    f.item.status = 'approved'
    return { ok: true }
  })
}

// 家长同意删除：只从今天清单移除，模板不动（明天照常出现）
function approveDelete(day, itemId) {
  return mutate(function (s) {
    const f = findSheetItem(s, day, itemId)
    if (f.error) return f.error
    const item = f.item
    if (item.status !== 'del-pending') return { ok: false, error: '这一项没有待处理的删除申请' }
    if (item.done) return { ok: false, error: '这一项已完成，请先撤销再删除' }
    f.sheet.items = f.sheet.items.filter(function (it) {
      return it.id !== itemId
    })
    return { ok: true, title: item.title }
  })
}

// 家长拒绝删除申请：恢复正常打卡
function rejectDelete(day, itemId) {
  return mutate(function (s) {
    const f = findSheetItem(s, day, itemId)
    if (f.error) return f.error
    if (f.item.status !== 'del-pending') return { ok: false, error: '这一项没有待处理的删除申请' }
    f.item.status = 'approved'
    return { ok: true, title: f.item.title }
  })
}

// 家长直接删除今天的某一项（未完成、非待同意加项）
function deleteItemToday(day, itemId) {
  return mutate(function (s) {
    const f = findSheetItem(s, day, itemId)
    if (f.error) return f.error
    const item = f.item
    if (item.status === 'pending') return { ok: false, error: '待同意的加项请用「不同意」处理' }
    if (item.done) return { ok: false, error: '这一项已完成，请先撤销再删除' }
    f.sheet.items = f.sheet.items.filter(function (it) {
      return it.id !== itemId
    })
    return { ok: true, title: item.title }
  })
}

/* ---------------- 礼物 / 兑换 ---------------- */

function listGifts() {
  return cur()
    .gifts.filter(function (g) {
      return g.active
    })
    .sort(function (a, b) {
      return a.cost - b.cost
    })
}

function listAllGifts() {
  return cur()
    .gifts.slice()
    .sort(function (a, b) {
      return a.cost - b.cost
    })
}

function addGift(name, icon, cost, fromWish) {
  return mutate(function (s) {
    s.gifts.push({
      id: newId(s),
      icon: icon || '🎁',
      name: name,
      cost: Number(cost) || 0,
      active: true,
      fromWish: !!fromWish,
      sort: s.gifts.length * 10
    })
    return { ok: true }
  })
}

function updateGift(id, patch) {
  return mutate(function (s) {
    s.gifts.forEach(function (g) {
      if (g.id === id) {
        if (patch.name !== undefined) g.name = patch.name
        if (patch.icon !== undefined) g.icon = patch.icon
        if (patch.cost !== undefined) g.cost = Number(patch.cost) || 0
        if (patch.active !== undefined) g.active = patch.active
      }
    })
    return { ok: true }
  })
}

function removeGift(id) {
  return mutate(function (s) {
    s.gifts = s.gifts.filter(function (g) {
      return g.id !== id
    })
    return { ok: true }
  })
}

/* ---------------- 心愿：学生发起，家长审批后可上架成礼物 ---------------- */
function listWishes() {
  return cur()
    .wishes.slice()
    .sort(function (a, b) {
      return b.at - a.at
    })
}

function addWish(title, note) {
  const name = String(title || '').trim()
  if (!name) return Promise.resolve({ ok: false, error: '先写个心愿吧' })
  if (name.length > 20) return Promise.resolve({ ok: false, error: '心愿名太长了，写短一点' })
  return mutate(function (s) {
    const dup = s.wishes.some(function (w) {
      return w.status === 'pending' && w.title === name
    })
    if (dup) return { ok: false, error: '这个心愿已经在等爸爸妈妈看了' }
    s.wishes.push({
      id: newId(s),
      title: name,
      note: String(note || '').trim().slice(0, 60),
      status: 'pending',
      at: Date.now(),
      decidedAt: null
    })
    return { ok: true }
  })
}

function decideWish(id, approve) {
  return mutate(function (s) {
    const w = s.wishes.filter(function (x) {
      return x.id === id
    })[0]
    if (!w || w.status !== 'pending') return { ok: false, error: '这个心愿已经处理过了' }
    w.status = approve ? 'approved' : 'rejected'
    w.decidedAt = Date.now()
    return { ok: true, title: w.title }
  })
}

function requestRedeem(giftId) {
  return mutate(function (s) {
    const gift = s.gifts.filter(function (g) {
      return g.id === giftId
    })[0]
    if (!gift) return { ok: false, error: '礼物不存在' }
    if (balance() < gift.cost) return { ok: false, error: '积分还不够哦' }
    const pending = s.redemptions.some(function (r) {
      return r.giftId === giftId && r.status === 'pending'
    })
    if (pending) return { ok: false, error: '这一件已经在等爸爸妈妈同意了' }
    s.redemptions.push({
      id: newId(s),
      giftId: gift.id,
      giftName: gift.name,
      giftIcon: gift.icon,
      cost: gift.cost,
      status: 'pending',
      createdAt: Date.now(),
      decidedAt: null
    })
    return { ok: true }
  })
}

function decideRedeem(id, approve) {
  return mutate(function (s) {
    const r = s.redemptions.filter(function (item) {
      return item.id === id
    })[0]
    if (!r || r.status !== 'pending') return { ok: false, error: '这件申请已经处理过了' }
    if (approve) {
      if (balance() < r.cost) return { ok: false, error: '积分已经不够了' }
      r.status = 'approved'
      r.decidedAt = Date.now()
      addLog(s, 'redeem', -r.cost, dateUtil.today(), '兑换 · ' + r.giftName, r.id)
    } else {
      r.status = 'rejected'
      r.decidedAt = Date.now()
    }
    return { ok: true }
  })
}

function fulfillRedeem(id) {
  return mutate(function (s) {
    s.redemptions.forEach(function (r) {
      if (r.id === id) r.status = 'fulfilled'
    })
    return { ok: true }
  })
}

function listRedemptions() {
  return cur()
    .redemptions.slice()
    .sort(function (a, b) {
      return b.createdAt - a.createdAt
    })
}

/* ---------------- 护身符 ---------------- */

function couponStatus() {
  const s = cur()
  const month = dateUtil.monthKey(dateUtil.today())
  const used = s.coupons.filter(function (c) {
    return c.month === month
  })[0]
  return { used: !!used, day: used ? used.day : '', month: month }
}

function useCoupon(day) {
  return mutate(function (s) {
    const month = dateUtil.monthKey(day)
    if (
      s.coupons.some(function (c) {
        return c.month === month
      })
    ) {
      return { ok: false, error: '这个月的护身符已经用掉了' }
    }
    s.coupons.push({ day: day, month: month, at: Date.now() })
    return { ok: true }
  })
}

/* ---------------- 报表 / 成长 ---------------- */

function calendar(monthKeyStr) {
  const s = cur()
  const total = dateUtil.daysInMonth(monthKeyStr)
  const out = []
  for (let d = 1; d <= total; d += 1) {
    const day = monthKeyStr + '-' + (d < 10 ? '0' + d : '' + d)
    const sheet = s.sheets[day]
    let level = 0
    if (sheet && sheet.items.length) {
      const doneCount = sheet.items.filter(function (it) {
        return it.done
      }).length
      if (doneCount === sheet.items.length) level = 2
      else if (doneCount > 0) level = 1
    }
    const coupon = s.coupons.some(function (c) {
      return c.day === day
    })
    if (coupon && level < 2) level = 2
    out.push({
      day: d,
      key: day,
      level: level,
      isToday: day === dateUtil.today(),
      weekday: dateUtil.weekday(day)
    })
  }
  return out
}

function recentDays(n) {
  const s = cur()
  const t = dateUtil.today()
  const out = []
  for (let i = n - 1; i >= 0; i -= 1) {
    const day = dateUtil.addDays(t, -i)
    const sheet = s.sheets[day]
    const total = sheet ? sheet.items.length : 0
    const done = sheet
      ? sheet.items.filter(function (it) {
          return it.done
        }).length
      : 0
    out.push({
      key: day,
      label: dateUtil.weekdayCn(day).replace('周', ''),
      total: total,
      done: done,
      percent: total ? Math.round((done / total) * 100) : 0
    })
  }
  return out
}

function itemStats(days) {
  const s = cur()
  const t = dateUtil.today()
  const map = {}
  const order = []
  for (let i = days - 1; i >= 0; i -= 1) {
    const day = dateUtil.addDays(t, -i)
    const sheet = s.sheets[day]
    if (!sheet) continue
    sheet.items.forEach(function (it) {
      const key = it.groupTitle + '·' + it.title
      if (!map[key]) {
        map[key] = { key: key, label: it.title, group: it.groupTitle, total: 0, done: 0 }
        order.push(key)
      }
      map[key].total += 1
      if (it.done) map[key].done += 1
    })
  }
  return order
    .map(function (k) {
      const m = map[k]
      m.percent = m.total ? Math.round((m.done / m.total) * 100) : 0
      return m
    })
    .filter(function (m) {
      return m.total > 0
    })
    .sort(function (a, b) {
      return a.percent - b.percent
    })
}

function titleOf(earned) {
  let out = TITLES[0]
  TITLES.forEach(function (t) {
    if (earned >= t.at) out = t
  })
  const next = TITLES.filter(function (t) {
    return t.at > earned
  })[0]
  return {
    name: out.name,
    next: next ? next.name : '',
    nextAt: next ? next.at : 0,
    gap: next ? next.at - earned : 0
  }
}

function logs(limit) {
  const sorted = cur()
    .logs.slice()
    .sort(function (a, b) {
      return b.at - a.at
    })
  return limit ? sorted.slice(0, limit) : sorted
}

function todayOverview() {
  const s = cur()
  const day = dateUtil.today()
  const sheet = ensureSheet(day)
  const items = sheet.items
  const active = items.filter(function (it) {
    return it.status !== 'pending'
  })
  const done = active.filter(function (it) {
    return it.done
  }).length
  const groups = groupItems(items).map(function (g) {
    g.items = g.items.map(function (it) {
      return Object.assign({}, it, { time: dateUtil.timeHm(it.doneAt) })
    })
    return g
  })
  return {
    day: day,
    pretty: dateUtil.prettyFull(day),
    groups: groups,
    total: active.length,
    done: done,
    percent: active.length ? Math.round((done / active.length) * 100) : 0,
    earned: dayEarned(day),
    remain: active.reduce(function (sum, it) {
      return it.done ? sum : sum + it.points
    }, 0),
    balance: balance(),
    streak: streak()
  }
}

// 家长端「清空所有数据」：保留家庭成员，重置清单/积分/礼物
function resetAll() {
  return mutate(function (s) {
    const family = s.family
    const fresh = blankDoc(family.name, family.childName)
    Object.keys(s).forEach(function (k) {
      delete s[k]
    })
    Object.assign(s, fresh)
    return { ok: true }
  })
}

module.exports = {
  bootstrap,
  reload,
  resetBootstrap,
  loginWithWechat,
  sendEmailCode,
  verifyEmailCode,
  signOut,
  createFamily,
  joinFamily,
  isLocal,
  hasLocalData,
  startLocal,
  resumeLocal,
  exitLocal,
  clearLocalData,
  importLocalToCloud,
  isSetup,
  isLoggedIn,
  sessionLabel,
  sessionUid,
  getInviteCode,
  getRole,
  setRole,
  getFamily,
  getPin,
  setPin,
  ensureSheet,
  getSheet,
  todayOverview,
  toggleItem,
  revokeItem,
  adjustPoints,
  approveExtra,
  updateExtraPoints,
  rejectExtra,
  requestDelete,
  cancelDeleteRequest,
  approveDelete,
  rejectDelete,
  deleteItemToday,
  appendItemVoice,
  toggleVoiceLike,
  setVoiceText,
  removeVoice,
  balance,
  earnedTotal,
  spentTotal,
  streak,
  listTaskGroups,
  addGroup,
  updateGroup,
  removeGroup,
  addChild,
  updateChild,
  removeChild,
  addExtraToday,
  listGifts,
  listAllGifts,
  addGift,
  updateGift,
  removeGift,
  listWishes,
  addWish,
  decideWish,
  requestRedeem,
  decideRedeem,
  fulfillRedeem,
  listRedemptions,
  couponStatus,
  useCoupon,
  calendar,
  recentDays,
  itemStats,
  titleOf,
  logs,
  resetAll,
  FULL_BONUS
}
