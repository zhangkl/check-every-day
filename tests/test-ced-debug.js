/* 云接入自测：用内存假云（PostgREST 语义 + RLS + rev 乐观锁）跑完整业务流 */
const path = require('path')
const Module = require('module')

const ROOT = path.resolve(__dirname, '..')
const ORIGINAL_LOAD = Module._load

/* ---------------- 假存储 ---------------- */
const storage = {}
global.wx = {
  getStorageSync(k) { return storage[k] === undefined ? '' : storage[k] },
  setStorageSync(k, v) { storage[k] = JSON.parse(JSON.stringify(v)) },
  removeStorageSync(k) { delete storage[k] },
  login(opts) { opts.success({ code: 'fake-code' }) },
  getAccountInfoSync() { return { miniProgram: { appId: 'wxtestappid' } } }
}

/* ---------------- 假云数据库 ---------------- */
const db = {
  families: [],
  members: [],
  seq: 0,
  injectConflictOnce: false,
  failNextWrite: false,
  uid: () => db.session && db.session.user.id
}

function clone(v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)) }

class Builder {
  constructor(table, op, payload) {
    this.table = table
    this.op = op
    this.payload = payload
    this.filters = []
    this.cols = '*'
    this.isSingle = false
    this.limitN = null
  }
  select(cols) { this.cols = cols || '*'; this.wantRows = true; return this }
  eq(col, val) { this.filters.push([col, val]); return this }
  limit(n) { this.limitN = n; return this }
  single() { this.isSingle = true; return this }
  maybeSingle() { this.isSingle = true; return this }
  then(res, rej) { return this.run().then(res, rej) }

  visible(row) {
    const uid = db.uid()
    if (this.table === 'ced_members') return row.owner_id === uid
    const mine = db.members.filter(m => m.owner_id === uid).map(m => String(m.family_id))
    return row.owner_id === uid || mine.indexOf(String(row.id)) >= 0
  }
  match(row) {
    return this.filters.every(([c, v]) => String(row[c]) === String(v))
  }
  shape(row) {
    if (!row) return null
    if (this.cols === '*') return clone(row)
    const out = {}
    this.cols.split(',').forEach(c => { out[c.trim()] = clone(row[c.trim()]) })
    return out
  }

  async run() {
    if (this.op === 'select') {
      const rows = db[this.table === 'ced_families' ? 'families' : 'members']
        .filter(r => this.visible(r) && this.match(r))
      if (this.isSingle) {
        if (rows.length !== 1) return { data: null, error: { code: 'PGRST116', message: 'exactly one row expected' } }
        return { data: this.shape(rows[0]), error: null }
      }
      const sliced = this.limitN ? rows.slice(0, this.limitN) : rows
      return { data: sliced.map(r => this.shape(r)), error: null }
    }

    if (this.op === 'insert') {
      const uid = db.uid()
      if (this.table === 'ced_families') {
        if (db.families.some(f => f.invite_code === this.payload.invite_code)) {
          return { data: null, error: { code: '23505', message: 'duplicate key value' } }
        }
        db.seq += 1
        const row = Object.assign({ id: db.seq, owner_id: uid, rev: 1 }, clone(this.payload))
        db.families.push(row)
        return { data: [this.shape(row)], error: null }
      }
      db.seq += 1
      const row = Object.assign({ id: db.seq, owner_id: uid }, clone(this.payload))
      if (db.members.some(m => m.family_id === row.family_id && m.owner_id === row.owner_id)) {
        return { data: null, error: { code: '23505', message: 'duplicate key value' } }
      }
      db.members.push(row)
      return { data: [this.shape(row)], error: null }
    }

    if (this.op === 'update') {
      if (db.failNextWrite) {
        db.failNextWrite = false
        return { data: null, error: { code: '', message: 'network request failed' } }
      }
      if (db.injectConflictOnce) {
        db.injectConflictOnce = false
        const row = db.families[0]
        row.doc = clone(row.doc)
        row.doc.family = { name: '并发改的名字', childName: '朵朵' }
        row.rev += 1
      }
      const rows = db.families.filter(r => this.visible(r) && this.match(r))
      rows.forEach(r => Object.assign(r, clone(this.payload)))
      return { data: rows.map(r => this.shape(r)), error: null }
    }

    return { data: null, error: { message: 'unsupported' } }
  }
}

