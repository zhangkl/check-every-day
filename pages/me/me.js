const store = require('../../utils/store')
const guard = require('../../utils/guard')
const invite = require('../../utils/invite')

// 全量 emoji 头像池：空格分隔后切开，滑动网格随便选；也支持输入框粘贴任意 emoji
const EMOJIS = (
  '😀 😄 😁 😆 😅 😂 🤣 😊 😇 🙂 😉 😍 🥰 😘 😋 😝 😜 🤪 🤨 🧐 🤓 😎 🥳 😏 😒 😞 😔 😟 🙁 ☹️ 😖 😫 😩 🥺 😢 😭 😤 😠 😡 🤯 😳 🥵 🥶 😱 😨 😰 🤗 🤔 🤭 🤫 😶 😐 😑 🙄 😯 😴 🤤 🥱 🤐 🥴 🤢 🤮 😷 🤒 🤕 🥸 🤠 🤑 😈 👿 🤡 💩 👻 💀 👽 🤖 🎃 ' +
  '🐶 🐱 🐭 🐹 🐰 🦊 🐻 🐼 🐨 🐯 🦁 🐮 🐷 🐸 🐵 🐔 🐧 🐦 🐤 🦆 🦅 🦉 🦇 🐺 🐗 🐴 🦄 🐝 🦋 🐌 🐞 🐢 🐍 🦎 🐙 🦑 🦐 🦀 🐡 🐠 🐟 🐬 🐳 🦈 🐊 🐆 🦓 🦍 🐘 🦛 🦏 🐪 🦒 🦘 🐃 🐄 🐎 🐖 🐏 🐑 🦙 🐐 🦌 🐕 🐩 🐈 🐓 🦃 🦚 🦜 🦢 🕊 🐇 🦝 🦔 ' +
  '🍎 🍐 🍊 🍋 🍌 🍉 🍇 🍓 🫐 🍒 🍑 🥭 🍍 🥥 🥝 🍅 🍆 🥑 🥦 🌽 🥕 🥔 🍞 🥐 🥖 🧇 🥞 🧀 🍗 🍖 🌭 🍔 🍟 🍕 🥪 🌮 🌯 🥗 🍝 🍜 🍲 🍛 🍣 🍱 🥟 🍤 🍙 🍚 🍥 🍢 🍡 🍧 🍨 🍦 🥧 🧁 🍰 🎂 🍮 🍭 🍬 🍫 🍿 🍩 🍪 ☕ 🍵 🧃 🥤 🧋 🥛 ' +
  '⚽ 🏀 🏈 ⚾ 🎾 🏐 🏉 🎱 🏓 🏸 🏹 🎣 🥊 🎯 🎮 🕹 🎲 🧩 🎨 🎭 📚 📖 ✏️ 🖊 🎵 🎶 🎸 🎹 🎺 🎻 🥁 🎤 🎧 🚀 ✈️ 🚗 🚕 🚙 🚌 🚲 ⛵ 🚢 🏝 🗻 🎡 🎢 🎠 ' +
  '⭐ 🌟 ✨ ⚡ 🔥 🌈 ☀️ 🌤 🌙 💫 🪐 🌍 💎 🔮 🎈 🎉 🎊 🎁 🏅 🏆 🥇 🥈 🥉 👑 🎀 ❤️ 🧡 💛 💚 💙 💜 🖤 💝 💐 🌹 🌻 🌸 🌺 🌷 🌱 🌲 🌳 🍀 🌊'
).split(' ')

