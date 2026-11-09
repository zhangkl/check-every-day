/**
 * 语音转文字：微信官方「同声传译」插件（WechatSI）。
 * - 插件只支持「边录边识别」（最长 60 秒），没有对已有文件的转写接口，
 *   所以在录音环节直接换用插件的识别管理器，录完同时得到音频和文字。
 * - 插件需要在 mp.weixin.qq.com 后台添加；没添加/环境不支持时 getPlugin()
 *   返回 null，调用方自动退回普通录音（无文字），不影响原有功能。
 */
let cached = null
let tried = false

function getPlugin() {
  if (tried) return cached
  tried = true
  try {
    // 小程序运行时的全局函数；node 测试环境没有，走 catch
    cached = requirePlugin('WechatSI')
  } catch (e) {
    cached = null
  }
  return cached
}

/**
 * 开始「录音 + 识别」。
 * handlers: {
 *   onStart(),                                  // 识别真正开始
 *   onStop(tempFilePath, seconds, text),        // 结束：音频临时文件 + 时长(秒) + 识别文本
 *   onError(msg)
 * }
 * 返回 true 表示已用插件开始；false 表示插件不可用，调用方退回普通录音。
 */
function start(handlers) {
  const si = getPlugin()
  if (!si) return false
  let mgr
  try {
    mgr = si.getRecordRecognitionManager()
  } catch (e) {
    return false
  }
  const h = handlers || {}
  mgr.onStart = function () {
    if (h.onStart) h.onStart()
  }
  mgr.onStop = function (res) {
    // 插件文档明确 duration 单位是毫秒
    const raw = res && res.duration ? Number(res.duration) : 0
    const seconds = raw > 1000 ? Math.round(raw / 1000) : Math.round(raw)
    if (h.onStop) {
      h.onStop((res && res.tempFilePath) || '', seconds, (res && res.result) || '')
    }
  }
  mgr.onError = function (res) {
    if (h.onError) h.onError((res && res.msg) || '识别失败了')
  }
  try {
    mgr.start({ duration: 60000, lang: 'zh_CN' })
  } catch (e) {
    return false
  }
  return true
}

/** 结束本次识别录音。 */
function stop() {
  const si = getPlugin()
  if (!si) return
  try {
    si.getRecordRecognitionManager().stop()
  } catch (e) {}
}

module.exports = { getPlugin, start, stop }
