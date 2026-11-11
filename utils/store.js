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
// logs 是积分账本（余额直接从它求和，且会被裁剪），零分动作单独放 activities
const ACTIVITY_KEEP = 400

// 动作名：积分事件由 logs.kind 推导，其它操作由 activities.kind 推导
const ACTION_LABEL = {
  task: '完成打卡',
  untask: '取消打卡',
  revoke: '撤销完成',
  bonus_full: '满勤奖励',
  bonus_streak7: '连满 7 天',
  bonus_streak30: '连满 30 天',
  voice_like: '点赞语音',
  voice_unlike: '取消点赞',
  adjust: '手动调分',
  redeem: '兑换礼物',
  voice_add: '录语音',
  voice_delete: '删语音',
  voice_text: '转文字',
  comment_add: '评论语音',
  comment_delete: '删评论',
  note_add: '发留言',
  note_pin: '设为公告',
  note_unpin: '取消公告',
  note_delete: '删留言',
  extra_add: '临时加项',
  extra_apply: '申请加项',
  extra_ok: '同意加项',
  extra_no: '驳回加项',
  extra_points: '改分值',
  del_apply: '申请删项',
  del_cancel: '撤回删项',
  del_ok: '同意删项',
  del_no: '驳回删项',
  task_delete: '删今日项',
  wish_apply: '许心愿',
  wish_ok: '同意心愿',
  wish_no: '驳回心愿',
  redeem_apply: '申请兑换',
  redeem_no: '驳回兑换',
  redeem_done: '礼物已给',
  coupon_use: '用护身符',
  plan_group_add: '新增大项',
  plan_group_edit: '改大项',
  plan_group_del: '删大项',
  plan_item_add: '新增小项',
  plan_item_edit: '改小项',
  plan_item_del: '删小项',
  gift_add: '新增礼物',
  gift_edit: '改礼物',
  gift_del: '下架礼物',
  family_edit: '改家庭资料',
  profile_edit: '改个人资料',
  pin_edit: '改家长口令'
}

