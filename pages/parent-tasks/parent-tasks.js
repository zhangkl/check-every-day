const store = require('../../utils/store')
const guard = require('../../utils/guard')

const EMOJIS = ['📚', '📖', '✏️', '🎒', '🌱', '🎹', '🏃', '🧹', '🎨', '🧮', '🗣', '💤']
const DAY_LABELS = ['一', '二', '三', '四', '五', '六', '日']

function repeatLabel(days) {
  if (days.length === 7) return '每天'
  if (days.length === 0) return '未选日期'
  if (days.length === 5 && days.join(',') === '1,2,3,4,5') return '周一到周五'
  return '周' + days.map(function (d) { return DAY_LABELS[d - 1] }).join('')
}

Page({
  data: {
    groups: [],
    openKey: '',
    editingKey: '',
    form: { title: '', icon: '', days: [] },
    emojis: EMOJIS,
    dayLabels: DAY_LABELS,
    extraTitle: '',
    extraPoints: ''
  },

  async onShow() {
    const ok = await guard.ensureReady()
    if (!ok) return
    if (store.getRole() !== 'parent') {
      wx.showToast({ title: '仅家长可配置', icon: 'none' })
      wx.navigateBack()
      return
    }
    this.refresh()
  },

  refresh() {
    if (!store.isSetup()) return
    const groups = store.listTaskGroups().map(function (g) {
      const days = [1, 2, 3, 4, 5, 6, 7].map(function (d) {
        return g.repeatDays.indexOf(d) >= 0
      })
      return Object.assign({}, g, {
        days: days,
        repeatLabel: repeatLabel(g.repeatDays)
      })
    })
    this.setData({ groups })
  },

  fail(res) {
    if (res && res.ok === false) {
      wx.showToast({ title: res.error || '没保存上', icon: 'none' })
      return true
    }
    return false
  },

  toggleOpen(e) {
    const key = e.currentTarget.dataset.key
    this.setData({
      openKey: this.data.openKey === key ? '' : key,
      editingKey: ''
    })
  },

  onEditGroup(e) {
    const key = e.currentTarget.dataset.key
    const g = this.data.groups.filter(function (x) {
      return x.groupKey === key
    })[0]
    if (!g) return
    this.setData({
      editingKey: key,
      openKey: key,
      form: {
        title: g.title,
        icon: g.icon,
        days: g.days.slice()
      }
    })
  },

  onFormTitle(e) {
    this.setData({ 'form.title': e.detail.value })
  },

  pickEmoji(e) {
    this.setData({ 'form.icon': e.currentTarget.dataset.emoji })
  },

  toggleDay(e) {
    const idx = Number(e.currentTarget.dataset.index)
    const days = this.data.form.days.slice()
    days[idx] = !days[idx]
    this.setData({ 'form.days': days })
  },

  async onSaveGroup() {
    const key = this.data.editingKey
    const form = this.data.form
    if (!key) return
    if (!(form.title || '').trim()) {
      wx.showToast({ title: '名称不能为空', icon: 'none' })
      return
    }
    const repeatDays = []
    form.days.forEach(function (on, i) {
      if (on) repeatDays.push(i + 1)
    })
    if (repeatDays.length === 0) {
      wx.showToast({ title: '至少选一天', icon: 'none' })
      return
    }
    if (this.busy) return
    this.busy = true
    const res = await store.updateGroup(key, {
      title: form.title.trim(),
      icon: form.icon,
      repeatDays: repeatDays
    })
    this.busy = false
    if (this.fail(res)) return
    this.setData({ editingKey: '' })
    this.refresh()
    wx.showToast({ title: '已保存，明天生效', icon: 'none' })
  },

  onCancelEdit() {
    this.setData({ editingKey: '' })
  },

  async onToggleActive(e) {
    const key = e.currentTarget.dataset.key
    const g = this.data.groups.filter(function (x) {
      return x.groupKey === key
    })[0]
    if (!g) return
    const res = await store.updateGroup(key, { active: !g.active })
    this.refresh()
    this.fail(res)
  },

  onAddGroup() {
    wx.showModal({
      title: '新增大项',
      editable: true,
      placeholderText: '比如 钢琴练习',
      success: async (r) => {
        if (!r.confirm) return
        const title = (r.content || '').trim()
        if (!title) return
        const res = await store.addGroup(title, '📌')
        this.refresh()
        if (this.fail(res)) return
        this.setData({ openKey: res.groupKey })
        wx.showToast({ title: '已添加，记得加子项', icon: 'none' })
      }
    })
  },

  onAddChild(e) {
    const key = e.currentTarget.dataset.key
    wx.showModal({
      title: '新增子项',
      editable: true,
      placeholderText: '比如 音阶练习',
      success: (r) => {
        if (!r.confirm) return
        const title = (r.content || '').trim()
        if (!title) return
        wx.showModal({
          title: '这一项多少分',
          editable: true,
          placeholderText: '比如 5',
          success: async (r2) => {
            if (!r2.confirm) return
            const points = Number((r2.content || '').trim()) || 5
            const res = await store.addChild(key, title, points)
            this.refresh()
            this.fail(res)
          }
        })
      }
    })
  },

  onEditChild(e) {
    const id = e.currentTarget.dataset.id
    const gKey = e.currentTarget.dataset.key
    const g = this.data.groups.filter(function (x) {
      return x.groupKey === gKey
    })[0]
    const child = g ? g.children.filter(function (c) { return c.id === id })[0] : null
    if (!child) return
    wx.showActionSheet({
      itemList: ['改名称', '改分值', '删除这一项'],
      success: (r) => {
        if (r.tapIndex === 0) {
          wx.showModal({
            title: '改名称',
            editable: true,
            content: child.title,
            success: async (m) => {
              if (!m.confirm) return
              const t = (m.content || '').trim()
              if (!t) return
              const res = await store.updateChild(id, { title: t })
              this.refresh()
              this.fail(res)
            }
          })
        } else if (r.tapIndex === 1) {
          wx.showModal({
            title: '改分值',
            editable: true,
            content: String(child.points),
            success: async (m) => {
              if (!m.confirm) return
              const p = Number((m.content || '').trim())
              if (!p || p <= 0) return
              const res = await store.updateChild(id, { points: p })
              this.refresh()
              this.fail(res)
            }
          })
        } else if (r.tapIndex === 2) {
          store.removeChild(id).then((res) => {
            this.refresh()
            this.fail(res)
          })
        }
      }
    })
  },

  onDeleteGroup(e) {
    const key = e.currentTarget.dataset.key
    const g = this.data.groups.filter(function (x) {
      return x.groupKey === key
    })[0]
    if (!g) return
    wx.showModal({
      title: '删除「' + g.title + '」',
      content: '这一项和它下面的 ' + g.children.length + ' 个子项都会从清单里去掉。历史打卡记录保留。',
      confirmText: '删除',
      confirmColor: '#E4736B',
      success: async (r) => {
        if (!r.confirm) return
        const res = await store.removeGroup(key)
        this.refresh()
        this.fail(res)
      }
    })
  },

  onExtraTitle(e) {
    this.setData({ extraTitle: e.detail.value })
  },

  onExtraPoints(e) {
    this.setData({ extraPoints: e.detail.value })
  },

  async onAddExtra() {
    const title = (this.data.extraTitle || '').trim()
    if (!title) {
      wx.showToast({ title: '先写一项内容', icon: 'none' })
      return
    }
    if (this.busy) return
    this.busy = true
    const points = Number(this.data.extraPoints) || 5
    const res = await store.addExtraToday(title, points)
    this.busy = false
    if (this.fail(res)) return
    this.setData({ extraTitle: '', extraPoints: '' })
    wx.showToast({ title: '已加进今天的清单', icon: 'none' })
  }
})
