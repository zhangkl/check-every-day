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
  switchRole(role) {
    store.setRole(role)
    this.globalData.role = role
  }
})
