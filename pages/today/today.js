const store = require('../../utils/store')
const guard = require('../../utils/guard')
const voice = require('../../utils/voice')
const asr = require('../../utils/asr')

function lateText() {
  const now = new Date()
  const h = now.getHours()
  if (h < 21) return ''
  const left = 24 - h
  if (left <= 1) return '今天还剩不到 1 小时'
  return '今天还剩 ' + left + ' 小时'
}

// 按句号/问号/叹号逐句换行
function splitSentences(t) {
  return t
    .replace(/([。！？!?])/g, '$1\n')
    .split('\n')
    .map(function (s) { return s.trim() })
    .filter(Boolean)
    .join('\n')
}

// 排版：老数据带 [m:ss.mmm,m:ss.mmm] 分段时间戳 → 按语义段分段（去掉标记，段间空行，段内逐句换行）；
// 新数据是连续纯文本 → 逐句换行
function formatVoiceText(text) {
  let t = String(text || '').replace(/\s+/g, ' ').trim()
  if (!t) return ''
  const hasTs =
    /\[\d{1,2}:\d{1,2}(?::\d{1,2})?(?:\.\d+)?\s*,\s*\d{1,2}:\d{1,2}(?::\d{1,2})?(?:\.\d+)?\]/.test(t)
  if (!hasTs) return splitSentences(t)
  return t
    .split(/\[[^\]]*\]\s*/)
    .map(function (s) { return s.trim() })
    .filter(Boolean)
    .map(splitSentences)
    .join('\n\n')
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
    playingId: '',
    likePopId: '',
    transcribingId: '',
    confirm: null,
    childForm: null,
    textViewer: null
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

  findItem(id) {
    return (this.data.ov.groups || [])
      .reduce((all, g) => all.concat(g.items), [])
      .filter((it) => it.id === id)[0]
  },

  async onToggle(e) {
    const id = e.currentTarget.dataset.id
    const item = this.findItem(id)
    // 家长点待同意临时项的勾 = 同意；点待删除项的勾 = 同意删除
    if (this.data.role === 'parent') {
      if (!item) return
      if (item.status === 'pending') {
        if (this.busy) return
        this.busy = true
        const res = await store.approveExtra(this.data.ov.day, id)
        this.busy = false
        this.refresh()
        if (!res.ok) {
          wx.showToast({ title: res.error || '没保存上', icon: 'none' })
          return
        }
        wx.vibrateShort({ type: 'light' })
        wx.showToast({ title: '已同意，做完得 ' + res.points + ' 分', icon: 'none' })
        return
      }
      if (item.status === 'del-pending') {
        this._confirmAction = { type: 'del-approve', id: id, title: item.title }
        this.setData({
          confirm: {
            title: '同意删除「' + item.title + '」？',
            content: '这一项会从今天的清单里去掉（只影响今天，明天照常出现）。',
            confirmText: '同意删除'
          }
        })
      }
      return
    }
    if (item && item.status === 'pending') {
      wx.showToast({ title: '这一项要等家长同意', icon: 'none' })
      return
    }
    if (item && item.status === 'del-pending') {
      wx.showToast({ title: '已申请删除，等家长处理；长按可取消', icon: 'none' })
      return
    }
    if (this.busy) return
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

  // 家长长按：待同意项 → 改分值/拒绝；待删除项 → 拒绝申请；已完成项 → 撤销；未完成项 → 删除
  // 学生长按：未完成项 → 申请删除；待删除项 → 取消申请
  onLongPress(e) {
    if (this.busy) return
    const { id, title } = e.currentTarget.dataset
    const item = this.findItem(id)
    if (!item) return
    const name = title || item.title

    if (this.data.role === 'parent') {
      if (item.status === 'pending') {
        this.pendingExtra(id, name, item.points)
        return
      }
      if (item.status === 'del-pending') {
        this._confirmAction = { type: 'del-reject', id: id, title: name }
        this.setData({
          confirm: {
            title: '不同意删除「' + name + '」',
            content: '孩子申请删除这一项。不同意的话，这一项保留，孩子照常打卡。',
            confirmText: '不同意删除'
          }
        })
        return
      }
      if (item.done) {
        this._confirmAction = { type: 'revoke', id: id, title: name }
        this.setData({
          confirm: {
            title: '撤销「' + name + '」',
            content: '撤销后这一项会回到未完成，对应积分也会扣回。确认吗？',
            confirmText: '撤销'
          }
        })
        return
      }
      // 未完成项：家长直接从今天删除
      this._confirmAction = { type: 'del-direct', id: id, title: name }
      this.setData({
        confirm: {
          title: '从今天删除「' + name + '」',
          content: '只影响今天这一天的清单，明天这一项照常出现。',
          confirmText: '删除'
        }
      })
      return
    }

    // 学生
    if (item.status === 'pending') {
      wx.showToast({ title: '这一项还在等家长同意', icon: 'none' })
      return
    }
    if (item.status === 'del-pending') {
      this._confirmAction = { type: 'req-cancel', id: id, title: name }
      this.setData({
        confirm: {
          title: '不想删「' + name + '」了？',
          content: '取消后这一项恢复正常，可以照常打卡。',
          confirmText: '取消申请'
        }
      })
      return
    }
    if (item.done) return
    this._confirmAction = { type: 'req-del', id: id, title: name }
    this.setData({
      confirm: {
        title: '申请删除「' + name + '」？',
        content: '家长同意后，这一项才会从今天的清单里去掉。',
        confirmText: '申请删除'
      }
    })
  },

  // 家长处理学生发起的临时项
  pendingExtra(id, title, points) {
    const self = this
    wx.showActionSheet({
      itemList: ['改分值（现在 ' + points + ' 分）', '不同意这项'],
      success(r) {
        if (r.tapIndex === 0) {
          wx.showModal({
            title: '「' + title + '」多少分',
            editable: true,
            content: String(points),
            success: async (m) => {
              if (!m.confirm) return
              const res = await store.updateExtraPoints(self.data.ov.day, id, (m.content || '').trim())
              self.refresh()
              if (!res.ok) {
                wx.showToast({ title: res.error || '没保存上', icon: 'none' })
                return
              }
              wx.showToast({ title: '改成 ' + res.points + ' 分了', icon: 'none' })
            }
          })
        } else if (r.tapIndex === 1) {
          self._confirmAction = { type: 'reject', id: id, title: title }
          self.setData({
            confirm: {
              title: '不同意「' + title + '」',
              content: '这一项会从今天的清单里去掉，孩子那边也会消失。',
              confirmText: '不同意'
            }
          })
        }
      }
    })
  },

  async onConfirmOk() {
    const action = this._confirmAction
    this.setData({ confirm: null })
    if (!action) return
    let res
    let okToast = ''
    if (action.type === 'reject') {
      res = await store.rejectExtra(this.data.ov.day, action.id)
      okToast = '已拒绝'
    } else if (action.type === 'revoke') {
      res = await store.revokeItem(this.data.ov.day, action.id)
      okToast = '已撤销'
    } else if (action.type === 'del-approve') {
      res = await store.approveDelete(this.data.ov.day, action.id)
      okToast = '已删除'
    } else if (action.type === 'del-reject') {
      res = await store.rejectDelete(this.data.ov.day, action.id)
      okToast = '已保留'
    } else if (action.type === 'del-direct') {
      res = await store.deleteItemToday(this.data.ov.day, action.id)
      okToast = '已删除'
    } else if (action.type === 'req-del') {
      res = await store.requestDelete(this.data.ov.day, action.id)
      okToast = '已申请，等家长处理'
    } else if (action.type === 'req-cancel') {
      res = await store.cancelDeleteRequest(this.data.ov.day, action.id)
      okToast = '已取消申请'
    } else if (action.type === 'voice-del') {
      res = await store.removeVoice(this.data.ov.day, action.id, action.voiceId)
      okToast = '语音已删除'
    }
    this.refresh()
    if (!res.ok) {
      this.refresh()
      wx.showToast({ title: res.error || '没保存上', icon: 'none' })
      return
    }
    if (action.type === 'voice-del') {
      voice.deleteFile(action.path)
    }
    wx.showToast({ title: okToast, icon: 'none' })
  },

  onConfirmCancel() {
    this._confirmAction = null
    this.setData({ confirm: null })
  },

  noop() {},

  /* ---------------- 学生自己加项 ---------------- */

  onChildAdd() {
    if (this.data.role !== 'child') return
    this.setData({ childForm: { title: '', points: '' } })
  },

  onChildTitle(e) {
    this.setData({ 'childForm.title': e.detail.value })
  },

  onChildPoints(e) {
    this.setData({ 'childForm.points': e.detail.value })
  },

  onChildAddCancel() {
    this.setData({ childForm: null })
  },

  async onChildAddOk() {
    const form = this.data.childForm || {}
    const title = (form.title || '').trim()
    if (!title) {
      wx.showToast({ title: '先写想加什么', icon: 'none' })
      return
    }
    if (this.busy) return
    this.busy = true
    const points = Number((form.points || '').trim()) || 5
    const res = await store.addExtraToday(title, points, true)
    this.busy = false
    this.setData({ childForm: null })
    this.refresh()
    if (!res.ok) {
      wx.showToast({ title: res.error || '没保存上', icon: 'none' })
      return
    }
    wx.showToast({ title: '已发给家长同意', icon: 'none' })
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
      onStop: async (tmpPath, seconds, text) => {
        self.setData({ recordingId: '' })
        if (seconds < 1) {
          wx.showToast({ title: '太短了，没录上', icon: 'none' })
          return
        }
        self.setData({ uploadingId: id })
        const res = await voice.uploadAndSave(day, id, tmpPath, seconds, text)
        self.setData({ uploadingId: '' })
        self.refresh()
        if (!res.ok) {
          wx.showToast({ title: res.error || '没保存上，再试一次', icon: 'none' })
          return
        }
        // 腾讯云 ASR：录完自动转文字（3 分钟整条也支持），失败不挡保存
        if (res.voiceId) {
          self.autoTranscribe(day, id, res.voiceId)
        }
        wx.showToast({ title: '语音已保存，可以接着再录', icon: 'none' })
      },
      onError: (msg) => {
        self.setData({ recordingId: '' })
        wx.showToast({ title: msg || '录音失败了', icon: 'none' })
      }
    })
  },

  // 后台转写：文字好了自动出现在语音条下面，失败不打扰（可点「转文字」重试）
  async autoTranscribe(day, itemId, voiceId) {
    if (!asr.configured()) return
    this.setData({ transcribingId: voiceId })
    const path = this.findVoicePath(voiceId)
    const res = await asr.transcribe(path || '')
    if (this.data.transcribingId === voiceId) {
      this.setData({ transcribingId: '' })
    }
    if (res.ok && res.text) {
      await store.setVoiceText(day, itemId, voiceId, res.text)
      this.refresh()
      wx.showToast({ title: '文字转好了，点 📝 查看', icon: 'none' })
    } else {
      this.refresh()
    }
  },

  // 找到语音所在条目和语音对象
  findVoice(itemId, voiceId) {
    const all = (this.data.ov.groups || []).reduce((arr, g) => arr.concat(g.items), [])
    const item = all.filter((x) => x.id === itemId)[0]
    if (!item) return null
    const v = (item.voices || []).filter((x) => x.id === voiceId)[0]
    return v ? { item: item, voice: v } : null
  },

  // 找到语音的存储路径
  findVoicePath(voiceId) {
    // 兼容旧调用：只传 voiceId 时在全部条目里找
    const all = (this.data.ov.groups || []).reduce((arr, g) => arr.concat(g.items), [])
    for (const it of all) {
      const v = (it.voices || []).filter((x) => x.id === voiceId)[0]
      if (v) return v.path
    }
    return ''
  },

  // 手动转写（没有文字的语音旁的小按钮，双端可用），转好直接弹窗展示
  async onVoiceTranscribe(e) {
    const itemId = e.currentTarget.dataset.item
    const voiceId = e.currentTarget.dataset.voice
    if (!itemId || !voiceId) return
    if (this.data.transcribingId) return
    if (!asr.configured()) {
      wx.showToast({ title: '转文字服务还没配置', icon: 'none' })
      return
    }
    this.setData({ transcribingId: voiceId })
    const path = this.findVoicePath(voiceId)
    const res = await asr.transcribe(path)
    this.setData({ transcribingId: '' })
    if (res.ok && res.text) {
      const r = await store.setVoiceText(this.data.ov.day, itemId, voiceId, res.text)
      this.refresh()
      if (!r.ok) {
        wx.showToast({ title: r.error || '没保存上', icon: 'none' })
        return
      }
      this.showTextViewer(itemId, voiceId)
    } else {
      wx.showToast({ title: res.error || '没转出来，稍后再试', icon: 'none' })
    }
  },

  // 弹窗展示一条语音的文字
  showTextViewer(itemId, voiceId) {
    const found = this.findVoice(itemId, voiceId)
    if (!found || !found.voice.text) return
    this.setData({
      textViewer: {
        title: (found.item.title || '语音') + ' · 语音文字',
        text: formatVoiceText(found.voice.text)
      }
    })
  },

  // 点 📝 查看已有文字
  onVoiceShowText(e) {
    const itemId = e.currentTarget.dataset.item
    const voiceId = e.currentTarget.dataset.voice
    if (!itemId || !voiceId) return
    this.showTextViewer(itemId, voiceId)
  },

  onTextClose() {
    this.setData({ textViewer: null })
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
  },

  // 学生长按语音条：删除这条语音（二次确认，防止误删）
  onVoiceDelete(e) {
    if (this.data.role !== 'child') return
    const itemId = e.currentTarget.dataset.item
    const voiceId = e.currentTarget.dataset.id
    const path = e.currentTarget.dataset.path
    if (!itemId || !voiceId) return
    if (this.data.playingId === voiceId) {
      voice.stopPlay()
      this.setData({ playingId: '' })
    }
    this._confirmAction = { type: 'voice-del', id: itemId, voiceId: voiceId, path: path }
    this.setData({
      confirm: {
        title: '删除这条语音？',
        content: '删掉后就找不回来了，爸爸妈妈也听不到了。确定要删吗？',
        confirmText: '删除'
      }
    })
  },

  // 家长点赞语音（开关式）：最多一个赞，再点一下取消
  async onVoiceLike(e) {
    if (this.data.role !== 'parent') return
    if (this.busy) return
    const item = e.currentTarget.dataset.item
    const voiceId = e.currentTarget.dataset.voice
    if (!item || !voiceId) return
    this.busy = true
    const res = await store.toggleVoiceLike(this.data.ov.day, item, voiceId)
    this.busy = false
    this.refresh()
    if (!res.ok) {
      wx.showToast({ title: res.error || '没保存上', icon: 'none' })
      return
    }
    if (res.liked) {
      wx.vibrateShort({ type: 'light' })
      this.setData({ likePopId: voiceId })
      setTimeout(() => {
        if (this.data.likePopId === voiceId) this.setData({ likePopId: '' })
      }, 500)
    } else {
      wx.showToast({ title: '已取消赞（-1 分）', icon: 'none' })
    }
  }
})
