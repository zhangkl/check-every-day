// [历史遗留·默认跳过] 早期纯本地存储版单测，store 云同步改造后 setup() 等 API 已移除；需按新 API 重写。
// 本地逻辑自测：用内存 mock 替代 wx 存储
const mem = {}
global.wx = {
  getStorageSync(k) {
    return mem[k] === undefined ? '' : mem[k]
  },
  setStorageSync(k, v) {
    mem[k] = JSON.parse(JSON.stringify(v))
  },
  removeStorageSync(k) {
    delete mem[k]
  }
}

const path = require('path')
const ROOT = path.resolve(__dirname, '..')
const store = require(path.join(ROOT, 'utils/store.js'))
const dateUtil = require(path.join(ROOT, 'utils/date.js'))

function assert(cond, msg) {
  if (!cond) {
    console.error('FAIL: ' + msg)
    process.exitCode = 1
  } else {
    console.log('ok   ' + msg)
  }
}

assert(store.isSetup() === false, '初始未初始化')

store.setup('朵朵家', '朵朵')
assert(store.isSetup() === true, 'setup 完成')
assert(store.getRole() === 'parent', '初始化后默认家长端')

const ov0 = store.todayOverview()
assert(ov0.total === 11, '默认清单 11 个子项，实际 ' + ov0.total)
assert(ov0.remain === 48, '一天满分 48，实际 ' + ov0.remain)
assert(ov0.groups.length === 4, '默认 4 个大项（其它补充为空时不显示），实际 ' + ov0.groups.length)
assert(store.balance() === 0, '初始积分 0')

// 逐个勾完
const sheet = store.getSheet(dateUtil.today())
const ids = sheet.items.map((i) => i.id)
ids.forEach((id, idx) => {
  const res = store.toggleItem(dateUtil.today(), id)
  assert(res.ok, '勾选第 ' + (idx + 1) + ' 项')
})

const ov1 = store.todayOverview()
assert(ov1.done === 11, '11 项全部完成，实际 ' + ov1.done)
assert(ov1.percent === 100, '完成率 100%')
assert(store.balance() === 58, '48 分 + 满勤奖 10 = 58，实际 ' + store.balance())
assert(store.streak() === 1, '连续 1 天，实际 ' + store.streak())

// 重复勾选不再加分
const again = store.toggleItem(dateUtil.today(), ids[0])
assert(again.done === false && again.change < 0, '取消勾选会扣回分')
const redo = store.toggleItem(dateUtil.today(), ids[0])
assert(redo.done === true, '重新勾上恢复')
assert(store.balance() === 58, '反复勾选后积分仍为 58，实际 ' + store.balance())

// 家长撤销
store.revokeItem(dateUtil.today(), ids[1])
assert(!store.getSheet(dateUtil.today()).items[1].done, '撤销后该项回到未完成')
assert(store.balance() === 58 - 7 - 10, '撤销扣回 7 分并连带扣回满勤奖 10，实际 ' + store.balance())

// 兑换流程
const gifts = store.listGifts()
assert(gifts.length === 6, '默认 6 件礼物')
const cheap = gifts[0]
assert(cheap.cost === 80, '最便宜礼物 80 分')
store.adjustPoints(100, '家长额外奖励')
const before = store.balance()
assert(before === 141, '手动加分后余额 141，实际 ' + before)
const req = store.requestRedeem(cheap.id)
assert(req.ok, '积分足够时提交兑换')
assert(store.balance() === before, '提交申请不扣分')
const dup = store.requestRedeem(cheap.id)
assert(!dup.ok, '同一件礼物不能重复申请')
const pendingList = store.listRedemptions().filter((r) => r.status === 'pending')
assert(pendingList.length === 1, '有 1 条待审批')
store.decideRedeem(pendingList[0].id, true)
assert(store.balance() === before - 80, '审批通过后扣 80 分，实际 ' + store.balance())

// 余额不足时不能申请
const expensive = store.listGifts().filter((g) => g.cost > store.balance())[0]
if (expensive) {
  const r = store.requestRedeem(expensive.id)
  assert(!r.ok, '余额不足时拒绝申请')
}

// 临时加项
store.addExtraToday('明天带美术材料', 5)
const ov2 = store.todayOverview()
assert(ov2.total === 12, '临时加项后 12 项，实际 ' + ov2.total)
assert(ov2.groups.length === 5, '出现「其它补充」大项')

// 清单配置
const groups = store.listTaskGroups()
assert(groups.length === 5, '模板里有 5 个大项（含其它补充），实际 ' + groups.length)
const key = groups[0].groupKey
store.updateGroup(key, { repeatDays: [1, 2, 3, 4, 5] })
const g2 = store.listTaskGroups().filter((g) => g.groupKey === key)[0]
assert(g2.repeatDays.length === 5, '改成周一到周五')
store.addChild(key, '朗读', 4)
assert(
  store.listTaskGroups().filter((g) => g.groupKey === key)[0].children.length === 4,
  '新增大项子项成功'
)

// 护身符
const c1 = store.couponStatus()
assert(c1.used === false, '本月护身符未使用')
const y = dateUtil.addDays(dateUtil.today(), -1)
store.useCoupon(y)
assert(store.couponStatus().used === true, '护身符已使用')
const c2 = store.useCoupon(dateUtil.addDays(dateUtil.today(), -2))
assert(!c2.ok, '同一月不能再用第二次')

// 报表
const week = store.recentDays(7)
assert(week.length === 7, '近 7 天数据')
const stats = store.itemStats(14)
assert(stats.length > 0, '有各项完成率数据')
const cal = store.calendar(dateUtil.monthKey(dateUtil.today()))
assert(cal.length >= 28, '日历天数为当月天数，实际 ' + cal.length)

console.log('\n积分流水条数：' + store.logs().length)
console.log('当前余额：' + store.balance())
