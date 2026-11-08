const KEY = 'ced_state_v1'

function pad(n) {
  return n < 10 ? '0' + n : '' + n
}

function key(d) {
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
}

function today() {
  return key(new Date())
}

function parse(k) {
  const p = k.split('-')
  return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]))
}

function addDays(k, delta) {
  const d = parse(k)
  d.setDate(d.getDate() + delta)
  return key(d)
}

// 周一 = 1 ... 周日 = 7
function weekday(k) {
  const w = parse(k).getDay()
  return w === 0 ? 7 : w
}

const WEEK_CN = ['', '一', '二', '三', '四', '五', '六', '日']

function weekdayCn(k) {
  return '周' + WEEK_CN[weekday(k)]
}

function pretty(k) {
  const d = parse(k)
  return (d.getMonth() + 1) + '月' + d.getDate() + '日'
}

function prettyFull(k) {
  return pretty(k) + ' ' + weekdayCn(k)
}

function monthKey(k) {
  return k.slice(0, 7)
}

function daysBetween(a, b) {
  return Math.round((parse(b) - parse(a)) / 86400000)
}

function daysInMonth(monthKeyStr) {
  const p = monthKeyStr.split('-')
  return new Date(Number(p[0]), Number(p[1]), 0).getDate()
}

function timeHm(ts) {
  if (!ts) return ''
  const d = new Date(ts)
  return pad(d.getHours()) + ':' + pad(d.getMinutes())
}

module.exports = {
  KEY,
  pad,
  key,
  today,
  parse,
  addDays,
  weekday,
  weekdayCn,
  pretty,
  prettyFull,
  monthKey,
  daysBetween,
  daysInMonth,
  timeHm
}
