const store = require('../../utils/store')
const guard = require('../../utils/guard')

function statusText(s) {
  if (s === 'pending') return '等爸爸妈妈同意'
  if (s === 'approved') return '已同意，记得找爸爸妈妈要'
  if (s === 'fulfilled') return '已兑现'
  return '没有通过'
}

function wishStatusText(s) {
  if (s === 'pending') return '等爸爸妈妈看看'
  if (s === 'approved') return '爸爸妈妈同意啦，可以上架啦'
  if (s === 'rejected') return '这次没通过'
  return ''
}

Page({
  data: {
    role: 'child',
    ready: false,
    balance: 0,
    gifts: [],
    goal: null,
    records: [],
    pendingCount: 0,
    allGifts: []
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
    const balance = store.balance()
    if (role === 'child') {
      const gifts = store.listGifts().map(function (g) {
        const gap = Math.max(0, g.cost - balance)
        return Object.assign({}, g, {
          canBuy: balance >= g.cost,
          gap: gap,
          stateText: balance >= g.cost ? '可以换' : '还差 ' + gap + ' 分',
          percent: g.cost > 0 ? Math.min(100, Math.round((balance / g.cost) * 100)) : 100
        })
      })
      const locked = gifts.filter(function (g) {
        return !g.canBuy
      })
      locked.sort(function (a, b) {
        return a.gap - b.gap
      })
      let goal = null
      if (locked.length) {
        goal = locked[0]
      } else if (gifts.length) {
        goal = { name: '全部礼物都换得起啦', gap: 0, icon: '🌟', percent: 100 }
      }
      const records = store.listRedemptions().slice(0, 5).map(function (r) {
        return Object.assign({}, r, { statusText: statusText(r.status) })
      })
      const wishes = store.listWishes().slice(0, 6).map(function (w) {
        return Object.assign({}, w, { statusText: wishStatusText(w.status) })
      })
      this.setData({ balance, gifts, goal, records, wishes, role, ready: true })
    } else {
      const allGifts = store.listAllGifts()
      const pendingCount = store.listRedemptions().filter(function (r) {
        return r.status === 'pending'
      }).length
      this.setData({ balance, allGifts, pendingCount, role, ready: true })
    }
  },

  onGift(e) {
    if (this.data.role !== 'child') return
    const id = e.currentTarget.dataset.id
    const gift = this.data.gifts.filter(function (g) {
      return g.id === id
    })[0]
    if (!gift) return
    if (!gift.canBuy) {
      wx.showToast({ title: '还差 ' + gift.gap + ' 分', icon: 'none' })
      return
    }
    wx.showModal({
      title: '兑换「' + gift.name + '」',
      content: '需要 ' + gift.cost + ' 分，你现在有 ' + this.data.balance + ' 分。提交后等爸爸妈妈同意。',
      confirmText: '提交',
      confirmColor: '#F5A65B',
      success: async (r) => {
        if (!r.confirm) return
        if (this.busy) return
        this.busy = true
        const res = await store.requestRedeem(gift.id)
        this.busy = false
        this.refresh()
        if (!res.ok) {
          wx.showToast({ title: res.error || '提交失败', icon: 'none' })
          return
        }
        wx.showToast({ title: '已提交，等爸爸妈妈同意', icon: 'none' })
      }
    })
  },

  onAddWish() {
    wx.showModal({
      title: '许个心愿',
      editable: true,
      placeholderText: '想要什么？比如 一套漫画书',
      confirmText: '下一步',
      success: (r) => {
        if (!r.confirm) return
        const title = (r.content || '').trim()
        if (!title) {
          wx.showToast({ title: '先写个心愿吧', icon: 'none' })
          return
        }
        wx.showModal({
          title: '说说为什么想要',
          editable: true,
          placeholderText: '可以不填，比如 最近特别爱看漫画',
          confirmText: '许下心愿',
          success: async (r2) => {
            if (!r2.confirm) return
            const res = await store.addWish(title, (r2.content || '').trim())
            this.refresh()
            if (!res.ok) {
              wx.showToast({ title: res.error || '没提交上', icon: 'none' })
              return
            }
            wx.showToast({ title: '心愿许好了，等爸爸妈妈看看', icon: 'none' })
          }
        })
      }
    })
  },

  goApprove() {
    wx.navigateTo({ url: '/pages/parent-approve/parent-approve' })
  },

  onAddGift() {
    wx.showModal({
      title: '加一个礼物',
      editable: true,
      placeholderText: '礼物名称，比如 一次动物园',
      success: (r) => {
        if (!r.confirm) return
        const name = (r.content || '').trim()
        if (!name) return
        wx.showModal({
          title: '需要多少积分',
          editable: true,
          placeholderText: '比如 300',
          success: async (r2) => {
            if (!r2.confirm) return
            const cost = Number((r2.content || '').trim())
            if (!cost || cost <= 0) {
              wx.showToast({ title: '请输入一个大于 0 的分数', icon: 'none' })
              return
            }
            const res = await store.addGift(name, '🎁', cost)
            this.refresh()
            if (!res.ok) wx.showToast({ title: res.error || '没保存上', icon: 'none' })
          }
        })
      }
    })
  },

  onGiftMore(e) {
    const id = e.currentTarget.dataset.id
    const gift = this.data.allGifts.filter(function (g) {
      return g.id === id
    })[0]
    if (!gift) return
    const actions = ['修改所需积分', gift.active ? '下架' : '重新上架', '删除']
    wx.showActionSheet({
      itemList: actions,
      success: (r) => {
        if (r.tapIndex === 0) {
          wx.showModal({
            title: '修改所需积分',
            editable: true,
            placeholderText: '当前 ' + gift.cost + ' 分',
            success: async (m) => {
              if (!m.confirm) return
              const cost = Number((m.content || '').trim())
              if (!cost || cost <= 0) return
              const res = await store.updateGift(id, { cost: cost })
              this.refresh()
              if (!res.ok) wx.showToast({ title: res.error || '没保存上', icon: 'none' })
            }
          })
        } else if (r.tapIndex === 1) {
          store.updateGift(id, { active: !gift.active }).then((res) => {
            this.refresh()
            if (!res.ok) wx.showToast({ title: res.error || '没保存上', icon: 'none' })
          })
        } else if (r.tapIndex === 2) {
          wx.showModal({
            title: '删除「' + gift.name + '」',
            content: '删除后孩子就看不到了，已经兑换过的记录会保留。',
            confirmText: '删除',
            confirmColor: '#E4736B',
            success: async (m) => {
              if (!m.confirm) return
              const res = await store.removeGift(id)
              this.refresh()
              if (!res.ok) wx.showToast({ title: res.error || '没保存上', icon: 'none' })
            }
          })
        }
      }
    })
  },

  async onFulfill(e) {
    const id = e.currentTarget.dataset.id
    const res = await store.fulfillRedeem(id)
    this.refresh()
    if (!res.ok) wx.showToast({ title: res.error || '没保存上', icon: 'none' })
  }
})