// 老日志把动作写在文字里（「点赞语音 · 英语」）。这两个常量只服务于 normalizeDoc 里的
// 一次性迁移：加载时把 note 洗成纯对象名并随下一次 flush 写回云端；渲染路径不再剥字符串。
const LEGACY_NOTE_PREFIX = /^(取消勾选|家长撤销|点赞语音|取消赞|兑换)\s*·\s*/
const LEGACY_NOTE_ONLY = [
  '全部完成满勤奖',
  '连续 7 天满勤',
  '连续 30 天满勤',
  '家长额外奖励',
  '家长扣分',
  '家长调整'
]

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
    activities: [],
    gifts: [],
    wishes: [],
    redemptions: [],
    coupons: [],
    notices: [],
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
  // 老日志迁移（幂等）：动作名从 note 里剥掉，纯兜底文案清空。
  // 洗完的 doc 会随下一次任意写操作整份写回云端，之后就不再需要中文前缀兼容。
  out.migrations = s.migrations && typeof s.migrations === 'object' ? s.migrations : {}
  out.logs.forEach(function (l) {
    if (!l || typeof l.note !== 'string' || !l.note) return
    const cleaned = l.note.replace(LEGACY_NOTE_PREFIX, '').trim()
    l.note = LEGACY_NOTE_ONLY.indexOf(cleaned) >= 0 ? '' : cleaned
  })
  if (!out.migrations.legacyNotesV2) out.migrations.legacyNotesV2 = true
  // 操作流水（非积分动作）；老文档没有这个字段，补空数组
  out.activities = Array.isArray(s.activities) ? s.activities : []
  out.gifts = Array.isArray(s.gifts) ? s.gifts : []
  out.wishes = Array.isArray(s.wishes) ? s.wishes : []
  out.redemptions = Array.isArray(s.redemptions) ? s.redemptions : []
  out.coupons = Array.isArray(s.coupons) ? s.coupons : []
  // 家庭留言板：[{ id, uid, role, text, at, pinned }]，家长可置顶公告
  out.notes = Array.isArray(s.notes) ? s.notes : []
  // 消息中心：[{ id, kind, text, from, fromName, to, at, readBy, ref }]
  out.notices = Array.isArray(s.notices) ? s.notices : []
  out.maxStreak = Number(s.maxStreak) || 0
  out.seq = Number(s.seq) || 1000
  out.setupDone = true
  out.v = 2
  // 个人资料：{ [uid]: { avatar, at } }，uid 是登录用户标识，本地模式是固定值
  out.profile = s.profile && typeof s.profile === 'object' && !Array.isArray(s.profile) ? s.profile : {}
  // 老数据迁移：item.voice 单条 → item.voices[] 多条（每条补上 id 供点赞定位）
  // 顺带修历史 bug：录音上限 10 分钟，合法秒数最大 600；存出 600″ 以上的只可能是
  // 旧版单位判断把「毫秒」当「秒」存了 → 换算回秒
  function fixVoiceDuration(d) {
    const n = Number(d) || 0
    return n > 600 ? Math.max(1, Math.round(n / 1000)) : n
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
              liked: false,
              comments: []
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
          // 评论：老语音没有就补空数组
          if (!Array.isArray(v.comments)) v.comments = []
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
  if (Array.isArray(s.notices) && s.notices.length > NOTICE_KEEP) {
    s.notices = s.notices.slice(-NOTICE_KEEP)
  }
  if (Array.isArray(s.activities) && s.activities.length > ACTIVITY_KEEP) {
    s.activities = s.activities.slice(-ACTIVITY_KEEP)
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

// 判断是不是登录态失效：过期 JWT 会让请求降级成匿名角色，数据库报 permission denied
function looksAuthError(error) {
  if (!error) return false
  if (error.code === '42501') return true
  if (String(error.kind || '') === 'unauthenticated') return true
  if (Number(error.status || 0) === 401) return true
  const msg = String(error.message || error.error || '')
  return /permission denied|unauthenticated|invalid.{0,10}token|jwt/i.test(msg)
}

// 静默重登：wx.login 是无感的，不需要用户做任何操作
async function reloginSilent() {
  try {
    const r = await loginWithWechat()
    return !!(r && r.ok)
  } catch (e) {
    return false
  }
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
    .select('id, doc, rev, invite_code, parent_invite_code')
    .eq('id', state.familyId)
    .single()
  if (error) throw error
  state.doc = normalizeDoc(data.doc)
  state.rev = Number(data.rev) || 1
  state.inviteCode = data.invite_code || ''
  state.parentInviteCode = data.parent_invite_code || ''
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
  let pending = false // true = fn 已改过内存、只差写云端：续传用，不重跑业务逻辑
  let lastResult = null
  let reloginTried = false // 每次操作最多静默重登一次，避免死循环
  while (attempt < 4) {
    attempt += 1
    const snapshot = clone(state.doc)
    let result
    if (pending) {
      pending = false
      result = lastResult
    } else {
      lastResult = null
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
      // 登录态过期：静默重登后把这次修改直接写上去，用户无感
      if (!reloginTried && looksAuthError(e)) {
        reloginTried = true
        lastResult = result
        const ok = await reloginSilent()
        if (ok) {
          pending = true
          continue
        }
        lastResult = null
      }
      state.doc = snapshot
      saveCache()
      return { ok: false, error: describeError(e) }
    }
  }
  return { ok: false, error: '别的设备刚改过数据，请下拉刷新后再试' }
}

/* ---------------- 家长专属写的统一守卫 ---------------- */
/**
 * 发布前加固：家长操作不再只靠页面藏按钮，数据层统一卡一道。
 *
 * canActAsParent：
 *   - 云端 member_role 明确是 child 时，即使本地把 role 改成 parent 也拒绝
 *     （state.role 只决定「看哪套界面」，不能当授权用，见 doBootstrap 里的本地覆盖）。
 *   - 本地模式 / 老数据 / 离线缓存没有 member 时，回退当前身份，保持兼容。
 *
 * 边界说明：这层是防误触、防绕过 UI，不是安全边界。孩子改本地缓存无法突破的是
 * 云端 RLS 与 ced_join_family RPC；若将来开放多孩子/老师角色，权限要下沉到 RPC。
 */
function canActAsParent() {
  const cloudRole = state.member && state.member.member_role
  if (cloudRole === 'child') return false
  return isParent()
}

function requireParent() {
  return canActAsParent() ? null : { ok: false, error: '这个操作只有家长能做' }
}

// 所有家长专属写操作走这里：拒绝时返回 Promise，调用方 await / .then 都能接住
function mutateParent(fn) {
  const denied = requireParent()
  if (denied) return Promise.resolve(denied)
  return mutate(fn)
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
    let parentCode = genCode()
    while (parentCode === code) parentCode = genCode()
    const inserted = await cloud.database
      .from(FAMILY_TABLE)
      .insert({ invite_code: code, parent_invite_code: parentCode, doc: docNew, rev: 1 })
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
    state.parentInviteCode = parentCode
    state.member = { family_id: familyId, member_role: 'parent' }
    state.role = 'parent'
    writeLocal({ familyId: familyId, role: 'parent' })
    saveCache()
    resetBootstrap()
    return { ok: true, inviteCode: code, familyId: familyId }
  }
  return { ok: false, error: '创建家庭失败：' + describeError(lastError) }
}

// 加入家庭：一套邀请码，身份由加入时选择决定（孩子直接进；
// 家长身份若家里设了家长密码，服务端会核对，防止孩子拿码冒充家长）
async function joinFamily(code, opts) {
  opts = opts || {}
  state.mode = 'cloud'
  const trimmed = String(code || '').trim().toUpperCase()
  if (!/^[A-Z0-9]{6}$/.test(trimmed)) {
    return { ok: false, error: '邀请码是 6 位字母或数字' }
  }
  const out = await cloud.database.rpc('ced_join_family', {
    p_code: trimmed,
    p_role: opts.role === 'parent' ? 'parent' : 'child',
    p_pin: String(opts.pin || '')
  })
  if (out.error) {
    if (/CODE_NOT_FOUND/.test(out.error.message || '')) {
      return { ok: false, error: '没找到这个邀请码，和爸爸妈妈再确认一下' }
    }
    if (/PIN_REQUIRED/.test(out.error.message || '')) {
      return { ok: false, needPin: true, error: '家里设置了家长密码，以家长身份加入需要先输密码' }
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
    // 已是家庭成员（重复加入）时，以真实成员身份为准
    const mine = (await fetchMember()).filter(function (m) {
      return String(m.family_id) === String(familyId)
    })[0]
    if (mine && mine.member_role === 'parent') {
      state.member = mine
      state.role = 'parent'
      writeLocal({ familyId: familyId, role: 'parent' })
    } else if (row.out_role === 'parent') {
      state.member = { family_id: familyId, member_role: 'parent' }
      state.role = 'parent'
      writeLocal({ familyId: familyId, role: 'parent' })
    }
  } catch (e) {
    return { ok: false, error: '加入成功但读取数据失败：' + describeError(e) }
  }
  resetBootstrap()
  return { ok: true, familyId: familyId, familyName: row.out_family_name || '我们家', role: state.role }
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

/* ---------------- 实时同步：轻量轮询 ---------------- */

// 当前内存里的文档与版本号（供页面做差异对比）
function getDoc() {
  return state.doc
}

function getRev() {
  return state.rev
}

// 只拉云端版本号（不拉全量文档），轮询省流量；本地模式返回 skip
async function fetchRemoteRev() {
  if (state.mode !== 'cloud' || !state.familyId || state.familyId === 'local') {
    return { skip: true }
  }
  try {
    const { data, error } = await cloud.database
      .from(FAMILY_TABLE)
      .select('rev')
      .eq('id', state.familyId)
      .single()
    if (error) return { error: error }
    return { rev: Number(data.rev) || 0 }
  } catch (e) {
    return { error: e }
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

// 改家庭名称和孩子昵称（家长端）
function setFamilyInfo(name, childName) {
  if (!isParent()) return { ok: false, error: '只有家长能改家庭信息' }
  const n = String(name || '').trim().slice(0, 12)
  const c = String(childName || '').trim().slice(0, 8)
  if (!n) return { ok: false, error: '先写个家庭名称' }
  if (!c) return { ok: false, error: '先写个孩子昵称' }
  return mutateParent(function (s) {
    if (!s.family || typeof s.family !== 'object') s.family = {}
    s.family.name = n
    s.family.childName = c
    addActivity(s, 'family_edit', n + ' / ' + c)
    return { ok: true, name: n, childName: c }
  })
}

function getPin() {
  return cur().parentPin || ''
}

function getInviteCode() {
  return state.inviteCode || ''
}

function getParentInviteCode() {
  return state.parentInviteCode || ''
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

/* ---------------- 个人资料（头像） ---------------- */

// 基础头像池：5 款；后续积分商城可扩展更炫的款式（对象 { emoji, ring } 等）
const AVATARS = ['🧒', '🦊', '🐼', '🐸', '⭐']

function myUid() {
  return sessionUid() || 'me'
}

// 称呼/头像按「账号+身份」分身存：同一账号切到学生端发言时，
// 显示孩子的名字，不会把家长设置的称呼（如「帅爹」）带过去。
// 键形如 <uid>|p / <uid>|c；旧数据 <uid> 作为家长身份的兼容回退。
function profileKey() {
  return myUid() + '|' + (isParent() ? 'p' : 'c')
}

function getMyAvatar() {
  const doc = cur()
  const prof = doc && doc.profile ? doc.profile : null
  const p = prof ? prof[profileKey()] : null
  const legacy = prof ? prof[myUid()] : null
  return (p && p.avatar) || (legacy && legacy.avatar) || ''
}

function setMyAvatar(emoji) {
  const e = String(emoji || '').trim().slice(0, 16)
  if (!e) return { ok: false, error: '头像不对' }
  const key = profileKey()
  return mutate(function (s) {
    if (!s.profile || typeof s.profile !== 'object') s.profile = {}
    s.profile[key] = Object.assign({}, s.profile[key], { avatar: e, at: Date.now() })
    return { ok: true, avatar: e }
  })
}

// 称呼：每个成员自己设置（爸爸/妈妈/爷爷/奶奶/阿姨/老师…）
function getMyLabel() {
  const doc = cur()
  const prof = doc && doc.profile ? doc.profile : null
  const p = prof ? prof[profileKey()] : null
  const legacy = prof ? prof[myUid()] : null
  return (p && p.label) || (legacy && legacy.label) || ''
}

function setMyLabel(label) {
  const t = String(label || '').trim().slice(0, 6)
  if (!t) return { ok: false, error: '先写个称呼' }
  const key = profileKey()
  return mutate(function (s) {
    if (!s.profile || typeof s.profile !== 'object') s.profile = {}
    s.profile[key] = Object.assign({}, s.profile[key], { label: t, at: Date.now() })
    return { ok: true, label: t }
  })
}

// 某个 uid 某个身份的展示称呼：新键（uid|p / uid|c）优先；
// legacy 键（uid，老版只有家长）回退；还没设置时家长回退「家长」、孩子回退家庭里孩子的昵称
function labelFor(uid, role) {
  const doc = cur()
  const prof = doc && doc.profile ? doc.profile : null
  const key = uid ? uid + '|' + (role === 'parent' ? 'p' : 'c') : ''
  const p = prof && key ? prof[key] : null
  if (p && p.label) return String(p.label)
  const legacy = prof && uid ? prof[uid] : null
  if (legacy && legacy.label && role === 'parent') return String(legacy.label)
  if (role === 'parent') return '家长'
  const fam = doc && doc.family ? doc.family : null
  return (fam && fam.childName) || '孩子'
}

// 谁真的以学生身份活动过：uid -> true。用于识别家长切学生端留下的空壳资料。
// 证据来源按覆盖面排序，任一条命中即认定为真孩子；老数据没有 uid/role 的不参与判断。
function collectChildActors(doc) {
  const out = {}
  function mark(uid, role) {
    if (!uid || role !== 'child') return
    out[String(uid).split('|')[0]] = true
  }
  const d = doc || {}
  ;(Array.isArray(d.logs) ? d.logs : []).forEach(function (l) { mark(l && l.uid, l && l.role) })
  ;(Array.isArray(d.activities) ? d.activities : []).forEach(function (a) { mark(a && a.uid, a && a.role) })
  ;(Array.isArray(d.notes) ? d.notes : []).forEach(function (n) { mark(n && n.uid, n && n.role) })
  ;(Array.isArray(d.notices) ? d.notices : []).forEach(function (n) {
    const from = String((n && n.from) || '')
    if (/\|\s*c$/.test(from)) out[from.slice(0, from.lastIndexOf('|'))] = true
  })
  const sheets = d.sheets && typeof d.sheets === 'object' ? d.sheets : {}
  Object.keys(sheets).forEach(function (k) {
    const items = sheets[k] && Array.isArray(sheets[k].items) ? sheets[k].items : []
    items.forEach(function (it) {
      const voices = Array.isArray(it && it.voices) ? it.voices : []
      voices.forEach(function (v) {
        mark(v && v.uid, v && v.role)
        ;(Array.isArray(v && v.comments) ? v.comments : []).forEach(function (c) {
          mark(c && c.uid, c && c.role)
        })
      })
    })
  })
  return out
}

// 家庭成员列表：从 profile 分身键（uid|p / uid|c）推导谁进来过、用什么身份。
// 一个账号可以同时有家长+学生两个身份（双端切换），各自占一行。
function listMembers() {
  const doc = cur()
  const prof = doc && doc.profile && typeof doc.profile === 'object' ? doc.profile : {}
  // 真正用过学生端的账号。只看 logs 会漏掉「只留言/申请加项/发语音、从不打卡」的孩子，
  // 所以把动作流水、留言、语音与评论、消息来源里带 child 身份的痕迹都算作证据。
  const childActors = collectChildActors(doc)
  const seen = {}
  const out = []
  Object.keys(prof).forEach(function (key) {
    const p = prof[key] || {}
    const bar = String(key).indexOf('|')
    const uid = bar >= 0 ? String(key).slice(0, bar) : String(key)
    const role = bar >= 0 ? (String(key).slice(bar + 1) === 'p' ? 'parent' : 'child') : 'parent'
    // 家长账号临时切到学生端留下的空壳资料：没设称呼、同一 uid 已有具名家长资料、
    // 且从没以学生身份产生过操作。它没名字会回退成孩子昵称，看起来像「第二个孩子」。
    if (role === 'child' && !(p && p.label) && !childActors[uid]) {
      const parentProfile = prof[uid + '|p'] || prof[uid]
      if (parentProfile && parentProfile.label) return
    }
    const tag = uid + '|' + role
    if (seen[tag]) return
    seen[tag] = true
    // legacy 键（无分隔符）的资料回退读取
    const legacy = bar < 0 ? p : null
    out.push({
      tag: tag,
      role: role,
      name: labelFor(uid, role),
      avatar: p.avatar || (legacy && legacy.avatar) || (role === 'parent' ? '👨‍👩‍👧' : '🧒'),
      at: Number(p.at) || (legacy ? Number(legacy.at) || 0 : 0)
    })
  })
  // 老数据连 profile 都没有：至少把家庭里配置的孩子展示出来
  if (!out.length) {
    const fam = doc && doc.family ? doc.family : {}
    out.push({ tag: 'child-fallback', role: 'child', name: fam.childName || '孩子', avatar: '🧒', at: 0 })
  }
  // 家长在前，同身份按最近活跃排
  out.sort(function (a, b) {
    if (a.role !== b.role) return a.role === 'parent' ? -1 : 1
    return b.at - a.at
  })
  return out
}

/* ---------------- 消息中心 ---------------- */
// 一条消息只存一份，按收件人过滤；readBy 按读者分身键记录，多端各自已读互不影响。
// to 取值：'family' 全家 / 'parent' 所有家长端 / 'child' 所有学生端 / 'uid|p'、'uid|c' 精确某人
const NOTICE_KEEP = 100

function keyOf(uid, role) {
  return String(uid || '') + '|' + (role === 'parent' ? 'p' : 'c')
}

function noticeVisible(n, key, role) {
  const to = String((n && n.to) || '')
  if (to === key) return true
  if (n && n.from === key) return false // 自己发起的全家/角色广播不提醒自己
  if (to === 'family') return true
  if (to === 'parent' || to === 'child') return to === role
  return false
}

// 在 mutate 的 fn 内调用：和业务数据一起原子写入，发起者不会收到自己发的消息
function pushNotice(s, kind, text, to, ref) {
  if (!Array.isArray(s.notices)) s.notices = []
  const from = profileKey()
  if (to === from) return
  const legacy = (s.profile && s.profile[myUid()]) || {}
  const mine = (s.profile && s.profile[from]) || legacy
  s.notices.push({
    id: newId(s),
    kind: kind,
    text: String(text || '').slice(0, 80),
    from: from,
    fromName: String((mine && mine.label) || (isParent() ? '家长' : (s.family && s.family.childName) || '孩子')),
    to: to,
    at: Date.now(),
    readBy: {},
    ref: ref || null
  })
  if (s.notices.length > NOTICE_KEEP) s.notices = s.notices.slice(-NOTICE_KEEP)
}

// 语音作者：新数据带 uid/role；老语音没记，退回所有学生端
function voiceTarget(v) {
  return v && v.uid ? keyOf(v.uid, v.role) : 'child'
}

function listNotices(limit) {
  const s = cur()
  const key = profileKey()
  const role = isParent() ? 'parent' : 'child'
  const arr = (Array.isArray(s.notices) ? s.notices : [])
    .filter(function (n) { return noticeVisible(n, key, role) })
    .slice()
    .sort(function (a, b) { return b.at - a.at })
  const picked = typeof limit === 'number' ? arr.slice(0, limit) : arr
  return picked.map(function (n) {
    return {
      id: n.id,
      kind: n.kind,
      text: n.text,
      fromName: n.fromName || '家人',
      at: n.at,
      unread: !(n.readBy && n.readBy[key]),
      ref: n.ref || null
    }
  })
}

function unreadNoticeCount() {
  return listNotices().filter(function (n) { return n.unread }).length
}

function markNoticesRead(ids) {
  if (!unreadNoticeCount()) return Promise.resolve({ ok: true, marked: 0 })
  const key = profileKey()
  const role = isParent() ? 'parent' : 'child'
  const set = ids && ids.length ? ids.map(String) : null
  return mutate(function (s) {
    if (!Array.isArray(s.notices)) s.notices = []
    let marked = 0
    s.notices.forEach(function (n) {
      if (!noticeVisible(n, key, role)) return
      if (set && set.indexOf(String(n.id)) < 0) return
      if (!n.readBy || typeof n.readBy !== 'object') n.readBy = {}
      if (!n.readBy[key]) {
        n.readBy[key] = Date.now()
        marked += 1
      }
    })
    return { ok: true, marked: marked }
  })
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
        taskId: c.id,
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

// 家长改模板（改标题/分值、加/删任务或子项、改出现日期、停用）后，让今天的清单跟着变：
// - 已有项按 taskId 对齐模板，更新标题/分值/分组信息
// - 模板里今天新出现的子项 → 插入清单
// - 模板里今天不再包含、且未打卡的非审批项 → 移除
// - 历史天的快照保持不动，学生申请中的项（pending/del-pending）不参与更新
function syncTodaySheet(s) {
  const day = dateUtil.today()
  const sheet = s.sheets[day]
  if (!sheet) return
  const want = []
  groupsForDay(s, day).forEach(function (entry, gi) {
    entry.children.forEach(function (c, ci) {
      want.push({ taskId: c.id, group: entry.group, child: c, groupSort: gi * 10, sort: ci * 10 })
    })
  })
  const keep = []
  const had = {}
  sheet.items.forEach(function (it) {
    let w = null
    if (it.taskId) {
      w = want.filter(function (x) { return x.taskId === it.taskId })[0]
    } else {
      // 老快照没有 taskId：按组+标题兜底匹配
      w = want.filter(function (x) {
        return x.group.groupKey === it.groupKey && x.child.title === it.title
      })[0]
    }
    if (w) {
      had[w.taskId] = true
      if (it.status !== 'pending') {
        // pending 项的分值由家长审批时单独定，不跟模板走
        it.groupTitle = w.group.title
        it.groupIcon = w.group.icon
        it.groupSort = w.groupSort
        it.title = w.child.title
        it.points = w.child.points
        it.sort = w.sort
        it.taskId = w.taskId
      }
      keep.push(it)
      return
    }
    // 模板里今天已经没有这一项：未打卡且不在审批中的移除，其余保留
    if (it.done || it.status === 'pending' || it.status === 'del-pending') {
      keep.push(it)
    }
  })
  want.forEach(function (w) {
    if (had[w.taskId]) return
    keep.push({
      id: newId(s),
      taskId: w.taskId,
      groupKey: w.group.groupKey,
      groupTitle: w.group.title,
      groupIcon: w.group.icon,
      groupSort: w.groupSort,
      title: w.child.title,
      points: w.child.points,
      sort: w.sort,
      done: false,
      doneAt: null,
      revokedAt: null,
      status: 'approved'
    })
  })
  keep.sort(function (a, b) {
    return (a.groupSort - b.groupSort) || (a.sort - b.sort)
  })
  sheet.items = keep
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

// 同一毫秒可能连写多条（打卡顺带满勤奖、快速连点），保证时间严格递增，流水顺序才稳定
function stamp(s) {
  const logs = Array.isArray(s.logs) ? s.logs : []
  const acts = Array.isArray(s.activities) ? s.activities : []
  const a = logs.length ? Number(logs[logs.length - 1].at) || 0 : 0
  const b = acts.length ? Number(acts[acts.length - 1].at) || 0 : 0
  return Math.max(Date.now(), a + 1, b + 1)
}

function addLog(s, kind, amount, day, note, refId) {
  s.logs.push({
    id: newId(s),
    kind: kind,
    amount: amount,
    day: day,
    note: note || '',
    refId: refId || null,
    // 谁操作的：流水展示用；老日志没有这两个字段，展示时显示「早期记录」
    uid: sessionUid() || 'me',
    role: isParent() ? 'parent' : 'child',
    at: stamp(s)
  })
}

// 记一条「非积分」操作：不动 logs（积分账本），只进独立的操作流水
function addActivity(s, kind, detail, day) {
  if (!Array.isArray(s.activities)) s.activities = []
  s.activities.push({
    id: newId(s),
    kind: kind,
    detail: String(detail == null ? '' : detail).slice(0, 60),
    day: day || dateUtil.today(),
    uid: sessionUid() || 'me',
    role: isParent() ? 'parent' : 'child',
    at: stamp(s)
  })
  if (s.activities.length > ACTIVITY_KEEP) {
    s.activities = s.activities.slice(-ACTIVITY_KEEP)
  }
}

function hasLog(s, kind, day) {
  return s.logs.some(function (l) {
    return l.kind === kind && l.day === day
  })
}

// 动作列：老日志和新日志共用；手动调分按金额区分加/扣
function logAction(l) {
  if (l && l.kind === 'adjust') return (Number(l.amount) || 0) >= 0 ? '手动加分' : '手动扣分'
  return ACTION_LABEL[(l && l.kind) || ''] || '积分变动'
}

// 详情列：老日志已在 normalizeDoc 里洗过，这里只做展示层兜底
function logDetail(l) {
  return String((l && l.note) || '').trim()
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
    addLog(s, 'bonus_full', FULL_BONUS, day, '', null)
  }
  if (!allDone && hasLog(s, 'bonus_full', day)) {
    s.logs = s.logs.filter(function (l) {
      return !(l.kind === 'bonus_full' && l.day === day)
    })
  }
  const cur0 = streak()
  if (cur0 >= 7 && !hasLog(s, 'bonus_streak7', day)) {
    addLog(s, 'bonus_streak7', STREAK_7_BONUS, day, '', null)
  }
  if (cur0 >= 30 && !hasLog(s, 'bonus_streak30', day)) {
    addLog(s, 'bonus_streak30', STREAK_30_BONUS, day, '', null)
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
      addLog(s, 'untask', -item.points, day, item.title, item.id)
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
  return mutateParent(function (s) {
    const sheet = s.sheets[day]
    if (!sheet) return { ok: false, error: '这一天没有清单' }
    const item = sheet.items.filter(function (it) {
      return it.id === itemId
    })[0]
    if (!item || !item.done) return { ok: false, error: '这一项已经是未完成' }
    item.done = false
    item.doneAt = null
    item.revokedAt = Date.now()
    addLog(s, 'revoke', -item.points, day, item.title, item.id)
    pushNotice(s, 'revoke', '撤销了「' + item.title + '」的完成', 'child', { type: 'task', day: day })
    settleDay(s, day)
    return { ok: true }
  })
}

// 家长手动调分：note 是一句简短原因，同时写进积分流水和给孩子的消息
function adjustPoints(amount, reason) {
  const n = Number(amount) || 0
  const note = String(reason == null ? '' : reason)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 12)
  const label = note || (n > 0 ? '家长额外奖励' : '家长扣分')
  const day = dateUtil.today()
  return mutateParent(function (s) {
    addLog(s, 'adjust', n, day, label, null)
    pushNotice(
      s,
      'adjust',
      '给你' + (n >= 0 ? '加了 ' + n : '减了 ' + Math.abs(n)) + ' 分（' + label + '）',
      'child',
      { type: 'task', day: day }
    )
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
      uid: sessionUid() || 'me',
      role: isParent() ? 'parent' : 'child',
      path: voice.path,
      duration: Number(voice.duration) || 0,
      at: Number(voice.at) || Date.now(),
      text: typeof voice.text === 'string' ? voice.text.slice(0, 8000) : '',
      likes: 0,
      liked: false,
      comments: []
    }
    item.voices.push(v)
    addActivity(s, 'voice_add', item.title, day)
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
      addLog(s, 'voice_unlike', -1, day, item.title, v.id)
      return { ok: true, liked: false, likes: 0 }
    }
    v.liked = true
    v.likes = 1
    addLog(s, 'voice_like', 1, day, item.title, v.id)
    pushNotice(s, 'like', '给你的「' + item.title + '」语音点了个赞 👍', voiceTarget(v), { type: 'voice', day: day, itemId: itemId, voiceId: voiceId })
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
    v.text = typeof text === 'string' ? text.slice(0, 8000) : ''
    return { ok: true }
  })
}

// 给语音加评论：双端可用，家长/孩子都能评；评论存 { id, uid, role, text, at }
function addVoiceComment(day, itemId, voiceId, text) {
  const t = String(text || '').trim().slice(0, 200)
  if (!t) return Promise.resolve({ ok: false, error: '想说什么就写下来吧' })
  const uid = sessionUid() || 'me'
  const role = getRole() === 'parent' ? 'parent' : 'child'
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
    if (!Array.isArray(v.comments)) v.comments = []
    const c = { id: newId(s), uid: uid, role: role, text: t, at: Date.now() }
    v.comments.push(c)
    addActivity(s, 'comment_add', item.title, day)
    pushNotice(s, 'comment', '评论了你的「' + item.title + '」语音：' + t, voiceTarget(v), { type: 'voice', day: day, itemId: itemId, voiceId: voiceId })
    return { ok: true, commentId: c.id, count: v.comments.length }
  })
}

// 删语音评论：家长可删任何人的；孩子只能删自己发的
function removeVoiceComment(day, itemId, voiceId, commentId) {
  const myUid = sessionUid() || 'me'
  const parent = getRole() === 'parent'
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
    if (!Array.isArray(v.comments)) return { ok: false, error: '找不到这条评论' }
    let idx = -1
    v.comments.forEach(function (c, i) {
      if (c.id === commentId) idx = i
    })
    if (idx < 0) return { ok: false, error: '找不到这条评论' }
    if (!parent && v.comments[idx].uid !== myUid) {
      return { ok: false, error: '只能删自己发的评论' }
    }
    const removed = v.comments[idx]
    v.comments.splice(idx, 1)
    addActivity(s, 'comment_delete', item.title, day)
    if (removed && removed.uid && keyOf(removed.uid, removed.role) !== profileKey()) {
      pushNotice(s, 'comment_delete', '删掉了你在「' + item.title + '」下的一条评论', keyOf(removed.uid, removed.role), { type: 'voice', day: day, itemId: itemId, voiceId: voiceId })
    }
    return { ok: true, count: v.comments.length }
  })
}

/* ---------------- 家庭留言板 ---------------- */

const NOTE_KEEP = 30 // 非置顶留言最多保留条数（旧的自动淘汰）

function noteUid() {
  return sessionUid() || 'me'
}

function isParent() {
  return getRole() === 'parent'
}

// 发一条留言：双端可发；家长消息可再置顶为公告
function addNote(text) {
  const t = String(text || '').trim().slice(0, 50)
  if (!t) return Promise.resolve({ ok: false, error: '想说什么就写下来吧' })
  const uid = noteUid()
  const role = isParent() ? 'parent' : 'child'
  return mutate(function (s) {
    if (!Array.isArray(s.notes)) s.notes = []
    const n = { id: newId(s), uid: uid, role: role, text: t, at: Date.now(), pinned: false }
    s.notes.push(n)
    // 淘汰旧的普通留言（置顶的公告不淘汰），保留最近 NOTE_KEEP 条
    const keep = []
    s.notes.forEach(function (x) {
      if (x.pinned || s.notes.indexOf(x) >= s.notes.length - NOTE_KEEP) keep.push(x)
    })
    if (keep.length !== s.notes.length) s.notes = keep
    addActivity(s, 'note_add', t)
    pushNotice(s, 'note', '在留言板说：' + t, 'family', { type: 'note' })
    return { ok: true, noteId: n.id }
  })
}

// 家长置顶/取消一条公告（开关式，同时只有一条置顶）
function pinNote(noteId) {
  if (!isParent()) return Promise.resolve({ ok: false, error: '只有家长能置顶' })
  return mutateParent(function (s) {
    if (!Array.isArray(s.notes)) return { ok: false, error: '没有留言' }
    const n = s.notes.filter(function (x) {
      return x.id === noteId
    })[0]
    if (!n) return { ok: false, error: '找不到这条留言' }
    const target = !n.pinned
    s.notes.forEach(function (x) {
      if (target || x.id === noteId) x.pinned = false
    })
    if (target) {
      n.pinned = true
      if (n.uid) pushNotice(s, 'note_pin', '把你的留言设成了公告 📢', keyOf(n.uid, n.role), { type: 'note' })
    }
    addActivity(s, target ? 'note_pin' : 'note_unpin', n.text)
    return { ok: true, pinned: n.pinned }
  })
}

// 删留言：家长可删任何人的；孩子只能删自己发的
function removeNote(noteId) {
  const uid = noteUid()
  const parent = isParent()
  return mutate(function (s) {
    if (!Array.isArray(s.notes)) return { ok: false, error: '没有留言' }
    const n = s.notes.filter(function (x) {
      return x.id === noteId
    })[0]
    if (!n) return { ok: false, error: '找不到这条留言' }
    if (!parent && n.uid !== uid) {
      return { ok: false, error: '只能删除自己发的留言' }
    }
    s.notes = s.notes.filter(function (x) {
      return x.id !== noteId
    })
    if (n.uid && keyOf(n.uid, n.role) !== profileKey()) {
      pushNotice(s, 'note_delete', '删掉了你的一条留言', keyOf(n.uid, n.role), { type: 'note' })
    }
    addActivity(s, 'note_delete', n.text)
    return { ok: true }
  })
}

// 留言视图：置顶在前，其余按时间倒序
function listNotes() {
  const s = cur()
  const notes = Array.isArray(s.notes) ? s.notes.slice() : []
  notes.sort(function (a, b) {
    if (!!b.pinned !== !!a.pinned) return b.pinned ? 1 : -1
    return b.at - a.at
  })
  return notes
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
    addActivity(s, 'voice_delete', item.title, day)
    return { ok: true, path: v.path || '' }
  })
}