const fakeCloud = {
  auth: {
    async getSession() {
      return db.session ? { data: { user: db.session.user }, error: null } : { data: null, error: null }
    },
    async signInWithWechat(code, appid) {
      db.session = { user: { id: 'u-child', name: '朵朵' } }
      return { data: { user: db.session.user }, error: null }
    },
    async sendOtp() { return { data: { verificationId: 'v1', isExistingUser: false }, error: null } },
    async verifyOtp() { db.session = { user: { id: 'u-email', name: 'parent@example.com' } }; return { data: { user: db.session.user }, error: null } },
    async signOut() { db.session = null; return { error: null } }
  },
  database: {
    from(table) {
      const b = new Builder(table, 'select')
      b.wantRows = false
      return b
    },
    rpc(name, params) {
      if (name !== 'ced_join_family') throw new Error('unknown rpc ' + name)
      const code = String(params.p_code || '').toUpperCase()
      const fam = db.families.filter(f => f.invite_code === code || f.parent_invite_code === code)[0]
      if (!fam) {
        return Promise.resolve({ data: null, error: { code: 'P0002', message: 'CODE_NOT_FOUND' } })
      }
      const uid = db.uid()
      const mine = db.members.filter(m => m.family_id === fam.id && m.owner_id === uid)[0]
      let role
      if (mine) {
        role = mine.member_role
      } else {
        role = fam.parent_invite_code === code ? 'parent' : (String(params.p_role || 'child') === 'parent' ? 'parent' : 'child')
        const pin = fam.doc && fam.doc.parentPin
        if (role === 'parent' && fam.parent_invite_code !== code && pin && String(params.p_pin || '') !== String(pin)) {
          return Promise.resolve({ data: null, error: { code: 'P0002', message: 'PIN_REQUIRED' } })
        }
        db.seq += 1
        db.members.push({ id: db.seq, family_id: fam.id, owner_id: uid, member_role: role })
      }
      return Promise.resolve({
        data: [{ out_family_id: fam.id, out_family_name: (fam.doc.family || {}).name || '我们家', out_role: role }],
        error: null
      })
    }
  }
}

// 让 from().insert()/update() 可用
const originalFrom = fakeCloud.database.from
fakeCloud.database.from = function (table) {
  const b = originalFrom.call(this, table)
  b.insert = function (payload) { return new Builder(table, 'insert', payload) }
  b.update = function (payload) { return new Builder(table, 'update', payload) }
  b.delete = function () { return new Builder(table, 'delete') }
  return b
}

/* ---------------- 模块拦截 ---------------- */
Module._load = function (request, parent, isMain) {
  if (request === '@tencent-ai/workbuddy-cloud-sdk/miniprogram') {
    return { createMiniProgramWorkBuddyCloud: () => fakeCloud }
  }
  if (request === './workbuddy-cloud-diagnostics') {
    return { createDiagnosticWx: (wx) => wx }
  }
  return ORIGINAL_LOAD.apply(this, arguments)
}

function freshStore() {
  Object.keys(require.cache).forEach(k => {
    if (k.indexOf(path.join(ROOT, 'utils')) === 0) delete require.cache[k]
  })
  return require(path.join(ROOT, 'utils/store.js'))
}

/* ---------------- 断言 ---------------- */
let pass = 0
const fails = []
function ok(cond, label) {
  if (cond) { pass += 1; return }
  fails.push(label)
  console.log('  ✗ ' + label)
}
function eq(actual, expected, label) {
  ok(actual === expected, label + '（期望 ' + expected + '，实际 ' + actual + '）')
}

