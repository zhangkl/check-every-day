/**
 * 语音小结：每个任务项每天可以录多条语音（今天学了什么、有没有学明白、遗留问题）。
 * - 录音：优先用同声传译插件「边录边转文字」（最长 60 秒）；插件不可用时退回
 *   wx.getRecorderManager 普通录音（mp3，最长 10 分钟，无文字）。
 * - 存储：上传到云存储 shared/<uid>/voices/<day>/...，家庭成员都有读权限。
 * - 播放：createSignedUrl 拿临时地址，InnerAudioContext 播放，同一时间只播一段。
 */
const { cloud, publicConfig } = require('./cloud')
const store = require('./store')
const speech = require('./speech')

const MAX_MS = 600000 // 微信录音组件上限即 10 分钟
// 同声传译插件单次识别上限 60 秒
const SI_MAX_MS = 60000

let audioCtx = null
// 当前这轮录音是否走插件识别（决定 stopRecord 停哪个管理器）
let activeSI = false

const MIME = { mp3: 'audio/mpeg', wav: 'audio/wav', aac: 'audio/aac', m4a: 'audio/mp4' }

/**
 * 二进制直传：SDK 的 fetch 封装暂不支持 ArrayBuffer body，
 * 但 wx.request 原生支持。按 SDK Storage 的内部约定拼 URL 和鉴权头：
 *   POST {endpoint}/.cloud/storage/object/runtime/<path>
 */
function rawUpload(path, buffer, contentType) {
  return new Promise(function (resolve) {
    let tokenPromise
    try {
      tokenPromise = cloud.auth.getAccessToken()
    } catch (e) {
      tokenPromise = Promise.resolve(undefined)
    }
    tokenPromise
      .then(function (token) {
        const header = {
          'x-wb-webapp-access-key': publicConfig.publishableKey,
          'content-type': contentType,
          'cache-control': 'max-age=3600',
          'x-upsert': 'false',
          'X-Client-Info': 'storage-js/2.112.3'
        }
        if (token) header['Authorization'] = 'Bearer ' + token
        wx.request({
          url: publicConfig.endpoint + '/.cloud/storage/object/runtime/' + path,
          method: 'POST',
          header: header,
          data: buffer,
          success: function (res) {
            if (res.statusCode >= 200 && res.statusCode < 300) {
              resolve({ ok: true })
              return
            }
            const d = res.data
            const msg =
              d && typeof d.message === 'string'
                ? d.message
                : d && typeof d.error === 'string'
                ? d.error
                : '上传失败（' + res.statusCode + '）'
            resolve({ ok: false, error: msg })
          },
          fail: function () {
            resolve({ ok: false, error: '网络不可用，稍后再试' })
          }
        })
      })
      .catch(function () {
        resolve({ ok: false, error: '登录状态失效了，请重新登录后再录' })
      })
  })
}

function stopRecord() {
  try {
    if (activeSI) {
      speech.stop()
    } else {
      wx.getRecorderManager().stop()
    }
  } catch (e) {}
}

/**
 * 开始录音。handlers: { onStop(tempFilePath, seconds, text), onError(msg) }
 * - 插件可用：边录边识别，onStop 带识别文字，最长 60 秒自动结束。
 * - 插件不可用：普通录音（无文字），最长 10 分钟。
 */
function start(handlers) {
  const h = handlers || {}
  // 先试「录音 + 转文字」
  const siOk = speech.start({
    onStart: function () {
      if (h.onStart) h.onStart()
    },
    onStop: function (tmpPath, seconds, text) {
      activeSI = false
      if (h.onStop) h.onStop(tmpPath, seconds, text || '')
    },
    onError: function (msg) {
      activeSI = false
      if (h.onError) h.onError(msg)
    }
  })
  if (siOk) {
    activeSI = true
    return
  }
  // 降级：普通录音（转文字不可用）
  const rm = wx.getRecorderManager()
  // 基础库 onStop 返回的 duration 单位不一致（有的毫秒、有的秒），
  // 且短录音毫秒值会小于 1000，单看数值没法判断单位。
  // 所以自己记一个起始时间，用「实际经过的秒数」来消歧：
  // 实际耗时一定 >= 录音真实时长（还要加上点停止的反应延迟）。
  const startAt = Date.now()
  rm.onStop(function (res) {
    const raw = res && res.duration ? Number(res.duration) : 0
    const elapsedSec = Math.max(0, (Date.now() - startAt) / 1000)
    let seconds
    if (raw > 1000) {
      // 超过 1000：秒为单位不可能（上限 600 秒），必是毫秒
      seconds = Math.round(raw / 1000)
    } else if (raw > 0 && raw <= 600 && elapsedSec >= raw) {
      // 数值不超过上限、且「按秒解释」说得通（实际耗时覆盖得住）→ 按秒
      seconds = Math.round(raw)
    } else {
      // 其余按毫秒兜底（不足 1 秒的会被上层以「太短」拒绝）
      seconds = Math.round(raw / 1000)
    }
    // 无论如何不能超过实际经过的时间
    if (elapsedSec > 0) {
      seconds = Math.min(seconds, Math.round(elapsedSec))
    }
    if (h.onStop) {
      h.onStop(res && res.tempFilePath ? res.tempFilePath : '', seconds, '')
    }
  })
  rm.onError(function (e) {
    if (h.onError) {
      h.onError((e && e.errMsg) || '录音失败了')
    }
  })
  rm.start({
    format: 'mp3',
    duration: MAX_MS,
    sampleRate: 16000,
    numberOfChannels: 1,
    // 32kbps：10 分钟约 2.4MB（base64 后 3.2MB），留足腾讯云 ASR 直传余量
    encodeBitRate: 32000
  })
}

