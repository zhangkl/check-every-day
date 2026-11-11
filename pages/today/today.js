const store = require('../../utils/store')
const guard = require('../../utils/guard')
const voice = require('../../utils/voice')
const asr = require('../../utils/asr')
const quotes = require('../../utils/quotes')
const dateUtil = require('../../utils/date')

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

/* ---------------- 小项标题后的语音/点赞/评论小按钮（一行放不下就 …） ---------------- */

// 这一行能放几个小按钮：按标题字数估算剩余宽度（rpx 布局与机型无关）
function chipCapacity(it) {
  const extra = it.status === 'pending' || it.status === 'del-pending' ? 4 : 0
  const titleW = (String(it.title || '').length + extra) * 30 + 16
  const left = 500 - titleW
  return Math.max(1, Math.min(5, Math.floor(left / 76)))
}

// 把每条语音的操作拍扁成一维小按钮，供收起态一行展示
function buildInlineChips(it, ctx) {
  const all = []
  ;(it.voices || []).forEach(function (v) {
    const base = { item: it.id, voice: v.id, path: v.path || '' }
    function push(type, label, cls) {
      all.push(Object.assign({}, base, { key: v.id + '-' + type, type: type, label: label, cls: cls }))
    }
    push('play', (ctx.playingId === v.id ? '🔊 ' : '▶ ') + v.duration + '″', ctx.playingId === v.id ? 'voice playing' : 'voice')
    if (ctx.role === 'parent' || v.liked) {
      push('like', v.liked ? '👍 1' : '👍', 'like' + (v.liked ? ' on' : '') + (ctx.likePopId === v.id ? ' pop' : ''))
    }
    if (v.text) push('text', '📝', 'icon')
    push('comment', '💬' + (v.comments && v.comments.length ? v.comments.length : ''), 'icon')
    if (!v.text && ctx.transcribingId !== v.id) push('trans', '转文字', 'text')
    if (ctx.transcribingId === v.id) push('tip', '转文字中…', 'tip')
  })
  return all
}

function decorateGroups(groups, ctx) {
  return (groups || []).map(function (g) {
    const items = (g.items || []).map(function (it) {
      const all = buildInlineChips(it, ctx)
      const cap = chipCapacity(it)
      const more = all.length > cap
      return Object.assign({}, it, {
        chips: more ? all.slice(0, Math.max(1, cap - 1)) : all,
        chipsMore: more
      })
    })
    // tab 上最多展示前四个字，全名在列表头展示
    return Object.assign({}, g, { items: items, tabTitle: (g.title || '').slice(0, 4) })
  })
}

/* ---------------- 实时同步：对比新旧文档，按角色生成提示 ---------------- */

// 评论时间显示：今天/昨天/更早
function fmtWhen(at) {
  const t = Number(at) || 0
  if (!t) return ''
  const d = new Date(t)
  const hm = d.getHours() + ':' + String(d.getMinutes()).padStart(2, '0')
  const dayStart = new Date()
  dayStart.setHours(0, 0, 0, 0)
  const oneDay = 24 * 3600 * 1000
  if (t >= dayStart.getTime()) return '今天 ' + hm
  if (t >= dayStart.getTime() - oneDay) return '昨天 ' + hm
  return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + hm
}

// 组装一条留言的展示数据（带头像、称呼标签、时间）
// 按「uid+身份」取个人资料：称呼/头像分家长、学生两份存（store.profileKey 同规则）；
// 旧数据存在旧键 <uid> 下，只有家长身份回退读取（旧称呼只可能是家长设置的）
function profileOf(profile, uid, role) {
  if (!profile || !uid) return null
  const keyed = profile[uid + '|' + (role === 'parent' ? 'p' : 'c')]
  if (keyed) return keyed
  return role === 'parent' ? profile[uid] || null : null
}

function shapeNote(n, profile, myUid, role) {
  const p = profileOf(profile, n.uid, n.role)
  const fam = store.getFamily() || {}
  const label =
    (p && p.label) || (n.role === 'parent' ? '家长' : fam.childName || '孩子')
  return {
    id: n.id,
    who: label,
    role: n.role,
    avatar: (p && p.avatar) || (n.role === 'parent' ? '👨‍👩‍👧' : '🧒'),
    text: n.text,
    at: n.at,
    when: fmtWhen(n.at),
    pinned: !!n.pinned,
    mine: n.uid === myUid && (n.role === 'parent') === (role === 'parent')
  }
}