async function main() {
  /* 1. 未登录 */
  let store = freshStore()
  let boot = await store.bootstrap()
  ok(boot.needLogin, '未登录时进入登录页')
  ok(store.isSetup() === false, '未登录时没有家庭数据')

  /* 2. 邮箱登录 */
  const pending = await store.sendEmailCode('parent@example.com')
  ok(pending.ok, '邮箱验证码发送成功')
  const verified = await store.verifyEmailCode(pending, '123456')
  ok(verified.ok, '邮箱验证码登录成功')

  boot = await store.bootstrap()
  ok(boot.needSetup, '已登录但没有家庭 → 进入创建/加入页')

  /* 3. 创建家庭 */
  const created = await store.createFamily('朵朵家', '朵朵')
  ok(created.ok, '创建家庭成功')
  eq(String(created.inviteCode).length, 6, '邀请码 6 位')
  ok(store.isSetup(), '创建后进入已配置状态')
  eq(store.getRole(), 'parent', '创建者是家长')
  eq(db.families.length, 1, '云端存在 1 个家庭')
  eq(db.members.length, 1, '云端存在 1 条成员记录')
  ok(!('owner_id' in (db.families[0].doc || {})), '文档里不含 owner_id')

  /* 4. 模板与分值 */
  const ov = store.todayOverview()
  eq(ov.total, 11, '默认 11 个子项')
  eq(ov.remain, 48, '一天满额 48 分')
  eq(store.listGifts().length, 6, '默认 6 件礼物')
  eq(store.listGifts()[0].cost, 80, '最便宜礼物 80 分')

  /* 5. 勾选并写回云端 */
  const firstItem = ov.groups[0].items[0]
  const t1 = await store.toggleItem(ov.day, firstItem.id)
  ok(t1.ok && t1.done, '勾选成功')
  eq(store.balance(), firstItem.points, '勾选后余额等于该项分值')
  const remoteDoc = db.families[0].doc
  const remoteSheet = remoteDoc.sheets[ov.day]
  ok(!!remoteSheet, '当天清单已写入云端')
  eq(remoteSheet.items.filter(i => i.done).length, 1, '云端记录了 1 项完成')
  eq(db.families[0].rev, 2, '云端版本号递增到 2')

  /* 6. 取消勾选不重复加分 */
  await store.toggleItem(ov.day, firstItem.id)
  eq(store.balance(), 0, '取消勾选后扣回')
  await store.toggleItem(ov.day, firstItem.id)
  eq(store.balance(), firstItem.points, '再次勾选只加一次')

  /* 7. 全部完成 → 满勤奖 */
  const overview = store.todayOverview()
  for (const g of overview.groups) {
    for (const it of g.items) {
      if (!it.done) await store.toggleItem(overview.day, it.id)
    }
  }
  eq(store.balance(), 48 + 10, '全部完成后含 10 分满勤奖')

  /* 8. 家长撤销 → 扣回并连带扣满勤 */
  const doneItem = store.todayOverview().groups[0].items[0]
  const rev = await store.revokeItem(overview.day, doneItem.id)
  ok(rev.ok, '家长撤销成功')
  eq(store.balance(), 48 + 10 - doneItem.points - 10, '撤销后扣回该项并扣回满勤奖')

  /* 9. 积分不足时不能兑换 */
  await store.adjustPoints(-900, '测试扣分')
  const cheap = store.listGifts()[0]
  const bad = await store.requestRedeem(cheap.id)
  ok(bad.ok === false, '余额不足时兑换被拒')

  /* 10. 兑换审批 */
  await store.adjustPoints(1000, '测试加分')
  const before = store.balance()
  const req = await store.requestRedeem(cheap.id)
  ok(req.ok, '提交兑换申请')
  const pend = store.listRedemptions().filter(r => r.status === 'pending')[0]
  ok(!!pend, '申请进入待审批')
  const dec = await store.decideRedeem(pend.id, true)
  ok(dec.ok, '家长同意兑换')
  eq(store.balance(), before - cheap.cost, '同意后扣除对应积分')
  eq(db.families[0].doc.redemptions[0].status, 'approved', '审批状态写回云端')

  /* 11. 临时加项 */
  const extra = await store.addExtraToday('带美术材料', 5)
  ok(extra.ok, '临时加项成功')
  const after = store.todayOverview()
  ok(after.total === 12, '临时加项进入当天清单')
  ok(after.groups.some(g => g.items.some(i => i.title === '带美术材料')), '清单里能找到这一项')

  /* 12. 清单配置写回云端 */
  const key = store.addGroup ? await store.addGroup('钢琴练习', '🎹') : null
  ok(key.ok && !!key.groupKey, '新增大项成功')
  await store.addChild(key.groupKey, '音阶', 6)
  const groups = store.listTaskGroups()
  const piano = groups.filter(g => g.title === '钢琴练习')[0]
  ok(!!piano && piano.children.length === 1, '新增子项成功')
  eq(piano.points, 6, '大项分值汇总正确')
  ok(db.families[0].doc.tasks.some(t => t.title === '音阶'), '子项写回云端')

  /* 13. 护身符每月一次 */
  const day = '2026-11-07'
  const c1 = await store.useCoupon(day)
  ok(c1.ok, '使用护身符')
  const c2 = await store.useCoupon(day)
  ok(c2.ok === false, '同月不能用第二次')

  /* 14. 跨设备：孩子加入并看到同一份数据 */
  const parentRev = db.families[0].rev
  db.session = { user: { id: 'u-child', name: '朵朵' } }
  const childStore = freshStore()
  const childBoot = await childStore.bootstrap()
  ok(childBoot.needSetup, '孩子首次进入需要加入家庭')
  const wrong = await childStore.joinFamily('ZZZZZZ')
  ok(wrong.ok === false, '错误邀请码被拒绝')
  const joined = await childStore.joinFamily(created.inviteCode.toLowerCase())
  ok(joined.ok, '正确邀请码可以加入'); console.log('JOIN=', JSON.stringify(joined))
  eq(childStore.getRole(), 'child', '加入者是学生身份')
  eq(childStore.getInviteCode(), created.inviteCode, '孩子能读到同一个邀请码')
  ok(childStore.isSetup(), '孩子端加载到家庭数据')
  eq(childStore.todayOverview().total, store.todayOverview().total, '孩子看到和家长端同一份清单')

  /* 15. 孩子打卡 → 家长端能看到 */
  const childOv = childStore.todayOverview()
  const pendingItem = childOv.groups.map(g => g.items).flat().filter(i => !i.done)[0]
  await childStore.toggleItem(childOv.day, pendingItem.id)
  db.session = { user: { id: 'u-email', name: 'parent@example.com' } }
  const parentAgain = freshStore()
  await parentAgain.bootstrap()
  ok(db.families[0].rev > parentRev, '孩子写入后云端版本号继续增长')
  const parentOv = parentAgain.todayOverview()
  ok(parentOv.groups.map(g => g.items).flat().some(i => i.id === pendingItem.id && i.done), '家长端能看到孩子的勾选')

  /* 16. 并发写入：版本冲突后自动重放 */
  db.injectConflictOnce = true
  const parentDoc = parentAgain.todayOverview()
  const target = parentDoc.groups.map(g => g.items).flat().filter(i => !i.done)[0]
  const conflicted = await parentAgain.toggleItem(parentDoc.day, target.id)
  ok(conflicted.ok, '版本冲突后自动重试成功')
  eq(db.families[0].doc.family.name, '并发改的名字', '没有覆盖另一台设备的改动')
  ok(db.families[0].doc.sheets[parentDoc.day].items.some(i => i.id === target.id && i.done), '冲突后本次操作也写进去了')

  /* 17. 网络失败回滚 */
  db.failNextWrite = true
  const balanceBefore = parentAgain.balance()
  const failing = parentAgain.todayOverview().groups.map(g => g.items).flat().filter(i => !i.done)[0]
  const netFail = await parentAgain.toggleItem(parentAgain.todayOverview().day, failing.id)
  ok(netFail.ok === false, '网络失败时返回错误')
  eq(parentAgain.balance(), balanceBefore, '网络失败后内存数据已回滚')
  ok(!parentAgain.todayOverview().groups.map(g => g.items).flat().some(i => i.id === failing.id && i.done), '界面上不会残留假勾选')

  /* 18. 退出登录 */
  await parentAgain.signOut()
  const afterSignOut = await parentAgain.bootstrap()
  ok(afterSignOut.needLogin, '退出后回到登录页')
  eq(storage['ced_cache_v2'], undefined, '退出后本地缓存已清')

  console.log('\n通过 ' + pass + ' 条，失败 ' + fails.length + ' 条')
  if (fails.length) process.exit(1)
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
