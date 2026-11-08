const store = require('../../utils/store')

Page({
  data: {
    loading: false,
    error: ''
  },

  async onLoad() {
    const boot = await store.bootstrap()
    if (boot.ok) {
      wx.reLaunch({ url: '/pages/today/today' })
      return
    }
    if (boot.needSetup) {
      wx.reLaunch({ url: '/pages/setup/setup' })
    }
  },

  async onWechat() {
    if (this.data.loading) return
    this.setData({ loading: true, error: '' })
    const res = await store.loginWithWechat()
    if (!res.ok) {
      this.setData({ loading: false, error: res.error })
      return
    }
    await this.afterLogin()
  },

  async afterLogin() {
    const boot = await store.bootstrap()
    this.setData({ loading: false })
    if (boot.ok) {
      wx.reLaunch({ url: '/pages/today/today' })
      return
    }
    if (boot.needSetup) {
      wx.reLaunch({ url: '/pages/setup/setup' })
      return
    }
    this.setData({ error: boot.error || '登录成功，但读取家庭数据失败，请再试一次' })
  },

  goLocal() {
    wx.navigateTo({ url: '/pages/setup/setup?local=1' })
  }
})