// 返回 { text: 要 toast 的提示（可为空），like: 孩子被点赞的庆祝文案（可为空） }
function diffDocs(oldDoc, newDoc, day, role) {
  const out = { text: '', like: '' }
  if (!oldDoc || !newDoc || !day) return out
  const msgs = []
  const a = (oldDoc.sheets && oldDoc.sheets[day] && oldDoc.sheets[day].items) || []
  const b = (newDoc.sheets && newDoc.sheets[day] && newDoc.sheets[day].items) || []
  const oldMap = {}
  a.forEach(function (it) { oldMap[it.id] = it })

  b.forEach(function (it) {
    const o = oldMap[it.id]
    if (!o) {
      // 今天清单里新出现的条目
      if (it.status === 'pending') {
        if (role === 'parent') msgs.push('孩子想加一项：' + it.title)
      } else if (role === 'child') {
        msgs.push('新任务来了：' + it.title)
      }
      return
    }
    if (!o.done && it.done) {
      if (role === 'parent') {
        msgs.push(it.title + ' 打卡完成，+' + it.points + ' 分')
      } else {
        msgs.push(it.title + ' 打卡成功，+' + it.points + ' 分！')
      }
    } else if (o.done && !it.done && role === 'parent') {
      msgs.push('已撤销打卡：' + it.title)
    }
    if (o.status === 'pending' && it.status !== 'pending' && role === 'child' && it.status !== 'del-pending') {
      msgs.push('家长同意了新任务：' + it.title)
    }
    if (o.status === 'del-pending' && it.status !== 'del-pending' && role === 'child') {
      msgs.push('删除请求没通过，继续加油：' + it.title)
    }
    const vo = o.voices || []
    const vn = it.voices || []
    if (vn.length > vo.length && role === 'parent') {
      msgs.push('孩子新录了语音小结：' + it.title)
    }
    vn.forEach(function (v) {
      const old = vo.filter(function (x) { return x.id === v.id })[0]
      if (old && !old.liked && v.liked && role === 'child') {
        out.like = '家长给「' + it.title + '」的语音点了赞，+1 分'
      }
      // 新评论：孩子收到家长评论的提示，家长收到孩子评论的提示（自己的评论不提示）
      const oc = (old && old.comments) || []
      const nc = v.comments || []
      if (nc.length > oc.length) {
        const added = nc.slice(oc.length)
        if (role === 'child' && added.some(function (c) { return c.role === 'parent' })) {
          msgs.push('家长评论了你的语音，快去看看')
        }
        if (role === 'parent' && added.some(function (c) { return c.role === 'child' })) {
          msgs.push('孩子评论了语音：' + it.title)
        }
      }
    })
  })
  a.forEach(function (it) {
    const still = b.filter(function (x) { return x.id === it.id })[0]
    if (!still) {
      msgs.push(role === 'parent' ? '任务已删除：' + it.title : '这一项被删除了：' + it.title)
    }
  })
  // 孩子发起兑换（家长端提示）
  if (role === 'parent') {
    const ra = oldDoc.redemptions || []
    const rb = newDoc.redemptions || []
    if (rb.length > ra.length) {
      const nr = rb[rb.length - 1]
      if (nr && nr.status === 'pending') {
        msgs.push('孩子想兑换：' + (nr.giftName || '礼物'))
      }
    }
  }
  // 留言板：收到对方的新留言才提示（自己的、删除的不提示）
  const na = oldDoc.notes || []
  const nb = newDoc.notes || []
  const oldIds = {}
  na.forEach(function (n) { oldIds[n.id] = true })
  const newOnes = nb.filter(function (n) { return !oldIds[n.id] })
  if (role === 'child' && newOnes.some(function (n) { return n.role === 'parent' })) {
    msgs.push('📢 家长发了新公告，去看看')
  }
  if (role === 'parent' && newOnes.some(function (n) { return n.role === 'child' })) {
    msgs.push('孩子给你留言了')
  }
  if (msgs.length) out.text = msgs.slice(0, 2).join('；')
  return out
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
    expanded: {},
    confirm: null,
    childForm: null,
    adjustForm: null,
    textViewer: null,
    likeCele: null,
    commentBox: null,
    commentInput: '',
    quoteIdx: 0,
    poem: null,
    noteSheet: null,
    noteInput: '',
    notePreview: null,
    activeIdx: 0,
    noticeCount: 0,
    noticeUnread: 0,
    noticeLatest: ''
  },

  async onShow() {
    const ok = await guard.ensureReady()
    if (!ok) return
    const role = store.getRole()
    getApp().globalData.role = role
    this.setData({ role })
    this.refresh()
    this.startPolling()
  },

  onHide() {
    this.stopPolling()
  },

  onUnload() {
    this.stopPolling()
  },

  async onPullDownRefresh() {
    await guard.ensureReady(true)
    this.refresh()
    wx.stopPullDownRefresh()
  },

  /* ---------------- 实时同步：轻量轮询（前台每 15 秒查一次版本号） ---------------- */

  startPolling() {
    if (this.pollTimer || store.isLocal()) return
    const self = this
    this.pollTimer = setInterval(function () {
      self.pollRemote()
    }, 15000)
  },

  stopPolling() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
  },

  async pollRemote() {
    if (this.polling || this.busy) return
    if (!this.data.ready || store.isLocal()) return
    this.polling = true
    try {
      const r = await store.fetchRemoteRev()
      if (r.skip || r.error) return
      if (r.rev === store.getRev()) return // 没变化，什么都不做
      const oldDoc = JSON.parse(JSON.stringify(store.getDoc() || {}))
      const day = this.data.ov ? this.data.ov.day : ''
      const role = this.data.role
      const loaded = await store.reload()
      if (!loaded.ok) return
      const msgs = diffDocs(oldDoc, store.getDoc(), day, role)
      this.refresh()
      // 孩子被点赞 → 全屏红心庆祝
      if (msgs.like) {
        this.setData({ likeCele: { text: msgs.like } })
        setTimeout(() => {
          if (this.data.likeCele) this.setData({ likeCele: null })
        }, 2600)
      }
      if (msgs.text) {
        wx.showToast({ title: msgs.text, icon: 'none', duration: 2800 })
      }
    } catch (e) {
      // 轮询失败静默，不打扰
    } finally {
      this.polling = false
    }
  },

  hideLikeCele() {
    this.setData({ likeCele: null })
  },

  // 每日一句：点一下换下一条
  onQuoteTap() {
    const next = (this.data.quoteIdx || 0) + 1
    const day = (this.data.ov && this.data.ov.day) || ''
    this.setData({ quoteIdx: next, quote: quotes.pick(day, next) })
  },

  // hero 里的随机古诗词：点一下换一首（避开底部每日一句和当前这首）
  onPoemTap() {
    const blocked = []
    if (this.data.quote && this.data.quote.zh) blocked.push(this.data.quote.zh)
    if (this.data.poem && this.data.poem.zh) blocked.push(this.data.poem.zh)
    this.setData({ poem: quotes.pickPoem(blocked) })
  },

  // 操作提示：按角色给出 1234 条，点底部 💡 打开
  onTipsOpen() {
    const childTips = [
      '点任务旁的 🎙 说语音，再点一下结束，说完自动转文字',
      '长按语音条可删掉重说；点 📝 看转的文字，点 💬 看评论',
      '长按没完成的任务可申请删除，家长同意后生效',
      '点「＋ 自己加一项」加任务，家长同意后当天生效',
      '被 👍 点赞 +1 分，会有满屏庆祝动画',
      '点左上角的头像可换头像、改称呼，进「我的」页',
      '标题后面的小按钮放不下时会显示「…」，点开看全部语音和评论'
    ]
    const parentTips = [
      '点 ✓ 可同意或拒绝孩子申请的加项 / 删除',
      '长按任务可改分值、拒绝、删除或撤销完成',
      '点 👍 给语音点赞 +1 分，再点一下取消',
      '点 📢 打开家庭留言板，置顶的留言就是首页公告',
      '改清单当天就生效，孩子端 15 秒内自动同步',
      '点左上角的头像可换头像、改称呼，进「我的」页',
      '清单里带「待家长同意」的加项/删除，在首页点 ✓ 就地处理；兑换与心愿审批在「我的」里',
      '标题后面的小按钮放不下时会显示「…」，点开看全部语音和评论'
    ]
    this.setData({
      tipsSheet: true,
      tipsList: this.data.role === 'parent' ? parentTips : childTips
    })
  },

  onTipsClose() {
    this.setData({ tipsSheet: false })
  },

  refresh() {
    if (!store.isSetup()) return
    const ov = store.todayOverview()
    const role = store.getRole()
    // 标题后的小按钮按当前状态拍扁，供收起态一行展示
    ov.groups = decorateGroups(ov.groups, {
      role: role,
      playingId: this.data.playingId,
      transcribingId: this.data.transcribingId,
      likePopId: this.data.likePopId
    })
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
    const todayQuote = quotes.pick(ov.day, this.data.quoteIdx || 0)
    const allNotices = store.listNotices()
    const patch = {
      ov,
      role,
      family,
      heroTitle,
      avatar: store.getMyAvatar(),
      notePreview: this.buildNotePreview(),
      lateText: lateText(),
      quote: todayQuote,
      // 学生端 hero 的随机古诗词：进页面抽一次，之后刷新不跳字
      poem: this.data.poem || quotes.pickPoem(todayQuote.zh),
      noticeCount: allNotices.length,
      noticeUnread: allNotices.filter(function (n) { return n.unread }).length,
      noticeLatest: allNotices.length ? (allNotices[0].fromName + ' ' + allNotices[0].text) : '',
      ready: true,
      // 当前选中的大项越界时回到第一个（清单被删空/变少时兜底）
      activeIdx: Math.min(this.data.activeIdx || 0, Math.max((ov.groups || []).length - 1, 0))
    }
    if (role === 'parent') {
      patch.week = store.recentDays(7)
      // 待处理 = 兑换申请 + 孩子心愿（和审批中心口径一致）
      patch.pending = store.listRedemptions().filter(function (r) {
        return r.status === 'pending'
      }).length + store.listWishes().filter(function (w) {
        return w.status === 'pending'
      }).length
    }
    this.setData(patch)
  },

  findItem(id) {
    return (this.data.ov.groups || [])
      .reduce((all, g) => all.concat(g.items), [])
      .filter((it) => it.id === id)[0]
  },

  // 点击大项标签切换当前卡片（动画由节点随 activeIdx 重建触发，方向跟随切换方向）
  onGroupTab(e) {
    const idx = Number(e.currentTarget.dataset.idx)
    if (isNaN(idx) || idx === this.data.activeIdx) return
    this.switchGroup(idx)
  },

  switchGroup(idx) {
    const groups = this.data.ov.groups || []
    if (idx < 0 || idx >= groups.length) return
    const dir = idx > this.data.activeIdx ? 'r' : 'l'
    this.setData({ activeIdx: idx, animDir: dir })
  },

  // 横滑切换大项：绑在小项列表上，避免和大项带的横向滚动打架
  onCardTouchStart(e) {
    const t = e.touches[0]
    this._sx = t.clientX
    this._sy = t.clientY
  },

  onCardTouchEnd(e) {
    if (this._sx == null) return
    const t = e.changedTouches[0]
    const dx = t.clientX - this._sx
    const dy = t.clientY - this._sy
    this._sx = null
    // 横向位移够大且明显大于纵向才算滑动
    if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 1.5) return
    this.switchGroup(this.data.activeIdx + (dx < 0 ? 1 : -1))
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

  // 家庭动态：消息 + 操作流水融合成独立页面，两端同一个入口
  // 家长端「查流水」直接落在「全部动态」tab，其余入口落在「与我相关」
  onOpenFeed(e) {
    const tab = e && e.currentTarget && e.currentTarget.dataset.tab === 'all' ? 'all' : 'mine'
    wx.navigateTo({ url: '/pages/feed/feed?tab=' + tab })
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

  /* ---------------- 手动调分：分值 + 一句原因 ---------------- */

  // 兜底：个别环境 bindinput 不触发，保存时直接读输入框节点的值
  readInput(id) {
    return new Promise((resolve) => {
      try {
        wx.createSelectorQuery()
          .in(this)
          .select('#' + id)
          .fields({ properties: ['value'] }, (r) => resolve(r && r.value != null ? String(r.value) : ''))
          .exec()
      } catch (e) {
        resolve('')
      }
    })
  },

  onAdjust() {
    if (this.data.role !== 'parent') return
    this.setData({ adjustForm: { amount: '', note: '' } })
  },

  onAdjustAmount(e) {
    this.setData({ 'adjustForm.amount': e.detail.value })
  },

  onAdjustNote(e) {
    this.setData({ 'adjustForm.note': e.detail.value })
  },

  onAdjustCancel() {
    this.setData({ adjustForm: null })
  },

  async onAdjustOk() {
    const form = this.data.adjustForm || {}
    let raw = String(form.amount == null ? '' : form.amount).trim()
    let note = String(form.note == null ? '' : form.note).trim()
    if (!raw) raw = (await this.readInput('adjustAmount')).trim()
    if (!note) note = (await this.readInput('adjustNote')).trim()
    const amount = Number(raw)
    if (!raw || !isFinite(amount) || !amount) {
      wx.showToast({ title: '请输入一个数字', icon: 'none' })
      return
    }
    if (!note) {
      wx.showToast({ title: '写一句加分原因吧', icon: 'none' })
      return
    }
    const res = await store.adjustPoints(amount, note)
    if (!res.ok) {
      wx.showToast({ title: res.error || '没保存上', icon: 'none' })
      return
    }
    this.setData({ adjustForm: null })
    this.refresh()
    wx.showToast({ title: '已' + (amount > 0 ? '加' : '扣') + Math.abs(amount) + '分', icon: 'none' })
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
        // 腾讯云 ASR：录完自动转文字（10 分钟整条也支持），失败不挡保存
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

  // 语音评论：双端都能看、都能评；列表带头像（用各自设置的头像）、称呼
  openCommentBox(itemId, voiceId) {
    const found = this.findVoice(itemId, voiceId)
    if (!found) return
    const doc = store.getDoc()
    const profile = (doc && doc.profile) || {}
    const fam = store.getFamily() || {}
    const myUid = store.sessionUid() || 'me'
    const amParent = store.getRole() === 'parent'
    const list = (found.voice.comments || []).map(function (c) {
      const p = profileOf(profile, c.uid, c.role)
      return {
        id: c.id,
        who:
          (p && p.label) || (c.role === 'parent' ? '家长' : fam.childName || '孩子'),
        role: c.role,
        avatar: (p && p.avatar) || (c.role === 'parent' ? '👨‍👩‍👧' : '🧒'),
        text: c.text,
        when: fmtWhen(c.at),
        // 同账号同身份才算自己的；家长能删任何人的
        mine: c.uid === myUid && (c.role === 'parent') === amParent
      }
    })
    this.setData({
      commentBox: { itemId: itemId, voiceId: voiceId, title: found.item.title, list: list },
      commentInput: ''
    })
  },

  onVoiceComment(e) {
    const itemId = e.currentTarget.dataset.item
    const voiceId = e.currentTarget.dataset.voice
    if (!itemId || !voiceId) return
    this.openCommentBox(itemId, voiceId)
  },

  onCommentInput(e) {
    this.setData({ commentInput: e.detail.value })
  },

  onCommentClose() {
    this.setData({ commentBox: null, commentInput: '' })
  },

  async onCommentSend() {
    const box = this.data.commentBox
    const text = (this.data.commentInput || '').trim()
    if (!box || !text) return
    const r = await store.addVoiceComment(this.data.ov.day, box.itemId, box.voiceId, text)
    if (!r.ok) {
      wx.showToast({ title: r.error || '没发出去，再试一次', icon: 'none' })
      return
    }
    this.refresh()
    this.openCommentBox(box.itemId, box.voiceId)
    wx.showToast({ title: '发出去了', icon: 'none' })
  },

  // 删评论：家长删任何人的，孩子删自己的
  async onCommentDelete(e) {
    const box = this.data.commentBox
    const id = e.currentTarget.dataset.id
    if (!box || !id) return
    const r = await store.removeVoiceComment(this.data.ov.day, box.itemId, box.voiceId, id)
    if (!r.ok) {
      wx.showToast({ title: r.error || '没删成', icon: 'none' })
      return
    }
    this.refresh()
    this.openCommentBox(box.itemId, box.voiceId)
    wx.showToast({ title: '删掉了', icon: 'none' })
  },

  /* ---------------- 家庭留言板 ---------------- */

  // 顶部预览行：置顶公告优先，其次最新一条留言；都没有返回 null
  buildNotePreview() {
    const notes = store.listNotes()
    if (!notes.length) return null
    const doc = store.getDoc()
    const profile = (doc && doc.profile) || {}
    const top = notes[0]
    const shaped = shapeNote(top, profile, store.sessionUid() || 'me', store.getRole())
    return {
      id: shaped.id,
      avatar: shaped.avatar,
      who: shaped.who,
      text: shaped.text,
      pinned: shaped.pinned,
      count: notes.length
    }
  },

  openNoteSheet() {
    const doc = store.getDoc()
    const profile = (doc && doc.profile) || {}
    const myUid = store.sessionUid() || 'me'
    const role = store.getRole()
    const list = store.listNotes().map(function (n) {
      return shapeNote(n, profile, myUid, role)
    })
    this.setData({ noteSheet: { list: list }, noteInput: '' })
  },

  onNoteTap() {
    this.openNoteSheet()
  },

  onNoteInput(e) {
    this.setData({ noteInput: e.detail.value })
  },

  onNoteClose() {
    this.setData({ noteSheet: null, noteInput: '' })
  },

  async onNoteSend() {
    const text = (this.data.noteInput || '').trim()
    if (!text) return
    const r = await store.addNote(text)
    if (!r.ok) {
      wx.showToast({ title: r.error || '没发出去，再试一次', icon: 'none' })
      return
    }
    this.refresh()
    this.openNoteSheet()
    wx.showToast({ title: '发出去了', icon: 'none' })
  },

  // 家长置顶/取消一条公告
  async onNotePin(e) {
    const id = e.currentTarget.dataset.id
    if (!id) return
    const r = await store.pinNote(id)
    if (!r.ok) {
      wx.showToast({ title: r.error || '置顶失败', icon: 'none' })
      return
    }
    this.refresh()
    this.openNoteSheet()
    wx.showToast({ title: r.pinned ? '已置顶，会一直显示在顶部' : '已取消置顶', icon: 'none' })
  },

  async onNoteDelete(e) {
    const id = e.currentTarget.dataset.id
    if (!id) return
    const r = await store.removeNote(id)
    if (!r.ok) {
      wx.showToast({ title: r.error || '没删成', icon: 'none' })
      return
    }
    this.refresh()
    this.openNoteSheet()
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
    this.syncChips()
    const path = this.findVoicePath(voiceId)
    const res = await asr.transcribe(path)
    this.setData({ transcribingId: '' })
    this.syncChips()
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

  // 收起态：标题后的一行小按钮统一分发到原来的语音处理函数
  onChipTap(e) {
    const d = e.currentTarget.dataset
    const ev = { currentTarget: { dataset: { id: d.voice, item: d.item, voice: d.voice, path: d.path } } }
    switch (d.type) {
      case 'play': this.onVoicePlay(ev); break
      case 'like': this.onVoiceLike(ev); break
      case 'text': this.onVoiceShowText(ev); break
      case 'comment': this.onVoiceComment(ev); break
      case 'trans': this.onVoiceTranscribe(ev); break
      default: break
    }
  },

  onChipLongPress(e) {
    if (e.currentTarget.dataset.type !== 'play') return
    const d = e.currentTarget.dataset
    this.onVoiceDelete({ currentTarget: { dataset: { id: d.voice, item: d.item, path: d.path } } })
  },

  onChipsExpand(e) {
    const id = e.currentTarget.dataset.id
    const m = Object.assign({}, this.data.expanded)
    m[id] = true
    this.setData({ expanded: m })
  },

  onChipsCollapse(e) {
    const id = e.currentTarget.dataset.id
    const m = Object.assign({}, this.data.expanded)
    delete m[id]
    this.setData({ expanded: m })
  },

  // 播放/转文字等只改局部状态时，同步刷新小按钮图标（🔊 / 转文字中…）
  syncChips() {
    if (!this.data.ov) return
    this.setData({
      'ov.groups': decorateGroups(this.data.ov.groups, {
        role: this.data.role,
        playingId: this.data.playingId,
        transcribingId: this.data.transcribingId,
        likePopId: this.data.likePopId
      })
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
      this.syncChips()
      return
    }
    const self = this
    voice
      .play(path, function () {
        self.setData({ playingId: '' })
        self.syncChips()
      })
      .then((res) => {
        if (!res.ok) {
          this.setData({ playingId: '' })
          this.syncChips()
          wx.showToast({ title: res.error || '播放失败', icon: 'none' })
          return
        }
        self.setData({ playingId: id })
        self.syncChips()
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
      this.syncChips()
      setTimeout(() => {
        if (this.data.likePopId === voiceId) {
          this.setData({ likePopId: '' })
          this.syncChips()
        }
      }, 500)
    } else {
      wx.showToast({ title: '已取消赞（-1 分）', icon: 'none' })
    }
  }
})
