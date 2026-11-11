const store = require('../../utils/store')
const guard = require('../../utils/guard')
const dateUtil = require('../../utils/date')

// 消息类型 → 小图标（保持淡，不做强提醒）
const NOTICE_ICONS = {
  like: '👍', comment: '💬', comment_delete: '🗑',
  note: '📝', note_pin: '📢', note_delete: '🗑',
  extra_apply: '➕', extra_ok: '✅', extra_no: '🚫', extra_points: '🎯',
  del_apply: '🗑', del_ok: '✅', del_no: '🚫', task_delete: '🗑',
  revoke: '↩️', adjust: '🎯',
  wish_apply: '⭐', wish_ok: '🌟', wish_no: '🚫',
  redeem_apply: '🎁', redeem_ok: '🎁', redeem_no: '🚫', redeem_done: '🎉'
}

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

Page({
  data: {
    tab: 'mine',
    notices: [],
    activities: [],
    unread: 0,
    ready: false
  },

  onLoad(options) {
    if (options && options.tab === 'all') this.setData({ tab: 'all' })
  },

  async onShow() {
    const ok = await guard.ensureReady()
    if (!ok) return
    this.load()
    // 看「与我相关」就算已读；直接进「全部动态」不消耗未读
    if (this.data.tab === 'mine' && store.unreadNoticeCount() > 0) {
      store.markNoticesRead().then(() => this.load()).catch(() => {})
    }
  },

  load() {
    const f = store.feed(200)
    const notices = f.notices.map(function (n) {
      return {
        id: n.id,
        icon: NOTICE_ICONS[n.kind] || '🔔',
        text: n.text,
        fromName: n.fromName,
        unread: n.unread,
        when: fmtWhen(n.at),
        refType: n.ref && n.ref.type ? n.ref.type : ''
      }
    })
    const activities = f.activities.map(function (a) {
      const at = a.at || Date.now()
      return {
        id: a.id,
        who: a.uid ? store.labelFor(a.uid, a.role || 'child') : '早期记录',
        isParent: a.role === 'parent',
        action: a.action,
        detail: a.detail,
        amountClass: !a.hasAmount ? 'none' : (a.amount >= 0 ? 'plus' : 'minus'),
        amountText: a.hasAmount ? (a.amount >= 0 ? '+' : '') + a.amount + ' 分' : '—',
        when: dateUtil.pretty(a.day || dateUtil.key(new Date(at))) + ' ' + dateUtil.timeHm(at)
      }
    })
    this.setData({
      notices: notices,
      activities: activities,
      unread: notices.filter(function (n) { return n.unread }).length,
      ready: true
    })
  },

  switchTab(e) {
    const tab = e.currentTarget.dataset.tab === 'all' ? 'all' : 'mine'
    if (tab === this.data.tab) return
    this.setData({ tab: tab })
    if (tab === 'mine' && store.unreadNoticeCount() > 0) {
      store.markNoticesRead().then(() => this.load()).catch(() => {})
    }
  },

  // 留言类消息点回首页的留言板；其余消息只做查看
  onItemTap(e) {
    if (e.currentTarget.dataset.type !== 'note') return
    const pages = getCurrentPages()
    const prev = pages.length > 1 ? pages[pages.length - 2] : null
    if (prev && typeof prev.openNoteSheet === 'function') prev.openNoteSheet()
    wx.navigateBack()
  }
})
