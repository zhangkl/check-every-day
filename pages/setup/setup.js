const store = require('../../utils/store')

// 分享卡片带来的待加入邀请码：登录跳转过程可能丢参数，先落 storage
const PENDING_JOIN_KEY = 'ced_pending_join'

function validCode(code) {
  return /^[A-Z0-9]{6}$/.test(String(code || '').trim().toUpperCase())
}

Page({
  data: {
    mode: 'create',
    local: false,
    familyName: '',
    childName: '',
    joinCode: '',
    joinRole: 'child',
    joinPin: '',
    createdCode: '',
    submitting: false,
    error: '',
    invited: false
  },

  async onLoad(options) {
    options = options || {}
    this.setData({ local: options.local === '1' })
    // 来自分享卡片：?join=XXXXXX[&role=parent] → 记住并切到「加入家庭」模式
    const urlCode = String(options.join || '').trim().toUpperCase()
    const pending = validCode(urlCode)
      ? urlCode
      : String(wx.getStorageSync(PENDING_JOIN_KEY) || '').trim().toUpperCase()
    const fromShare = validCode(pending)
    if (fromShare) {
      wx.setStorageSync(PENDING_JOIN_KEY, pending)
      this.setData({
        mode: 'join',
        joinCode: pending,
        invited: true,
        joinRole: options.role === 'parent' ? 'parent' : 'child'
      })
    }

    const boot = await store.bootstrap()
    if (boot.ok) {
      // 已在家庭里（比如自己点开自己的分享卡），不用再加入
      if (fromShare) wx.removeStorageSync(PENDING_JOIN_KEY)
      wx.reLaunch({ url: '/pages/today/today' })
      return
    }
    if (boot.needLogin && !(options && options.local === '1')) {
      // 未登录：先去登录，登录后回到本页，pending 码还在 storage 里，会自动加入
      wx.reLaunch({ url: '/pages/login/login' })
      return
    }
    // 已登录、还没加入家庭、且来自分享 → 孩子身份直接自动加入；
    // 家长身份可能要输家长密码，让用户点按钮确认
    if (fromShare && this.data.joinRole === 'child') {
      this.onJoin()
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

  onJoinRole(e) {
    const r = e.currentTarget.dataset.role
    if (r === 'child' || r === 'parent') this.setData({ joinRole: r, error: '' })
  },

  onJoinPin(e) {
    this.setData({ joinPin: e.detail.value, error: '' })
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
    const role = this.data.joinRole === 'parent' ? 'parent' : 'child'
    this.setData({ submitting: true, error: '' })
    const res = await store.joinFamily(code, { role: role, pin: (this.data.joinPin || '').trim() })
    this.setData({ submitting: false })
    if (!res.ok) {
      // needPin：家里设了家长密码，密码框就在当前身份选项下面，填好再点一次
      this.setData({ error: res.error })
      return
    }
    wx.removeStorageSync(PENDING_JOIN_KEY)
    // 身份由加入时选择决定（服务端校验家长密码），重复加入以真实成员身份为准
    getApp().globalData.role = res.role || role
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