// 本地模式：录音存成手机上的持久文件，文档里记本地路径（追加，不覆盖旧录音）
function saveLocal(day, itemId, tempFilePath, seconds, text) {
  return new Promise(function (resolve) {
    const fs = wx.getFileSystemManager()
    fs.saveFile({
      tempFilePath: tempFilePath,
      success: function (r) {
        store
          .appendItemVoice(day, itemId, {
            path: r.savedFilePath,
            duration: seconds,
            at: Date.now(),
            text: text || ''
          })
          .then(resolve)
      },
      fail: function () {
        resolve({ ok: false, error: '录音保存失败' })
      }
    })
  })
}

/**
 * 录完后的落地：本地模式存手机文件；云端模式传云存储。
 * text 为识别出的文字（转文字不可用时为空）。
 */
async function uploadAndSave(day, itemId, tempFilePath, seconds, text) {
  if (!tempFilePath) return { ok: false, error: '没录上声音，再试一次' }
  if (store.isLocal()) return saveLocal(day, itemId, tempFilePath, seconds, text)
  const uid = store.sessionUid()
  if (!uid) return { ok: false, error: '还没登录' }
  const stamp = Date.now()
  // 插件录出来的可能是 aac/mp3 等格式，按实际扩展名定后缀和 MIME
  const ext = ((tempFilePath.match(/\.([a-z0-9]+)$/i) || [])[1] || 'aac').toLowerCase()
  const mime = MIME[ext] || 'audio/aac'
  let path
  try {
    path = cloud.storage.sharedPath(uid, 'voices/' + day + '/' + stamp + '-' + itemId + '.' + ext)
  } catch (e) {
    return { ok: false, error: '存储路径出错了' }
  }
  let buffer
  try {
    const fs = wx.getFileSystemManager()
    buffer = await new Promise(function (resolve, reject) {
      fs.readFile({
        filePath: tempFilePath,
        success: function (r) {
          resolve(r.data)
        },
        fail: reject
      })
    })
  } catch (e) {
    return { ok: false, error: '录音文件读不出来' }
  }
  const up = await rawUpload(path, buffer, mime)
  if (up.error) {
    return { ok: false, error: up.error || '上传失败，请再试一次' }
  }
  const saved = await store.appendItemVoice(day, itemId, {
    path: path,
    duration: seconds,
    at: stamp,
    text: text || ''
  })
  if (!saved.ok) {
    try {
      await cloud.storage.remove([path])
    } catch (e) {}
  }
  return saved
}

function teardownAudio() {
  if (audioCtx) {
    try {
      audioCtx.destroy()
    } catch (e) {}
    audioCtx = null
  }
}

/** 播放一段语音。onEnd 在播完/出错/手动停止时都会回调。 */
async function play(path, onEnd) {
  teardownAudio()
  // 本地文件直接播，云上文件走签名地址
  const isCloudPath = /^https?:\/\//.test(path) || path.indexOf('shared/') === 0
  let src = path
  if (isCloudPath) {
    const signed = await cloud.storage.createSignedUrl(path, 600)
    if (signed.error) {
      return { ok: false, error: (signed.error && signed.error.message) || '取音频失败，请稍后再试' }
    }
    src = signed.data && (signed.data.signedUrl || signed.data.url)
    if (!src) return { ok: false, error: '取音频失败，请稍后再试' }
  }
  audioCtx = wx.createInnerAudioContext()
  audioCtx.src = src
  const done = function () {
    teardownAudio()
    if (onEnd) onEnd()
  }
  audioCtx.onEnded(done)
  audioCtx.onStop(done)
  audioCtx.onError(done)
  audioCtx.play()
  return { ok: true }
}

function stopPlay() {
  if (audioCtx) {
    try {
      audioCtx.stop()
    } catch (e) {}
  }
}

/** 删掉一段语音的存储文件：云端路径走 storage.remove，本地路径直接 unlink。失败静默。 */
function deleteFile(path) {
  if (!path) return Promise.resolve()
  if (path.indexOf('shared/') === 0) {
    return cloud.storage
      .remove([path])
      .catch(function () {})
  }
  return new Promise(function (resolve) {
    try {
      wx.getFileSystemManager().unlink({
        filePath: path,
        complete: function () {
          resolve()
        }
      })
    } catch (e) {
      resolve()
    }
  })
}

module.exports = { start, stopRecord, uploadAndSave, play, stopPlay, rawUpload, deleteFile, MAX_MS, SI_MAX_MS }