Page({
  data: {
    role: 'child',
    ready: false,
    isLocal: false,
    family: { name: '', childName: '' },
    balance: 0,
    streak: 0,
    pendingCount: 0,
    hasPin: false,
    inviteCode: '',
    label: '',
    famSheet: false,
    famName: '',
    famChild: '',
    famLabel: '',
    famMembers: [],
    account: '',
    avatar: '',
    emojiList: EMOJIS,
    customEmoji: '',
    avatarSheet: false,
    confirm: null
  },

  async onShow() {
    const ok = await guard.ensureReady()
    if (!ok) return
    try {
      this.refresh()
    } catch (e) {
      // 任何数据异常都不能把页面卡在加载态
      this.setData({ ready: true })
    }
  },

  refresh() {
    if (!store.isSetup()) return
    this.setData({
      role: store.getRole(),
      isLocal: store.isLocal(),
      ready: true,
      family: store.getFamily(),
      balance: store.balance(),
      streak: store.streak(),
      hasPin: !!store.getPin(),
      inviteCode: store.getInviteCode(),
      label: store.getMyLabel(),
      account: store.sessionLabel(),
      avatar: store.getMyAvatar(),
      pendingCount: store.listRedemptions().filter(function (r) {
        return r.status === 'pending'
      }).length + store.listWishes().filter(function (w) {
        return w.status === 'pending'
      }).length
    })
  },

  // 头像：点头像 → emoji 全池选择（家长端/学生端各自一份，互不影响）
  onEditAvatar() {
    this.setData({ avatarSheet: true, customEmoji: '' })
  },

  onAvatarClose() {
    this.setData({ avatarSheet: false })
  },

  async onPickAvatar(e) {
    const a = e.currentTarget.dataset.a
    if (!a) return
    const res = await store.setMyAvatar(a)
    if (!res.ok) {
      wx.showToast({ title: res.error || '没换上，再试一次', icon: 'none' })
      return
    }
    this.setData({ avatar: res.avatar, avatarSheet: false })
    wx.showToast({ title: '换好了', icon: 'none' })
  },

  onCustomEmoji(e) {
    this.setData({ customEmoji: e.detail.value })
  },

  async onUseCustom() {
    let v = (this.data.customEmoji || '').trim()
    if (!v) {
      // 兜底：直接从输入框节点读实时值（个别环境 bindinput 不触发）
      try {
        const val = await new Promise((resolve) => {
          wx.createSelectorQuery()
            .in(this)
            .select('#emojiField')
            .fields({ properties: ['value'] }, (r) => resolve(r && r.value))
            .exec()
        })
        if (val) v = String(val).trim()
      } catch (e) {}
    }
    if (!v) {
      wx.showToast({ title: '先选一个或输入 emoji', icon: 'none' })
      return
    }
    const res = await store.setMyAvatar(v)
    if (!res.ok) {
      wx.showToast({ title: res.error || '没换上，再试一次', icon: 'none' })
      return
    }
    this.setData({ avatar: res.avatar, avatarSheet: false, customEmoji: '' })
    wx.showToast({ title: '换好了', icon: 'none' })
  },

  onCopyCode() {
    const code = this.data.inviteCode
    if (!code) return
    wx.setClipboardData({
      data: code,
      success() {
        wx.showToast({ title: '已复制，发给家人', icon: 'none' })
      }
    })
  },

  // 微信原生分享：一张家庭码，对方点开后停在加入页，自己选孩子/家长再点加入
  onShareAppMessage(res) {
    const name = (this.data.family && this.data.family.name) || '我们家'
    return {
      title: '邀请你加入「' + name + '」，一起养成好习惯',
      path: invite.buildSharePath(this.data.inviteCode, name)
    }
  },

  // 家庭信息：点家庭名弹出，改家庭名称、孩子昵称和称呼（仅家长）；同时展示家庭成员
  onEditFamily() {
    if (this.data.role !== 'parent') return
    this.setData({
      famSheet: true,
      famName: this.data.family.name || '',
      famChild: this.data.family.childName || '',
      famLabel: this.data.label || '',
      famMembers: store.listMembers()
    })
  },

  onFamName(e) {
    this.setData({ famName: e.detail.value })
  },

  onFamChild(e) {
    this.setData({ famChild: e.detail.value })
  },

  onFamLabel(e) {
    this.setData({ famLabel: e.detail.value })
  },

  onFamCancel() {
    this.setData({ famSheet: false })
  },

  // 兜底：从输入框节点读实时值（个别环境 bindinput 不触发）
  async readField(id) {
    try {
      const r = await new Promise((resolve) => {
        wx.createSelectorQuery()
          .in(this)
          .select('#' + id)
          .fields({ properties: ['value'] }, (x) => resolve(x && x.value))
          .exec()
      })
      return r == null ? '' : String(r)
    } catch (e) {
      return ''
    }
  },

  async onFamSave() {
    let name = (this.data.famName || '').trim()
    let child = (this.data.famChild || '').trim()
    let label = (this.data.famLabel || '').trim()
    if (!name) name = (await this.readField('famNameField')).trim()
    if (!child) child = (await this.readField('famChildField')).trim()
    if (!label) label = (await this.readField('famLabelField')).trim()
    // 只改称呼时不再连带写一次家庭资料（少一次云端写入，也不受家庭信息校验牵连）
    const fam = store.getFamily() || {}
    const famChanged = name !== (fam.name || '') || child !== (fam.childName || '')
    if (famChanged) {
      const res = await store.setFamilyInfo(name, child)
      if (!res.ok) {
        wx.showToast({ title: res.error || '没存上，再试一次', icon: 'none' })
        return
      }
    }
    // 称呼留空 = 保持原称呼不变；写了就一起存
    if (label) {
      const lr = await store.setMyLabel(label)
      if (!lr.ok) {
        wx.showToast({ title: lr.error || '称呼没存上', icon: 'none' })
        return
      }
    }
    this.setData({ famSheet: false })
    this.refresh()
    wx.showToast({ title: '改好了', icon: 'none' })
  },

  goShop() {
    wx.navigateTo({ url: '/pages/shop/shop' })
  },

  goPlan() {
    wx.navigateTo({ url: '/pages/plan/plan' })
  },

  onSwitchToParent() {
    const pin = store.getPin()
    if (!pin) {
      this.applyRole('parent', true)
      return
    }
    wx.showModal({
      title: '输入家长密码',
      editable: true,
      placeholderText: '4 位数字',
      success: (r) => {
        if (!r.confirm) return
        if ((r.content || '').trim() !== pin) {
          wx.showToast({ title: '密码不对', icon: 'none' })
          return
        }
        this.applyRole('parent', true)
      }
    })
  },

  onSwitchToChild() {
    this.applyRole('child')
  },

  applyRole(role, verified) {
    getApp().switchRole(role, verified === true)
    this.setData({ role })
    wx.showToast({ title: role === 'parent' ? '已切到家长端' : '已切到学生端', icon: 'none' })
    wx.reLaunch({ url: '/pages/today/today' })
  },

  onSetPin() {
    if (store.getPin()) {
      wx.showActionSheet({
        itemList: ['修改密码', '取消密码'],
        success: (r) => {
          if (r.tapIndex === 0) this.inputPin()
          if (r.tapIndex === 1) {
            store.setPin('').then((res) => {
              this.refresh()
              wx.showToast({ title: res.ok ? '已取消密码' : res.error, icon: 'none' })
            })
          }
        }
      })
      return
    }
    this.inputPin()
  },

  inputPin() {
    wx.showModal({
      title: '设置 4 位家长密码',
      editable: true,
      placeholderText: '例如 2026',
      success: async (r) => {
        if (!r.confirm) return
        const pin = (r.content || '').trim()
        if (!/^\d{4}$/.test(pin)) {
          wx.showToast({ title: '请输入 4 位数字', icon: 'none' })
          return
        }
        const res = await store.setPin(pin)
        this.refresh()
        wx.showToast({ title: res.ok ? '已设置' : res.error, icon: 'none' })
      }
    })
  },

  goTasks() {
    wx.navigateTo({ url: '/pages/parent-tasks/parent-tasks' })
  },

  goApprove() {
    wx.navigateTo({ url: '/pages/parent-approve/parent-approve' })
  },

  // 本地模式：登录后可以把本机数据带到云端
  goCloud() {
    wx.showModal({
      title: '登录并同步到云端',
      content: '登录创建家庭后，这台手机上已有的打卡和积分可以一并带过去。',
      confirmText: '去登录',
      success(r) {
        if (!r.confirm) return
        // 只退本地模式、保留本机文档，登录建家庭后再决定是否迁移
        store.exitLocal()
        wx.reLaunch({ url: '/pages/login/login' })
      }
    })
  },

  onReset() {
    const isLocal = this.data.isLocal
    this.setData({
      confirm: {
        title: isLocal ? '重置本地数据' : '清空所有数据',
        content: isLocal
          ? '会清掉这台手机上的任务、打卡记录、积分和礼物，回到初始清单。清完继续在本地使用，无法恢复。'
          : '会删除全部任务、打卡记录、积分和礼物，家人手机上的内容也会一起清空，且无法恢复。',
        confirmText: '清空',
        action: 'reset'
      }
    })
  },

  onSignOut() {
    if (this.data.isLocal) {
      this.setData({
        confirm: {
          title: '清空本地数据',
          content: '会删掉这台手机上全部打卡记录和积分，并退出到登录选择，无法恢复。',
          confirmText: '清空',
          action: 'clearLocal'
        }
      })
      return
    }
    this.setData({
      confirm: {
        title: '退出登录',
        content: '退出后需要重新登录才能继续使用，家里的数据不会删除。',
        confirmText: '退出',
        action: 'signOut'
      }
    })
  },

  // 页面内自绘确认框（不依赖 wx.showModal，预览环境也能点）
  onConfirmCancel() {
    this.setData({ confirm: null })
  },

  async onConfirmOk() {
    const box = this.data.confirm
    if (!box) return
    this.setData({ confirm: null })
    if (box.action === 'reset') {
      let res = { ok: false, error: '没清成，再试一次' }
      try {
        res = await store.resetAll()
      } catch (e) {}
      if (!res.ok) {
        wx.showToast({ title: res.error || '清空失败', icon: 'none' })
        return
      }
      wx.showToast({ title: '已清空', icon: 'none' })
      wx.reLaunch({ url: '/pages/today/today' })
      return
    }
    if (box.action === 'clearLocal') {
      try {
        store.clearLocalData()
      } catch (e) {}
      wx.reLaunch({ url: '/pages/login/login' })
      return
    }
    if (box.action === 'signOut') {
      try {
        await store.signOut()
      } catch (e) {}
      wx.reLaunch({ url: '/pages/login/login' })
    }
  },

  noop() {}
})
