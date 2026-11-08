const store = require('../../utils/store')
const guard = require('../../utils/guard')
const voice = require('../../utils/voice')

function lateText() {
  const now = new Date()
  const h = now.getHours()
  if (h < 21) return ''
  const left = 24 - h
  if (left <= 1) return '今天还剩不到 1 小时'
  return '今天还剩 ' + left + ' 小时'
}

Page({
  data: {
    role: 'child',
    ready: false,
    family: { name: '', childName: '' },
    ov: null,
    week: [],
    pending: 0,
    floatId: '',
    floatText: '',
    floatType: 'up',
    celebrate: false,
    lateText: '',
    recordingId: '',
    uploadingId: '',
    playingId: ''
  },

  async onShow() {
    const ok = await guard.ensureReady()
    if (!ok) return
    const role = store.getRole()
    getApp().globalData.role = role
    this.setData({ role })
    this.refresh()
  },

  async onPullDownRefresh() {
    await guard.ensureReady(true)
    this.refresh()
    wx.stopPullDownRefresh()
  },

  refresh() {
    if (!store.isSetup()) return
    const ov = store.todayOverview()
    const role = store.getRole()
    const family = store.getFamily()
    // 主标题只说一件事：离完成还差多少
    let heroTitle
    if (ov.total > 0 && ov.done >= ov.total) {
      heroTitle = '今天全部完成 🎉'
    } else if (role === 'child') {
      heroTitle = '还差 ' + (ov.total - ov.done) + ' 项就完成啦'
    } else {
      heroTitle = family.childName + '完成 ' + ov.done + '/' + ov.total + ' 项'
    }
    const patch = {
      ov,
      role,
      family,
      heroTitle,
      lateText: lateText(),
      ready: true
    }
    if (role === 'parent') {
      patch.week = store.recentDays(7)
      patch.pending = store.listRedemptions().filter(function (r) {
        return r.status === 'pending'
      }).length
    }
    this.setData(patch)
  },

  async onToggle(e) {
    if (this.data.role === 'parent') return
    if (this.busy) return
    const id = e.currentTarget.dataset.id
    const before = this.data.ov.done
    const total = this.data.ov.total
    this.busy = true
    const pending = store.toggleItem(this.data.ov.day, id)
    // 先按本地结果刷新，勾选立刻有反馈；云端存不下会回滚
    this.refresh()
    const res = await pending
    this.busy = false
    if (!res.ok) {
      this.refresh()
      wx.showToast({ title: res.error || '没保存上，再试一次', icon: 'none' })
      return
    }
    if (res.done) {
      wx.vibrateShort({ type: 'light' })
    }
    this.setData({
      floatId: id,
      floatText: (res.change > 0 ? '+' : '') + res.change,
      floatType: res.change > 0 ? 'up' : 'down'
    })
    setTimeout(() => {
      this.setData({ floatId: '', floatText: '' })
    }, 720)
    if (res.done && total > 0 && before === total - 1) {
      this.showCelebrate()
    }
  },

  showCelebrate() {
    this.setData({ celebrate: true })
    wx.vibrateShort({ type: 'heavy' })
    setTimeout(() => {
      this.setData({ celebrate: false })
    }, 2600)
  },

  hideCelebrate() {
    this.setData({ celebrate: false })
  },

  onRevoke(e) {
    const id = e.currentTarget.dataset.id
    const title = e.currentTarget.dataset.title
    wx.showModal({
      title: '撤销「' + title + '」',
      content: '撤销后这一项会回到未完成，对应积分也会扣回。确认吗？',
      confirmText: '撤销',
      confirmColor: '#E4736B',
      success: async (r) => {
        if (!r.confirm) return
        const pending = store.revokeItem(this.data.ov.day, id)
        this.refresh()
        const res = await pending
        if (!res.ok) {
          this.refresh()
          wx.showToast({ title: res.error || '没保存上', icon: 'none' })
          return
        }
        wx.showToast({ title: '已撤销', icon: 'none' })
      }
    })
  },

  goTasks() {
    wx.navigateTo({ url: '/pages/parent-tasks/parent-tasks' })
  },

  goApprove() {
    wx.navigateTo({ url: '/pages/parent-approve/parent-approve' })
  },

  goMe() {
    wx.navigateTo({ url: '/pages/me/me' })
  },

  onAddExtra() {
    wx.showModal({
      title: '临时加一项',
      editable: true,
      placeholderText: '比如 明天带美术材料',
      success: (r) => {
        if (!r.confirm) return
        const title = (r.content || '').trim()
        if (!title) return
        wx.showModal({
          title: '这一项多少分',
          editable: true,
          placeholderText: '默认 5 分',
          success: async (r2) => {
            if (!r2.confirm) return
            const points = Number((r2.content || '').trim()) || 5
            const res = await store.addExtraToday(title, points)
            this.refresh()
            if (!res.ok) {
              wx.showToast({ title: res.error || '没保存上', icon: 'none' })
              return
            }
            wx.showToast({ title: '已加进今天的清单', icon: 'none' })
          }
        })
      }
    })
  },

  onAdjust() {
    wx.showModal({
      title: '手动调整积分',
      editable: true,
      placeholderText: '正数加分，负数扣分，例如 5',
      success: async (r) => {
        if (!r.confirm) return
        const raw = (r.content || '').trim()
        const amount = Number(raw)
        if (!amount) {
          wx.showToast({ title: '请输入一个数字', icon: 'none' })
          return
        }
        const res = await store.adjustPoints(amount, amount > 0 ? '家长额外奖励' : '家长扣分')
        this.refresh()
        if (!res.ok) {
          wx.showToast({ title: res.error || '没保存上', icon: 'none' })
          return
        }
        wx.showToast({ title: '已' + (amount > 0 ? '加' : '扣') + Math.abs(amount) + '分', icon: 'none' })
      }
    })
  },

  /* ---------------- 语音小结 ---------------- */

  // 学生端：点麦克风开始 / 再点一下结束
  onMic(e) {
    if (this.data.role === 'parent') return
    const id = e.currentTarget.dataset.id
    if (this.data.uploadingId) return
    if (this.data.recordingId === id) {
      voice.stopRecord()
      return
    }
    if (this.data.recordingId) {
      wx.showToast({ title: '先结束手上这条录音', icon: 'none' })
      return
    }
    const day = this.data.ov.day
    const self = this
    wx.authorize({
      scope: 'scope.record',
      success() {
        self.beginRecord(day, id)
      },
      fail() {
        wx.showModal({
          title: '需要麦克风权限',
          content: '到设置里打开麦克风，才能留下语音小结',
          confirmText: '去设置',
          success(r) {
            if (r.confirm) wx.openSetting()
          }
        })
      }
    })
  },

  beginRecord(day, id) {
    const self = this
    this.setData({ recordingId: id })
    wx.vibrateShort({ type: 'light' })
    voice.start({
      onStop: async (tmpPath, seconds) => {
        self.setData({ recordingId: '' })
        if (seconds < 1) {
          wx.showToast({ title: '太短了，没录上', icon: 'none' })
          return
        }
        self.setData({ uploadingId: id })
        const res = await voice.uploadAndSave(day, id, tmpPath, seconds)
        self.setData({ uploadingId: '' })
        self.refresh()
        if (!res.ok) {
          wx.showToast({ title: res.error || '没保存上，再试一次', icon: 'none' })
          return
        }
        wx.showToast({ title: '语音小结已保存', icon: 'none' })
      },
      onError: (msg) => {
        self.setData({ recordingId: '' })
        wx.showToast({ title: msg || '录音失败了', icon: 'none' })
      }
    })
  },

  // 学生和家长：播放一段语音小结
  onVoicePlay(e) {
    const id = e.currentTarget.dataset.id
    const path = e.currentTarget.dataset.path
    if (!path) return
    if (this.data.playingId === id) {
      voice.stopPlay()
      this.setData({ playingId: '' })
      return
    }
    const self = this
    voice
      .play(path, function () {
        self.setData({ playingId: '' })
      })
      .then((res) => {
        if (!res.ok) {
          this.setData({ playingId: '' })
          wx.showToast({ title: res.error || '播放失败', icon: 'none' })
          return
        }
        self.setData({ playingId: id })
      })
  }
})