function setPin(pin) {
  return mutateParent(function (s) {
    s.parentPin = pin || ''
    addActivity(s, 'pin_edit', '')
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
  return mutateParent(function (s) {
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
    syncTodaySheet(s)
    addActivity(s, 'plan_group_add', title)
    return { ok: true, groupKey: groupKey }
  })
}

function updateGroup(groupKey, patch) {
  return mutateParent(function (s) {
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
    syncTodaySheet(s)
    addActivity(s, 'plan_group_edit', patch.title || '')
    return { ok: true }
  })
}

function removeGroup(groupKey) {
  return mutateParent(function (s) {
    const g = s.tasks.filter(function (t) {
      return t.level === 1 && t.groupKey === groupKey
    })[0]
    s.tasks = s.tasks.filter(function (t) {
      return t.groupKey !== groupKey
    })
    syncTodaySheet(s)
    addActivity(s, 'plan_group_del', g ? g.title : '')
    return { ok: true }
  })
}

function addChild(groupKey, title, points) {
  return mutateParent(function (s) {
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
    syncTodaySheet(s)
    addActivity(s, 'plan_item_add', title)
    return { ok: true }
  })
}

function updateChild(id, patch) {
  return mutateParent(function (s) {
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
    syncTodaySheet(s)
    addActivity(s, 'plan_item_edit', patch.title || '')
    return { ok: true }
  })
}

function removeChild(id) {
  return mutateParent(function (s) {
    const c = s.tasks.filter(function (t) {
      return t.id === id
    })[0]
    s.tasks = s.tasks.filter(function (t) {
      return t.id !== id
    })
    syncTodaySheet(s)
    addActivity(s, 'plan_item_del', c ? c.title : '')
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
    addActivity(s, byChild ? 'extra_apply' : 'extra_add', title, day)
    if (byChild) {
      pushNotice(s, 'extra_apply', '申请加一项：' + title + '（等你同意）', 'parent', { type: 'task', day: day })
    }
    return { ok: true, taskId: taskId }
  })
}

// 家长同意学生发起的临时项：之后孩子可以正常打卡得分
function approveExtra(day, itemId) {
  return mutateParent(function (s) {
    const sheet = s.sheets[day]
    if (!sheet) return { ok: false, error: '这一天没有清单' }
    const item = sheet.items.filter(function (it) {
      return it.id === itemId
    })[0]
    if (!item) return { ok: false, error: '找不到这一项' }
    if (item.status !== 'pending') return { ok: false, error: '这一项不需要同意' }
    item.status = 'approved'
    addActivity(s, 'extra_ok', item.title, day)
    pushNotice(s, 'extra_ok', '你申请的「' + item.title + '」通过啦 ✅', 'child', { type: 'task', day: day })
    return { ok: true, points: item.points, title: item.title }
  })
}

// 家长改待同意临时项的分值（清单和模板任务同步）
function updateExtraPoints(day, itemId, points) {
  return mutateParent(function (s) {
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
    addActivity(s, 'extra_points', item.title + ' → ' + item.points + ' 分', day)
    pushNotice(s, 'extra_points', '把「' + item.title + '」的分值改成了 ' + item.points + ' 分', 'child', { type: 'task', day: day })
    return { ok: true, points: item.points }
  })
}

// 家长拒绝学生发起的临时项：从今天清单和模板里都去掉
function rejectExtra(day, itemId) {
  return mutateParent(function (s) {
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
    addActivity(s, 'extra_no', item.title, day)
    pushNotice(s, 'extra_no', '你申请的「' + item.title + '」这次没通过', 'child', { type: 'task', day: day })
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
    addActivity(s, 'del_apply', item.title, day)
    pushNotice(s, 'del_apply', '申请删除「' + item.title + '」（等你处理）', 'parent', { type: 'task', day: day })
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
    addActivity(s, 'del_cancel', f.item.title, day)
    return { ok: true }
  })
}

// 家长同意删除：只从今天清单移除，模板不动（明天照常出现）
function approveDelete(day, itemId) {
  return mutateParent(function (s) {
    const f = findSheetItem(s, day, itemId)
    if (f.error) return f.error
    const item = f.item
    if (item.status !== 'del-pending') return { ok: false, error: '这一项没有待处理的删除申请' }
    if (item.done) return { ok: false, error: '这一项已完成，请先撤销再删除' }
    f.sheet.items = f.sheet.items.filter(function (it) {
      return it.id !== itemId
    })
    addActivity(s, 'del_ok', item.title, day)
    pushNotice(s, 'del_ok', '你申请删除的「' + item.title + '」已同意', 'child', { type: 'task', day: day })
    return { ok: true, title: item.title }
  })
}

// 家长拒绝删除申请：恢复正常打卡
function rejectDelete(day, itemId) {
  return mutateParent(function (s) {
    const f = findSheetItem(s, day, itemId)
    if (f.error) return f.error
    if (f.item.status !== 'del-pending') return { ok: false, error: '这一项没有待处理的删除申请' }
    f.item.status = 'approved'
    addActivity(s, 'del_no', f.item.title, day)
    pushNotice(s, 'del_no', '你申请删除的「' + f.item.title + '」这次没通过', 'child', { type: 'task', day: day })
    return { ok: true, title: f.item.title }
  })
}

// 家长直接删除今天的某一项（未完成、非待同意加项）
function deleteItemToday(day, itemId) {
  return mutateParent(function (s) {
    const f = findSheetItem(s, day, itemId)
    if (f.error) return f.error
    const item = f.item
    if (item.status === 'pending') return { ok: false, error: '待同意的加项请用「不同意」处理' }
    if (item.done) return { ok: false, error: '这一项已完成，请先撤销再删除' }
    f.sheet.items = f.sheet.items.filter(function (it) {
      return it.id !== itemId
    })
    addActivity(s, 'task_delete', item.title, day)
    pushNotice(s, 'task_delete', '把今天的「' + item.title + '」删掉了', 'child', { type: 'task', day: day })
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
  return mutateParent(function (s) {
    s.gifts.push({
      id: newId(s),
      icon: icon || '🎁',
      name: name,
      cost: Number(cost) || 0,
      active: true,
      fromWish: !!fromWish,
      sort: s.gifts.length * 10
    })
    addActivity(s, 'gift_add', name)
    return { ok: true }
  })
}

function updateGift(id, patch) {
  return mutateParent(function (s) {
    s.gifts.forEach(function (g) {
      if (g.id === id) {
        if (patch.name !== undefined) g.name = patch.name
        if (patch.icon !== undefined) g.icon = patch.icon
        if (patch.cost !== undefined) g.cost = Number(patch.cost) || 0
        if (patch.active !== undefined) g.active = patch.active
      }
    })
    addActivity(s, 'gift_edit', patch.name || '')
    return { ok: true }
  })
}

function removeGift(id) {
  return mutateParent(function (s) {
    const g = s.gifts.filter(function (x) {
      return x.id === id
    })[0]
    s.gifts = s.gifts.filter(function (g) {
      return g.id !== id
    })
    addActivity(s, 'gift_del', g ? g.name : '')
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
    addActivity(s, 'wish_apply', name)
    pushNotice(s, 'wish_apply', '许了个心愿：' + name + '（等你看看）', 'parent', { type: 'wish' })
    return { ok: true }
  })
}

function decideWish(id, approve) {
  return mutateParent(function (s) {
    const w = s.wishes.filter(function (x) {
      return x.id === id
    })[0]
    if (!w || w.status !== 'pending') return { ok: false, error: '这个心愿已经处理过了' }
    w.status = approve ? 'approved' : 'rejected'
    w.decidedAt = Date.now()
    addActivity(s, approve ? 'wish_ok' : 'wish_no', w.title)
    pushNotice(s, approve ? 'wish_ok' : 'wish_no', '你的心愿「' + w.title + '」' + (approve ? '同意啦 ✅' : '这次没通过'), 'child', { type: 'wish' })
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
    addActivity(s, 'redeem_apply', gift.name + '（' + gift.cost + ' 分）')
    pushNotice(s, 'redeem_apply', '想兑换「' + gift.name + '」（' + gift.cost + ' 分，等你同意）', 'parent', { type: 'redeem' })
    return { ok: true }
  })
}

function decideRedeem(id, approve) {
  return mutateParent(function (s) {
    const r = s.redemptions.filter(function (item) {
      return item.id === id
    })[0]
    if (!r || r.status !== 'pending') return { ok: false, error: '这件申请已经处理过了' }
    if (approve) {
      if (balance() < r.cost) return { ok: false, error: '积分已经不够了' }
      r.status = 'approved'
      r.decidedAt = Date.now()
      addLog(s, 'redeem', -r.cost, dateUtil.today(), r.giftName, r.id)
    } else {
      r.status = 'rejected'
      r.decidedAt = Date.now()
      addActivity(s, 'redeem_no', r.giftName)
    }
    pushNotice(s, approve ? 'redeem_ok' : 'redeem_no', '你兑换的「' + r.giftName + '」' + (approve ? '通过啦 🎁' : '这次没通过'), 'child', { type: 'redeem' })
    return { ok: true }
  })
}

function fulfillRedeem(id) {
  return mutateParent(function (s) {
    let done = null
    s.redemptions.forEach(function (r) {
      if (r.id === id) {
        r.status = 'fulfilled'
        done = r
      }
    })
    if (done) {
      addActivity(s, 'redeem_done', done.giftName)
      pushNotice(s, 'redeem_done', '「' + done.giftName + '」已经给你啦 🎉', 'child', { type: 'redeem' })
    }
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
    addActivity(s, 'coupon_use', day, day)
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

// 操作流水：积分变动（logs）+ 非积分动作（activities）合并成一条时间线。
// 统一成 { action, detail, amount, hasAmount, who..., at }，页面只管渲染。
function listActivity(limit) {
  const s = cur()
  const fromLogs = (s.logs || []).map(function (l) {
    return {
      id: l.id,
      kind: l.kind,
      action: logAction(l),
      detail: logDetail(l),
      day: l.day || '',
      uid: l.uid || '',
      role: l.role || '',
      amount: Number(l.amount) || 0,
      hasAmount: true,
      at: Number(l.at) || 0
    }
  })
  const fromActs = (Array.isArray(s.activities) ? s.activities : []).map(function (a) {
    return {
      id: a.id,
      kind: a.kind,
      action: ACTION_LABEL[a.kind] || '操作',
      detail: a.detail || '',
      day: a.day || '',
      uid: a.uid || '',
      role: a.role || '',
      amount: 0,
      hasAmount: false,
      at: Number(a.at) || 0
    }
  })
  const all = fromLogs.concat(fromActs).sort(function (a, b) {
    if (b.at !== a.at) return b.at - a.at
    return seqOf(b.id) - seqOf(a.id)
  })
  return limit ? all.slice(0, limit) : all
}

function seqOf(id) {
  const n = Number(String(id || '').replace(/^x/, ''))
  return isNaN(n) ? 0 : n
}

/* ---------------- 动态页统一查询 ---------------- */
// 消息（定向投递）和操作流水（全家全量）本来就在同一份文档里，这里一次读取、
// 统一成带 source 的条目，由页面按 tab 分流。两端可见范围完全一致：
// 流水不按角色过滤；消息仍按各自收件人过滤（消息本身就是定向的）。
// 不做跨源混排：同一次操作既写 notice 又写 activity 时，两个 tab 各显示一行，
// 不会在同一列表里重复出现。
function feed(limit) {
  const n = typeof limit === 'number' && limit > 0 ? limit : 200
  const notices = listNotices(NOTICE_KEEP).map(function (x) {
    return {
      id: x.id,
      source: 'notice',
      kind: x.kind,
      text: x.text,
      fromName: x.fromName,
      unread: x.unread,
      at: x.at,
      ref: x.ref || null
    }
  })
  const activities = listActivity(n).map(function (a) {
    return {
      id: a.id,
      source: 'activity',
      kind: a.kind,
      action: a.action,
      detail: a.detail,
      day: a.day,
      uid: a.uid,
      role: a.role,
      amount: a.amount,
      hasAmount: a.hasAmount,
      at: a.at
    }
  })
  return { notices: notices, activities: activities }
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
  return mutateParent(function (s) {
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
  getDoc,
  getRev,
  fetchRemoteRev,
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
  getMyAvatar,
  setMyAvatar,
  getMyLabel,
  setMyLabel,
  labelFor,
  listMembers,
  listNotices,
  unreadNoticeCount,
  markNoticesRead,
  addVoiceComment,
  removeVoiceComment,
  addNote,
  pinNote,
  removeNote,
  listNotes,
  AVATARS,
  getInviteCode,
  getParentInviteCode,
  getRole,
  setRole,
  getFamily,
  setFamilyInfo,
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
  listActivity,
  feed,
  resetAll,
  FULL_BONUS
}
