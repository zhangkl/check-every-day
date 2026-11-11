#!/usr/bin/env node
// 小程序代码包静态体检
//
// 背景：miniprogramRoot 是 "./"，源码根目录下的任何 .js 都会被微信编译器
// 当成小程序代码处理。回归测试是 Node 脚本（process / child_process / fs），
// 一旦被打包，上传阶段就会编译失败。这里模拟 project.config.json 的
// packOptions.ignore 规则，验证进入代码包的文件都是干净的。
//
// 注意：这是本地静态模拟，不等同于微信开发者工具的真实编译结果；
// 最终仍须以面板上的发布结果为准。

const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const LIMIT_BYTES = 2 * 1024 * 1024 // 微信主包上限 2 MB
let failed = 0

function ok(cond, msg, extra) {
  console.log((cond ? '  ✓ ' : '  ✗ ') + msg + (extra ? '  ' + extra : ''))
  if (!cond) failed++
}

function listFiles(dir, base) {
  let out = []
  for (const name of fs.readdirSync(dir)) {
    const abs = path.join(dir, name)
    const rel = base ? base + '/' + name : name
    const st = fs.statSync(abs)
    if (st.isDirectory()) out = out.concat(listFiles(abs, rel))
    else out.push({ rel, abs, size: st.size })
  }
  return out
}

// packOptions.ignore 规则匹配（覆盖官方 file/folder/suffix/prefix/regexp/glob）
function ignored(rel, rules) {
  return rules.some(function (rule) {
    const v = rule.value
    switch (rule.type) {
      case 'folder':
        return rel === v || rel.indexOf(v + '/') === 0
      case 'file':
        return rel === v
      case 'suffix':
        return rel.slice(-v.length) === v
      case 'prefix':
        return path.basename(rel).indexOf(v) === 0
      case 'regexp':
        return new RegExp(v).test(rel)
      case 'glob': {
        // 仅支持 **/ 与 * 两种通配符，够覆盖本项目规则
        const src = v
          .replace(/[.+^${}()|[\]\\]/g, '\\$&')
          .replace(/\*\*\//g, '§')
          .replace(/\*/g, '[^/]*')
          .replace(/§/g, '(?:.*/)?')
        return new RegExp('^' + src + '$').test(rel)
      }
      default:
        return false
    }
  })
}

console.log('小程序代码包静态体检')
console.log('项目：' + ROOT + '\n')

const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'project.config.json'), 'utf8'))
const rules = ((cfg.packOptions || {}).ignore) || []
ok(Array.isArray(rules) && rules.length > 0, 'packOptions.ignore 已配置', rules.length + ' 条规则')

// node_modules 由微信 npm 构建转换为 miniprogram_npm，不直接进包；这里单独排除
const builtInSkip = function (rel) {
  return rel === 'node_modules' || rel.indexOf('node_modules/') === 0
}

const all = listFiles(ROOT, '')
const packed = all.filter(function (f) {
  return !builtInSkip(f.rel) && !ignored(f.rel, rules)
})
const excluded = all.filter(function (f) {
  return builtInSkip(f.rel) || ignored(f.rel, rules)
})

console.log('文件：进包 ' + packed.length + ' 个 / 排除 ' + excluded.length + ' 个')

const badDirs = ['tests/', 'sql/', '.git/', '.workbuddy/']
console.log('\n[1] 非运行时目录是否出包')
badDirs.forEach(function (d) {
  const leaked = packed.filter(function (f) { return f.rel.indexOf(d) === 0 })
  ok(leaked.length === 0, d + ' 未进包', leaked.length ? '泄漏 ' + leaked.length + ' 个：' + leaked[0].rel : '')
})
// 平台生成的隐私声明由发布通道读取，属于已知白名单，不视为杂项
const PLATFORM_FILE = /^\.wbapp_.*\.privacy\.json$/
const hidden = packed.filter(function (f) {
  const name = path.basename(f.rel)
  return name.indexOf('.') === 0 && !PLATFORM_FILE.test(name)
})
ok(hidden.length === 0, '无隐藏杂项文件进包', hidden.length ? hidden.map(function (f) { return f.rel }).join(', ') : '')

console.log('\n[2] 包内 JS 是否含 Node 专有 API')
const NODE_ONLY = ["require('fs')", 'require("fs")', 'child_process', '__dirname', 'process.exit', 'process.argv']
const jsFiles = packed.filter(function (f) { return /\.js$/.test(f.rel) })
const dirty = []
jsFiles.forEach(function (f) {
  const text = fs.readFileSync(f.abs, 'utf8')
  const hit = NODE_ONLY.filter(function (k) { return text.indexOf(k) >= 0 })
  if (hit.length) dirty.push(f.rel + ' → ' + hit.join(', '))
})
ok(dirty.length === 0, jsFiles.length + ' 个 JS 文件均可被小程序编译', dirty.length ? '\n      ' + dirty.slice(0, 5).join('\n      ') : '')

console.log('\n[3] 页面与 JSON 完整性')
const app = JSON.parse(fs.readFileSync(path.join(ROOT, 'app.json'), 'utf8'))
let missing = []
;(app.pages || []).forEach(function (p) {
  ;['.js', '.wxml', '.json'].forEach(function (ext) {
    const rel = p + ext
    if (!packed.some(function (f) { return f.rel === rel })) missing.push(rel)
  })
})
ok(missing.length === 0, (app.pages || []).length + ' 个页面文件齐全', missing.length ? '缺 ' + missing.join(', ') : '')
const jsonFiles = packed.filter(function (f) { return /\.json$/.test(f.rel) })
let badJson = []
jsonFiles.forEach(function (f) {
  try { JSON.parse(fs.readFileSync(f.abs, 'utf8')) } catch (e) { badJson.push(f.rel) }
})
ok(badJson.length === 0, jsonFiles.length + ' 个 JSON 均可解析', badJson.length ? badJson.join(', ') : '')

console.log('\n[4] 代码包体积（源码 + npm 构建产物估算）')
const sdkDist = path.join(ROOT, 'node_modules/@tencent-ai/workbuddy-cloud-sdk/miniprogram_dist')
let sdkBytes = 0
if (fs.existsSync(sdkDist)) {
  listFiles(sdkDist, '').forEach(function (f) { sdkBytes += f.size })
}
const srcBytes = packed.reduce(function (n, f) { return n + f.size }, 0)
const total = srcBytes + sdkBytes
ok(total < LIMIT_BYTES, '估算 ' + (total / 1024).toFixed(1) + ' KB < 2 MB 主包上限',
  '源码 ' + (srcBytes / 1024).toFixed(1) + ' KB + SDK ' + (sdkBytes / 1024).toFixed(1) + ' KB')

console.log('\n结论：' + (failed === 0 ? '打包范围干净，可以重新发布' : failed + ' 项未通过，请先修复'))
console.log('（静态模拟，最终以微信/面板发布结果为准）')
process.exit(failed ? 1 : 0)
