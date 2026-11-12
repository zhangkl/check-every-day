// 分享邀请链接的解析与生成：纯函数，不依赖 wx，方便单测与打包
// 分享卡片统一带普通家庭码，进入后停在加入页由对方自己选身份，不再自动加入
const PENDING_JOIN_KEY = 'ced_pending_join'

function validCode(code) {
  return /^[A-Z0-9]{6}$/.test(String(code || '').trim().toUpperCase())
}

// 微信会把 path 里的 query 解码一次；这里兼容已解码 / 未解码两种情况
function safeName(s) {
  let v = String(s || '')
  try {
    if (/%[0-9A-Fa-f]{2}/.test(v)) v = decodeURIComponent(v)
  } catch (e) {
    // 名字里本身带 % 且不是合法转义时，保留原值
  }
  return v.trim().slice(0, 12)
}

// 优先用本次分享链接的参数；登录跳回后参数丢失，用本地暂存的邀请信息补齐
// 返回 null 表示没有有效邀请，页面走正常「创建 / 加入」流程
function parseInvite(options, stored) {
  options = options || {}
  let prev = stored || {}
  if (typeof prev === 'string') prev = { code: prev }
  const urlCode = String(options.join || '').trim().toUpperCase()
  const fromUrl = validCode(urlCode)
  const code = fromUrl ? urlCode : String(prev.code || '').trim().toUpperCase()
  if (!validCode(code)) return null
  let role = ''
  if (fromUrl) {
    // 新点开的分享卡：身份一律重新选，不继承上次的选择
    role = options.role === 'parent' ? 'parent' : ''
  } else if (prev.role === 'parent' || prev.role === 'child') {
    // 登录跳回来：保留点过身份的选择
    role = prev.role
  }
  return {
    code: code,
    fn: safeName(options.fn || prev.fn || ''),
    role: role,
    fromUrl: fromUrl
  }
}

function buildSharePath(code, familyName) {
  let p = '/pages/setup/setup?join=' + encodeURIComponent(String(code || '').trim().toUpperCase())
  const fn = safeName(familyName)
  if (fn) p += '&fn=' + encodeURIComponent(fn)
  return p
}

function inviteTitle(inv) {
  if (!inv) return '输入家里的邀请码'
  return inv.fn ? '邀请你加入「' + inv.fn + '」 🎉' : '家人邀请你加入 🎉'
}

module.exports = {
  PENDING_JOIN_KEY: PENDING_JOIN_KEY,
  validCode: validCode,
  safeName: safeName,
  parseInvite: parseInvite,
  buildSharePath: buildSharePath,
  inviteTitle: inviteTitle
}
