/**
 * 语音小结：每个任务项每天可以录一段语音（今天学了什么、有没有学明白、遗留问题）。
 * - 录音：wx.getRecorderManager，mp3，最长 3 分钟自动结束。
 * - 存储：上传到云存储 shared/<uid>/voices/<day>/...，家庭成员都有读权限。
 * - 播放：createSignedUrl 拿临时地址，InnerAudioContext 播放，同一时间只播一段。
 */
const { cloud, publicConfig } = require('./cloud')
const store = require('./store')

const MAX_MS = 180000

let audioCtx = null

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
    wx.getRecorderManager().stop()
  } catch (e) {}
}

/**
 * 开始录音。handlers: { onStop(tempFilePath, seconds), onError(msg) }
 * 到 3 分钟上限时 onStop 会自动触发。
 */
function start(handlers) {
  const rm = wx.getRecorderManager()
  rm.onStop(function (res) {
    const raw = res && res.duration ? res.duration : 0
    // 基础库对 duration 的单位实现不一致：大于 1000 按毫秒算
    const seconds = raw > 1000 ? Math.round(raw / 1000) : Math.round(raw)
    if (handlers && handlers.onStop) {
      handlers.onStop(res && res.tempFilePath ? res.tempFilePath : '', seconds)
    }
  })
  rm.onError(function (e) {
    if (handlers && handlers.onError) {
      handlers.onError((e && e.errMsg) || '录音失败了')
    }
  })
  rm.start({
    format: 'mp3',
    duration: MAX_MS,
    sampleRate: 16000,
    numberOfChannels: 1,
    encodeBitRate: 48000
  })
}

// 本地模式：录音存成手机上的持久文件，文档里记本地路径
function saveLocal(day, itemId, tempFilePath, seconds) {
  return new Promise(function (resolve) {
    const fs = wx.getFileSystemManager()
    fs.saveFile({
      tempFilePath: tempFilePath,
      success: function (r) {
        store
          .setItemVoice(day, itemId, {
            path: r.savedFilePath,
            duration: seconds,
            at: Date.now(),
            local: true
          })
          .then(function (saved) {
            if (saved.ok && saved.oldPath && saved.oldPath.indexOf('wxfile') === 0) {
              try {
                fs.unlink({ filePath: saved.oldPath, fail: function () {} })
              } catch (e) {}
            }
            resolve(saved)
          })
      },
      fail: function () {
        resolve({ ok: false, error: '录音保存失败' })
      }
    })
  })
}

/**
 * 录完后的落地：本地模式存手机文件；云端模式传云存储。
 */
async function uploadAndSave(day, itemId, tempFilePath, seconds) {
  if (!tempFilePath) return { ok: false, error: '没录上声音，再试一次' }
  if (store.isLocal()) return saveLocal(day, itemId, tempFilePath, seconds)
  const uid = store.sessionUid()
  if (!uid) return { ok: false, error: '还没登录' }
  const stamp = Date.now()
  let path
  try {
    path = cloud.storage.sharedPath(uid, 'voices/' + day + '/' + stamp + '-' + itemId + '.mp3')
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
  const up = await rawUpload(path, buffer, 'audio/mpeg')
  if (up.error) {
    return { ok: false, error: up.error || '上传失败，请再试一次' }
  }
  const saved = await store.setItemVoice(day, itemId, {
    path: path,
    duration: seconds,
    at: stamp
  })
  if (!saved.ok) {
    try {
      await cloud.storage.remove([path])
    } catch (e) {}
    return saved
  }
  if (saved.oldPath) {
    try {
      await cloud.storage.remove([saved.oldPath])
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

module.exports = { start, stopRecord, uploadAndSave, play, stopPlay, rawUpload, MAX_MS }
