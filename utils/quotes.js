/**
 * 每日一句：古诗词 + 中英文心灵鸡汤。
 * 按日期确定性轮换（同一天同一句，跨端一致），点击可手动换下一条。
 * 结构：{ zh: 中文, en: 英文（鸡汤款）, by: 出处（诗词款） }
 */
const QUOTES = [
  { zh: '千淘万漉虽辛苦，吹尽狂沙始到金。', by: '刘禹锡' },
  { zh: '宝剑锋从磨砺出，梅花香自苦寒来。', by: '《警世贤文》' },
  { zh: '不积跬步，无以至千里；不积小流，无以成江海。', by: '荀子' },
  { zh: '黑发不知勤学早，白首方悔读书迟。', by: '颜真卿' },
  { zh: '少年易老学难成，一寸光阴不可轻。', by: '朱熹' },
  { zh: '长风破浪会有时，直挂云帆济沧海。', by: '李白' },
  { zh: '会当凌绝顶，一览众山小。', by: '杜甫' },
  { zh: '纸上得来终觉浅，绝知此事要躬行。', by: '陆游' },
  { zh: '问渠那得清如许？为有源头活水来。', by: '朱熹' },
  { zh: '欲穷千里目，更上一层楼。', by: '王之涣' },
  { zh: '天生我材必有用，千金散尽还复来。', by: '李白' },
  { zh: '锲而不舍，金石可镂。', by: '荀子' },
  { zh: '业精于勤，荒于嬉；行成于思，毁于随。', by: '韩愈' },
  { zh: '明日复明日，明日何其多。我生待明日，万事成蹉跎。', by: '钱福' },
  { zh: '千磨万击还坚劲，任尔东西南北风。', by: '郑燮' },
  { zh: '沉舟侧畔千帆过，病树前头万木春。', by: '刘禹锡' },
  { zh: '山重水复疑无路，柳暗花明又一村。', by: '陆游' },
  { zh: '等闲识得东风面，万紫千红总是春。', by: '朱熹' },
  { zh: '今天走的每一步，都算数。', en: 'Every step you take today counts.' },
  { zh: '小小的坚持，会有大大的收获。', en: 'Little by little, one travels far.' },
  { zh: '你现在的努力，是为了以后有更多选择。', en: 'Work hard now for more choices later.' },
  { zh: '行动是治愈恐惧的良药。', en: 'Action is the antidote to fear.' },
  { zh: '每天进步一点点，一年后你就大不一样。', en: '1% better every day adds up.' },
  { zh: '不要等灵感来追你，先动起来。', en: "Don't wait for inspiration; start doing." },
  { zh: '完成比完美更重要。', en: 'Done is better than perfect.' },
  { zh: '今天的你，比昨天更棒。', en: 'Today you are better than yesterday.' },
  { zh: '试试不一定成功，不试一定不成功。', en: 'You miss 100% of the shots you never take.' },
  { zh: '把简单的事做好，就是不简单。', en: 'Excellence is doing simple things well.' },
  { zh: '星光不问赶路人，时光不负有心人。', en: 'Time rewards those who keep going.' },
  { zh: '慢慢来，比较快。', en: 'Slow is smooth, smooth is fast.' },
  { zh: '你认真的样子，最好看。', en: 'You look great when you focus.' },
  { zh: '未来的你，会感谢现在努力的自己。', en: 'Your future self will thank you.' },
  { zh: '种一棵树最好的时间是十年前，其次是现在。', en: 'The best time to start is now.' },
  { zh: '没有白走的路，每一步都算数。', en: 'No step is wasted; they all count.' },
  { zh: '保持热爱，奔赴山海。', en: 'Stay passionate, chase the world.' },
  { zh: '读书是成本最低、回报最高的旅行。', en: 'Reading is the cheapest journey with the richest views.' }
]

// 简单字符串 hash：让同一天的种子稳定
function hashStr(str) {
  let h = 0
  const s = String(str || '')
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) >>> 0
  }
  return h
}

// 两类内容分开用：底部「每日一句」只出中英文鸡汤；首页 hero 只出古诗词
const POEMS = QUOTES.filter(function (q) { return !!q.by })
const MOTTOS = QUOTES.filter(function (q) { return !!q.en })

// day：日期字符串（如 'd2026-11-10'）；n：手动换句的偏移量
// 只在鸡汤池里按日期确定性轮换（同一天同一句，跨端一致）
function pick(day, n) {
  const seed = hashStr(day) + (Number(n) || 0)
  return MOTTOS[seed % MOTTOS.length]
}

// 古诗词：首页 hero 学生端每次随机一首
// exclude 可传一个句子或数组，避免和当前这首撞句
function pickPoem(exclude) {
  const blocked = Array.isArray(exclude) ? exclude : (exclude ? [exclude] : [])
  const pool = POEMS.filter(function (p) { return blocked.indexOf(p.zh) < 0 })
  const list = pool.length ? pool : POEMS
  return list[Math.floor(Math.random() * list.length)]
}

module.exports = { QUOTES, POEMS, MOTTOS, pick, pickPoem }
