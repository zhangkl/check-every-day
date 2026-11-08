const store = require('../../utils/store')
const guard = require('../../utils/guard')
const dateUtil = require('../../utils/date')

const STATUS = {
  pending: '等处理',
  approved: '已同意，待兑现',
  rejected: '未通过',
  fulfilled: '已兑现'
}

Page({
  data: {
    pending: [],
    done: [],
    pendingWishes: [],
    doneWishes: [],
    balance: 0,
    childName: ''
  },

  async onShow() {
    const ok = await guard.ensureReady()
    if (!ok) return
    if (store.getRole() !== 'parent') {
      wx.showToast({ title: '仅家长可审批', icon: 'none' })
      wx.navigateBack()
      return
    }
    this.refresh()
  },

  refresh() {
    if (!store.isSetup()) return
    const all = store.listRedemptions()
    const decorate = function (r) {
      return Object.assign({}, r, {
        statusText: STATUS[r.status] || '',
        date: dateUtil.pretty(dateUtil.key(new Date(r.createdAt)))
      })
    }
    const WISH_STATUS = {
      pending: '等处理',
      approved: '已同意',
      rejected: '未通过'
    }
    const decorateWish = function (w) {
      return Object.assign({}, w, {
        statusText: WISH_STATUS[w.status] || '',
        date: dateUtil.pretty(dateUtil.key(new Date(w.at)))
      })
    }
    const wishes = store.listWishes()
    this.setData({
      pending: all.filter(function (r) { return r.status === 'pending' }).map(decorate),
      done: all.filter(function (r) { return r.status !== 'pending' }).slice(0, 20).map(decorate),
      pendingWishes: wishes.filter(function (w) { return w.status === 'pending' }).map(decorateWish),
      doneWishes: wishes.filter(function (w) { return w.status !== 'pending' }).slice(0, 10).map(decorateWish),
      balance: store.balance(),
      childName: store.getFamily().childName
    })
  },

  async onApprove(e) {
    const id = e.currentTarget.dataset.id
    if (this.busy) return
    this.busy = true
    const res = await store.decideRedeem(id, true)
    this.busy = false
    this.refresh()
    if (!res.ok) {
      wx.showToast({ title: res.error || '操作失败', icon: 'none' })
      return
    }
    wx.showToast({ title: '已同意，积分已扣', icon: 'none' })
  },

  onReject(e) {
    const id = e.currentTarget.dataset.id
    wx.showModal({
      title: '不通过这件兑换',
      content: '拒绝后不会扣积分，孩子那边会看到「没有通过」。',
      confirmText: '拒绝',
      confirmColor: '#E4736B',
      success: async (m) => {
        if (!m.confirm) return
        const res = await store.decideRedeem(id, false)
        this.refresh()
        if (!res.ok) {
          wx.showToast({ title: res.error || '操作失败', icon: 'none' })
          return
        }
        wx.showToast({ title: '已拒绝', icon: 'none' })
      }
    })
  },

  onWishApprove(e) {
    const id = e.currentTarget.dataset.id
    const w = this.data.pendingWishes.filter(function (x) { return x.id === id })[0]
    if (!w) return
    wx.showModal({
      title: '同意「' + w.title + '」',
      editable: true,
      placeholderText: '上架礼物需要多少积分？比如 300',
      content: '填了积分会立刻把这份礼物上架到商城；留空则只表示同意。',
      confirmText: '同意',
      success: async (m) => {
        if (!m.confirm) return
        const cost = Number((m.content || '').trim())
        if (m.content && m.content.trim() && (!cost || cost <= 0)) {
          wx.showToast({ title: '积分要填大于 0 的数字', icon: 'none' })
          return
        }
        if (this.busy) return
        this.busy = true
        const res = await store.decideWish(id, true)
        if (res.ok && cost > 0) {
          await store.addGift(w.title, '🌟', cost, true)
        }
        this.busy = false
        this.refresh()
        if (!res.ok) {
          wx.showToast({ title: res.error || '操作失败', icon: 'none' })
          return
        }
        wx.showToast({
          title: cost > 0 ? '已同意并上架礼物' : '已同意，礼物记得去上架',
          icon: 'none'
        })
      }
    })
  },

  onWishReject(e) {
    const id = e.currentTarget.dataset.id
    wx.showModal({
      title: '这个心愿先不通过',
      content: '孩子那边会看到「这次没通过」。可以以后再一起商量。',
      confirmText: '不通过',
      confirmColor: '#E4736B',
      success: async (m) => {
        if (!m.confirm) return
        const res = await store.decideWish(id, false)
        this.refresh()
        if (!res.ok) {
          wx.showToast({ title: res.error || '操作失败', icon: 'none' })
          return
        }
        wx.showToast({ title: '已拒绝', icon: 'none' })
      }
    })
  },

  async onFulfill(e) {
    const id = e.currentTarget.dataset.id
    const res = await store.fulfillRedeem(id)
    this.refresh()
    if (!res.ok) {
      wx.showToast({ title: res.error || '操作失败', icon: 'none' })
      return
    }
    wx.showToast({ title: '已标记兑现', icon: 'none' })
  }
})
