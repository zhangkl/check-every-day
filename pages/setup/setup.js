const store = require('../../utils/store')

Page({
  data: {
    mode: 'create',
    local: false,
    familyName: '',
    childName: '',
    joinCode: '',
    createdCode: '',
    submitting: false,
    error: ''
  },

  async onLoad(options) {
    this.setData({ local: options && options.local === '1' })
    const boot = await store.bootstrap()
    if (boot.ok) {
      wx.reLaunch({ url: '/pages/today/today' })
      return
    }
    if (boot.needLogin && !(options && options.local === '1')) {
      wx.reLaunch({ url: '/pages/login/login' })
    }
  },

  toCreate() {
    this.setData({ mode: 'create', error: '' })
  },

  toJoin() {
    this.setData({ mode: 'join', error: '' })
  },

  onChild(e) {
    this.setData({ childName: e.detail.value, error: '' })
  },

  onFamily(e) {
    this.setData({ familyName: e.detail.value, error: '' })
  },

  onJoinCode(e) {
    this.setData({ joinCode: (e.detail.value || '').toUpperCase(), error: '' })
  },

  async onCreate() {
    if (this.data.submitting) return
    const childName = (this.data.childName || '').trim()
    if (!childName) {
      this.setData({ error: '先写个昵称吧' })
      return
    }
    this.setData({ submitting: true, error: '' })
    const res = await store.createFamily(this.data.familyName, childName)
    this.setData({ submitting: false })
    if (!res.ok) {
      this.setData({ error: res.error })
      return
    }
    getApp().globalData.role = 'parent'
    // 这台手机上有未登录时记的本地数据，问一句要不要带上云端
    if (store.hasLocalData()) {
      const self = this
      wx.showModal({
        title: '发现本机的打卡记录',
        content: '这台手机上有一份没登录时记的数据，要把它带到云端吗？带上后积分和打卡都会保留。',
        confirmText: '带上云端',
        cancelText: '不用',
        success(r) {
          if (r.confirm) {
            store.importLocalToCloud().then(function (imp) {
              if (!imp.ok) {
                wx.showToast({ title: imp.error || '迁移没成功', icon: 'none' })
              } else {
                wx.showToast({ title: '本机数据已带到云端', icon: 'none' })
              }
              self.setData({ createdCode: res.inviteCode })
            })
            return
          }
          self.setData({ createdCode: res.inviteCode })
        }
      })
      return
    }
    this.setData({ createdCode: res.inviteCode })
  },

  async onLocalStart() {
    if (this.data.submitting) return
    // 这台手机上有之前的本地数据（退出未清空），先问要不要直接接着用
    if (store.hasLocalData()) {
      const self = this
      wx.showModal({
        title: '发现之前的数据',
        content: '这台手机上有一份之前本地记录的打卡和积分，直接继续用它吗？选「重新开始」会清掉旧记录。',
        confirmText: '继续用',
        cancelText: '重新开始',
        success(r) {
          if (r.confirm) {
            const res = store.resumeLocal()
            if (!res.ok) {
              self.setData({ error: res.error || '没恢复上' })
              return
            }
            getApp().globalData.role = 'parent'
            wx.reLaunch({ url: '/pages/today/today' })
            return
          }
          self.doStartLocal()
        }
      })
      return
    }
    this.doStartLocal()
  },

  doStartLocal() {
    const childName = (this.data.childName || '').trim()
    if (!childName) {
      this.setData({ error: '先写个昵称吧' })
      return
    }
    const res = store.startLocal(this.data.familyName, childName)
    if (!res.ok) {
      this.setData({ error: res.error || '没建起来，再试一次' })
      return
    }
    getApp().globalData.role = 'parent'
    wx.reLaunch({ url: '/pages/today/today' })
  },

  async onJoin() {
    if (this.data.submitting) return
    const code = (this.data.joinCode || '').trim().toUpperCase()
    if (!code) {
      this.setData({ error: '请输入家里的邀请码' })
      return
    }
    this.setData({ submitting: true, error: '' })
    const res = await store.joinFamily(code)
    this.setData({ submitting: false })
    if (!res.ok) {
      this.setData({ error: res.error })
      return
    }
    getApp().globalData.role = 'child'
    wx.reLaunch({ url: '/pages/today/today' })
  },

  copyCode() {
    if (!this.data.createdCode) return
    wx.setClipboardData({
      data: this.data.createdCode,
      success() {
        wx.showToast({ title: '已复制，发给家人', icon: 'none' })
      }
    })
  },

  enterApp() {
    getApp().globalData.role = 'parent'
    wx.reLaunch({ url: '/pages/today/today' })
  }
})
