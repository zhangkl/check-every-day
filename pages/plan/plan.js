const store = require('../../utils/store')
const guard = require('../../utils/guard')
const dateUtil = require('../../utils/date')

function buildCells(monthKeyStr) {
  const days = store.calendar(monthKeyStr)
  const cells = []
  if (days.length) {
    const offset = days[0].weekday - 1
    for (let i = 0; i < offset; i += 1) {
      cells.push({ empty: true, id: 'e' + i })
    }
    days.forEach(function (d) {
      cells.push({
        empty: false,
        id: d.key,
        day: d.day,
        level: d.level,
        isToday: d.isToday
      })
    })
  }
  return cells
}

Page({
  data: {
    role: 'child',
    ready: false,
    weekNames: ['一', '二', '三', '四', '五', '六', '日'],
    title: null,
    streak: 0,
    maxStreak: 0,
    balance: 0,
    earned: 0,
    spent: 0,
    monthLabel: '',
    cells: [],
    coupon: null,
    canUseCoupon: false,
    couponDay: '',
    week: [],
    stats: [],
    avgPercent: 0,
    weekTotal: 0,
    weekDone: 0
  },

  async onShow() {
    const ok = await guard.ensureReady()
    if (!ok) return
    const role = store.getRole()
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
    const role = store.getRole()
    const earned = store.earnedTotal()
    const patch = {
      role,
      balance: store.balance(),
      earned: earned,
      spent: store.spentTotal(),
      streak: store.streak(),
      ready: true
    }

    if (role === 'child') {
      const t = dateUtil.today()
      const month = dateUtil.monthKey(t)
      const parts = month.split('-')
      patch.monthLabel = parts[0] + ' 年 ' + Number(parts[1]) + ' 月'
      patch.cells = buildCells(month)
      patch.title = store.titleOf(earned)
      const state = store.getSheet(t) ? true : false
      const yesterday = dateUtil.addDays(t, -1)
      const ySheet = store.getSheet(yesterday)
      const yDone =
        ySheet && ySheet.items.length > 0 && ySheet.items.every(function (i) { return i.done })
      const c = store.couponStatus()
      patch.coupon = c
      patch.canUseCoupon = !c.used && !!ySheet && !yDone
      patch.couponDay = yesterday
      patch.hasToday = state
    } else {
      const week = store.recentDays(7)
      let total = 0
      let done = 0
      week.forEach(function (d) {
        total += d.total
        done += d.done
      })
      patch.week = week
      patch.weekTotal = total
      patch.weekDone = done
      patch.avgPercent = total ? Math.round((done / total) * 100) : 0
      patch.stats = store.itemStats(14).slice(0, 6)
    }

    this.setData(patch)
  },

  onUseCoupon() {
    const day = this.data.couponDay
    if (!day) return
    wx.showModal({
      title: '用掉这个月的护身符',
      content: dateUtil.pretty(day) + ' 就算作完成，连击不会被中断。每月只有一次。',
      confirmText: '使用',
      confirmColor: '#EE8BA0',
      success: async (r) => {
        if (!r.confirm) return
        const res = await store.useCoupon(day)
        this.refresh()
        if (!res.ok) {
          wx.showToast({ title: res.error || '没保存上', icon: 'none' })
          return
        }
        wx.showToast({ title: '护身符已使用', icon: 'none' })
      }
    })
  }
})
