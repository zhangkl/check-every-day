/* hero 学生端随机古诗词：quotes.pickPoem 单测 */
const path = require('path')
const quotes = require(path.join(path.resolve(__dirname, '..'), 'utils/quotes'))
let pass = 0
function ok(c, l) { if (c) { pass++; return } console.log('  FAIL ' + l); process.exitCode = 1 }

const poems = quotes.QUOTES.filter(q => !!q.by)
ok(poems.length >= 10, '诗词库条目足够：' + poems.length + ' 首')

const seen = {}
for (let i = 0; i < 80; i++) {
  const p = quotes.pickPoem()
  ok(!!p && !!p.by && !!p.zh, '第 ' + i + ' 次抽到的是带出处的古诗词')
  ok(poems.indexOf(p) >= 0, '抽到的条目来自诗词子集（不含鸡汤）')
  seen[p.zh] = true
}
ok(Object.keys(seen).length > 1, '多次抽取确实随机（抽到 ' + Object.keys(seen).length + ' 首不同）')

// 排除单个句子
const blocked = poems[0].zh
for (let i = 0; i < 40; i++) ok(quotes.pickPoem(blocked).zh !== blocked, '排除单句生效')

// 排除数组：底部每日一句 + 当前这首都不出现
const blocked2 = [poems[1].zh, poems[2].zh]
for (let i = 0; i < 40; i++) {
  const zh = quotes.pickPoem(blocked2).zh
  ok(blocked2.indexOf(zh) < 0, '排除数组生效')
}

// 全部排除时回退，不能返回 undefined
const all = poems.map(p => p.zh)
const fallback = quotes.pickPoem(all)
ok(!!fallback && !!fallback.by, '全被排除时回退到完整诗词库')

// 两个池互不串味
ok(!!quotes.POEMS && !!quotes.MOTTOS, '导出古诗池/鸡汤池')
ok(quotes.POEMS.length + quotes.MOTTOS.length === quotes.QUOTES.length, '两池覆盖全部条目且不重叠')
ok(quotes.POEMS.every(p => !!p.by && !p.en), '古诗池只含带出处的条目')
ok(quotes.MOTTOS.every(m => !!m.en && !m.by), '鸡汤池只含中英文条目')

// 底部「每日一句」：只出中英文鸡汤，不再冒出古诗/作者
const mottos = quotes.QUOTES.filter(q => !!q.en)
for (let d = 0; d < 30; d++) {
  for (let n = 0; n < 5; n++) {
    const q = quotes.pick('d2026-11-' + (d + 1), n)
    ok(!!q && !!q.en && !q.by, '每日一句是中英文鸡汤且无作者')
    ok(mottos.indexOf(q) >= 0, '每日一句来自鸡汤池')
  }
}

// 原有每日一句的确定性轮换不受影响
const q1 = quotes.pick('d2026-11-11', 0)
const q2 = quotes.pick('d2026-11-11', 0)
const q3 = quotes.pick('d2026-11-11', 1)
ok(q1 === q2, 'pick 同日同偏移稳定')
ok(q1 !== q3, 'pick 换偏移换句')

console.log('随机古诗词：通过 ' + pass + ' 条' + (process.exitCode ? '，有失败' : '，失败 0 条'))
