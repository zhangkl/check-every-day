const store = require('./utils/store')

App({
  globalData: {
    appName: 'PDCA 好习惯',
    role: 'child'
  },

  onLaunch() {
    this.authReady = store.bootstrap()
  },

  // 切换身份后，各 tab 页在 onShow 里会重新读取并刷新自定义 tabBar
  // verified 由「我的」页在家长密码校验通过后传入
  switchRole(role, verified) {
    store.setRole(role, verified)
    this.globalData.role = role
  }
})
