// 分享邀请流程：链接解析 + 加入页行为（不再自动加入，必须自己选身份）
const path = require('path')
const Module = require('module')
const ROOT = path.resolve(__dirname, '..')
const invite = require(path.join(ROOT, 'utils/invite'))

let pass = 0
function ok(v, msg, extra) {
  if (v) {
    pass++
  } else {
    console.error('  ✗ ' + msg + (extra ? '  → ' + extra : ''))
    process.exitCode = 1
  }
}
function eq(a, b, msg) {
  ok(a === b, msg, String(a) + ' !== ' + String(b))
}

// ---------- 1. 纯函数 ----------
ok(invite.validCode('pa9s94'), '邀请码大小写不敏感')
ok(invite.validCode(' A1B2C3 '), '邀请码去空格')
ok(!invite.validCode('A1B2C'), '5 位码无效')
ok(!invite.validCode('A1B2C3D'), '7 位码无效')
ok(!invite.validCode('______'), '特殊字符无效')

const share = invite.buildSharePath('pa9s94', '墨之家')
eq(share, '/pages/setup/setup?join=PA9S94&fn=%E5%A2%A8%E4%B9%8B%E5%AE%B6', '分享 path 带上家庭名并编码')
eq(invite.buildSharePath('PA9S94', ''), '/pages/setup/setup?join=PA9S94', '没有家庭名时 path 干净')
ok(!invite.buildSharePath('PA9S94', '').includes('role='), '分享卡片不预设身份')

const fromUrl = invite.parseInvite({ join: 'pa9s94', fn: '%E5%A2%A8%E4%B9%8B%E5%AE%B6' }, null)
eq(fromUrl.code, 'PA9S94', '解析邀请码')
eq(fromUrl.fn, '墨之家', '解析未解码的家庭名')
ok(fromUrl.fromUrl, '标记为来自分享链接')
eq(fromUrl.role, '', '新分享卡片不预选身份')
eq(invite.parseInvite({ join: 'PA9S94', fn: '墨之家' }, null).fn, '墨之家', '已解码的家庭名也能用')
eq(invite.parseInvite({ join: 'PA9S94', role: 'parent' }, null).role, 'parent', '带 role=parent 的分享可预选家长')
eq(invite.parseInvite({ join: 'PA9S94' }, { code: 'PA9S94', role: 'parent' }).role, '', '新点开分享不继承上次的身份')
eq(invite.parseInvite({}, { code: 'PA9S94', fn: '墨之家', role: 'parent' }).role, 'parent', '登录跳回保留已选身份')
eq(invite.parseInvite({}, { code: 'PA9S94', fn: '墨之家', role: 'child' }).role, 'child', '登录跳回保留孩子身份')
eq(invite.parseInvite({}, 'PA9S94').code, 'PA9S94', '兼容旧版纯字符串 pending')
eq(invite.parseInvite({}, null), null, '没有邀请信息返回 null')
eq(invite.parseInvite({ join: 'BAD' }, null), null, '无效码返回 null')
eq(invite.inviteTitle({ fn: '墨之家' }), '邀请你加入「墨之家」 🎉', '加入页标题带家庭名')
eq(invite.inviteTitle({ fn: '' }), '家人邀请你加入 🎉', '无家庭名时的标题')
eq(invite.safeName('100%ZZ'), '100%ZZ', '非法转义不抛错')

// ---------- 2. 页面行为 ----------
function loadSetup(fakeStore, preset) {
  const storage = Object.assign({}, preset || {})
  const calls = { launch: [], toast: [], modal: [] }
  global.wx = {
    getStorageSync(k) { return storage[k] },
    setStorageSync(k, v) { storage[k] = v },
    removeStorageSync(k) { delete storage[k] },
    reLaunch(o) { calls.launch.push(o.url) },
    showToast(o) { calls.toast.push(o) },
    showModal(o) { calls.modal.push(o) },
    setClipboardData(o) { if (o.success) o.success() }
  }
  global.getApp = () => ({ globalData: {} })
  let cfg = null
  global.Page = (c) => { cfg = c }
  const orig = Module._load
  Module._load = function (request) {
    if (request === '../../utils/store') return fakeStore
    return orig.apply(this, arguments)
  }
  const setupPath = path.join(ROOT, 'pages/setup/setup.js')
  delete require.cache[require.resolve(setupPath)]
  try {
    require(setupPath)
  } finally {
    Module._load = orig
  }
  const page = Object.create(cfg)
  page.data = JSON.parse(JSON.stringify(cfg.data))
  page.setData = function (o) { Object.assign(this.data, o) }
  return { page, storage, calls }
}

function fakeStore(bootResult) {
  const joined = []
  return {
    joined: joined,
    bootstrap: async () => bootResult || { needSetup: true },
    joinFamily: async (code, opts) => {
      joined.push({ code, opts })
      return { ok: true, role: opts.role }
    },
    createFamily: async () => ({ ok: true, inviteCode: 'ABC123' }),
    hasLocalData: () => false,
    resumeLocal: () => ({ ok: true }),
    startLocal: () => ({ ok: true }),
    importLocalToCloud: async () => ({ ok: true })
  }
}

