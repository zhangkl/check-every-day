// 页面统一的入口守卫：确认已登录 + 已加入家庭 + 数据已加载。
const store = require('./store')

const LOGIN = '/pages/login/login'
const SETUP = '/pages/setup/setup'
const STALE_MS = 20000

let lastLoadedAt = 0

function currentRoute() {
  const pages = getCurrentPages()
  if (!pages || !pages.length) return ''
  return '/' + pages[pages.length - 1].route
}

function go(url) {
  if (currentRoute() === url) return false
  wx.reLaunch({ url: url })
  return true
}

async function ensureReady(force) {
  const boot = await store.bootstrap()
  if (boot.needLogin) {
    go(LOGIN)
    return false
  }
  if (boot.needSetup) {
    go(SETUP)
    return false
  }
  if (boot.error && !boot.offline) {
    wx.showToast({ title: boot.error, icon: 'none' })
  }
  const stale = Date.now() - lastLoadedAt > STALE_MS
  if (force || stale) {
    const r = await store.reload()
    if (r.ok) lastLoadedAt = Date.now()
  }
  return true
}

function markLoaded() {
  lastLoadedAt = Date.now()
}

module.exports = { ensureReady, markLoaded }