async function run() {
  // ① 点开分享：已登录、未加入家庭 → 只停在加入页，绝不自动加入
  const s1 = fakeStore()
  const a = loadSetup(s1)
  await a.page.onLoad({ join: 'PA9S94', fn: '墨之家' })
  eq(a.page.data.mode, 'join', '分享进入切到加入页')
  ok(a.page.data.invited, '标记为受邀')
  eq(a.page.data.joinCode, 'PA9S94', '邀请码自动填好')
  eq(a.page.data.joinRole, '', '身份未预选')
  eq(a.page.data.inviteTitle, '邀请你加入「墨之家」 🎉', '标题显示家庭名')
  eq(s1.joined.length, 0, '★ 没有自动调用 joinFamily')
  eq(a.calls.launch.length, 0, '★ 没有直接跳进首页')
  eq(a.storage[invite.PENDING_JOIN_KEY].code, 'PA9S94', '邀请信息已落 storage')

  // ② 未选身份就点按钮 → 拦住
  await a.page.onJoin()
  eq(a.page.data.error, '先选一下你是孩子还是家长', '提示先选身份')
  eq(s1.joined.length, 0, '★ 仍未加入家庭')
  eq(a.calls.launch.length, 0, '仍未跳转')

  // ③ 选孩子 → 才真正以孩子身份加入
  a.page.onJoinRole({ currentTarget: { dataset: { role: 'child' } } })
  eq(a.storage[invite.PENDING_JOIN_KEY].role, 'child', '身份选择写回 pending')
  await a.page.onJoin()
  eq(s1.joined.length, 1, '点按钮后调用一次 joinFamily')
  eq(s1.joined[0].code, 'PA9S94', '加入用的是分享里的码')
  eq(s1.joined[0].opts.role, 'child', '按所选的孩子身份加入')
  eq(a.calls.launch[0], '/pages/today/today', '加入成功后进首页')
  eq(a.storage[invite.PENDING_JOIN_KEY], undefined, '加入成功后清掉 pending')

  // ④ 选家长 → 带上家长密码，密码由服务端校验
  const s2 = fakeStore()
  const b = loadSetup(s2)
  await b.page.onLoad({ join: 'PA9S94', fn: '墨之家' })
  b.page.onJoinRole({ currentTarget: { dataset: { role: 'parent' } } })
  b.page.onJoinPin({ detail: { value: '2026' } })
  await b.page.onJoin()
  eq(s2.joined.length, 1, '家长身份加入调用一次')
  eq(s2.joined[0].opts.role, 'parent', '按所选的家长身份加入')
  eq(s2.joined[0].opts.pin, '2026', '家长密码一起提交')

  // ⑤ 家长密码不对：停在加入页、pending 不清，可以改了再点
  const s3 = fakeStore()
  s3.joinFamily = async (code, opts) => {
    s3.joined.push({ code, opts })
    return { ok: false, needPin: true, error: '家里设置了家长密码，以家长身份加入需要先输密码' }
  }
  const c = loadSetup(s3)
  await c.page.onLoad({ join: 'PA9S94' })
  c.page.onJoinRole({ currentTarget: { dataset: { role: 'parent' } } })
  await c.page.onJoin()
  ok(c.page.data.error.indexOf('家长密码') >= 0, '显示家长密码错误')
  eq(c.calls.launch.length, 0, '密码错误不跳转')
  ok(!!c.storage[invite.PENDING_JOIN_KEY], '密码错误保留 pending')

  // ⑥ 未登录：先去登录，邀请信息留着；登录跳回后仍停在加入页、不自动加入
  const s4 = fakeStore({ needLogin: true })
  const d = loadSetup(s4)
  await d.page.onLoad({ join: 'PA9S94', fn: '墨之家' })
  eq(d.calls.launch[0], '/pages/login/login', '未登录先跳登录')
  eq(d.storage[invite.PENDING_JOIN_KEY].fn, '墨之家', '登录前保留家庭名')
  eq(s4.joined.length, 0, '未登录不会自动加入')

  const s5 = fakeStore()
  const e = loadSetup(s5, { [invite.PENDING_JOIN_KEY]: { code: 'PA9S94', fn: '墨之家', role: 'parent' } })
  await e.page.onLoad({})
  eq(e.page.data.mode, 'join', '登录跳回仍是加入页')
  eq(e.page.data.joinRole, 'parent', '恢复之前选的家长身份')
  eq(e.page.data.inviteTitle, '邀请你加入「墨之家」 🎉', '恢复家庭名')
  eq(s5.joined.length, 0, '★ 登录跳回也不会自动加入')

  // ⑦ 已在家庭里点自己的分享卡：直接进首页并清 pending
  const s6 = fakeStore({ ok: true })
  const f = loadSetup(s6, { [invite.PENDING_JOIN_KEY]: 'OLD123' })
  await f.page.onLoad({ join: 'PA9S94' })
  eq(f.calls.launch[0], '/pages/today/today', '已在家庭直接进首页')
  eq(s6.joined.length, 0, '不会重复加入')
  eq(f.storage[invite.PENDING_JOIN_KEY], undefined, '清掉旧的 pending')

  // ⑧ 没有分享、手动输入邀请码：仍默认孩子身份，行为不变
  const s7 = fakeStore()
  const g = loadSetup(s7)
  await g.page.onLoad({})
  eq(g.page.data.mode, 'create', '普通进入是创建页')
  g.page.toJoin()
  eq(g.page.data.joinRole, 'child', '手动加入默认孩子身份')
  g.page.onJoinCode({ detail: { value: 'pa9s94' } })
  await g.page.onJoin()
  eq(s7.joined.length, 1, '手动加入仍可直接点按钮')
  eq(s7.joined[0].opts.role, 'child', '手动加入按默认孩子身份')

  console.log('分享邀请流程：通过 ' + pass + ' 条' + (process.exitCode ? '，有失败' : '，失败 0 条'))
}

run().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
