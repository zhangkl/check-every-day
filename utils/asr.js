/**
 * 语音转文字：腾讯云「录音文件识别」（异步任务版）。
 * 流程：读录音文件 → base64 → CreateRecTask 提交任务 → 轮询 DescribeTaskStatus 拿结果。
 * - 支持 3 分钟整条录音（该接口上限数小时）。
 * - 云端路径（shared/…）先取签名地址下载；本地路径直接读文件。
 * - TC3-HMAC-SHA256 签名用 utils/tc3.js 的纯 JS 实现。
 */
const tc3 = require('./tc3')
let config
try {
  config = require('./asr.config')
} catch (e) {
  config = {}
}

const HOST = 'asr.tencentcloudapi.com'
const SERVICE = 'asr'
const VERSION = '2019-06-14'
// 3 分钟 mp3 约 1MB，base64 后约 1.4MB
const POLL_INTERVAL = 3000
const POLL_MAX = 40

function configured() {
  return !!(config.SECRET_ID && config.SECRET_KEY)
}

/** TC3 签名并调用 ASR 接口（POST JSON）。返回 Response 对象或 { error } */
function callApi(action, params) {
  return new Promise(function (resolve) {
    const ts = Math.floor(Date.now() / 1000)
    const date = new Date(ts * 1000).toISOString().slice(0, 10)
    const payload = JSON.stringify(params)
    const hashedPayload = tc3.sha256Hex(payload)
    const canonicalHeaders =
      'content-type:application/json; charset=utf-8\nhost:' + HOST + '\n'
    const canonicalRequest =
      'POST' +
      '\n/\n' +
      '\n' +
      canonicalHeaders +
      '\n' +
      'content-type;host' +
      '\n' +
      hashedPayload
    const stringToSign =
      'TC3-HMAC-SHA256\n' +
      ts +
      '\n' +
      date + '/' + SERVICE + '/tc3_request\n' +
      tc3.sha256Hex(canonicalRequest)
    let signature
    try {
      const kDate = tc3.hmacSha256('TC3' + config.SECRET_KEY, date)
      const kService = tc3.hmacSha256(kDate, SERVICE)
      const kSigning = tc3.hmacSha256(kService, 'tc3_request')
      signature = tc3.toHex(tc3.hmacSha256(kSigning, stringToSign))
    } catch (e) {
      resolve({ error: '签名计算失败' })
      return
    }
    const authorization =
      'TC3-HMAC-SHA256 Credential=' + config.SECRET_ID + '/' + date + '/' + SERVICE +
      '/tc3_request, SignedHeaders=content-type;host, Signature=' + signature
    wx.request({
      url: 'https://' + HOST + '/',
      method: 'POST',
      header: {
        'content-type': 'application/json; charset=utf-8',
        'X-TC-Action': action,
        'X-TC-Version': VERSION,
        'X-TC-Timestamp': String(ts),
        'Authorization': authorization
      },
      data: params,
      success: function (res) {
        const d = res.data
        if (d && d.Response && d.Response.Error) {
          resolve({ error: (d.Response.Error.Message || d.Response.Error.Code) })
          return
        }
        if (d && d.Response) {
          resolve(d.Response)
          return
        }
        resolve({ error: '服务返回异常（' + res.statusCode + '）' })
      },
      fail: function () {
        resolve({ error: '网络不可用，稍后再试' })
      }
    })
  })
}

/** 把录音文件读成 base64。云端 shared/ 路径先下载。 */
function readAudioBase64(path) {
  return new Promise(function (resolve) {
    const finish = function (filePath) {
      try {
        wx.getFileSystemManager().readFile({
          filePath: filePath,
          success: function (r) {
            let b64 = ''
            try {
              b64 = wx.arrayBufferToBase64(r.data)
            } catch (e) {
              resolve({ error: '录音编码失败' })
              return
            }
            resolve({ base64: b64, rawLen: r.data.byteLength })
          },
          fail: function () {
            resolve({ error: '录音文件读不出来' })
          }
        })
      } catch (e) {
        resolve({ error: '录音文件读不出来' })
      }
    }
    if (/^https?:\/\//.test(path) || path.indexOf('shared/') === 0) {
      // 云端文件：取签名地址下载成临时文件
      const cloud = require('./cloud').cloud
      cloud.storage
        .createSignedUrl(path, 1800)
        .then(function (signed) {
          const url =
            signed && signed.data && (signed.data.signedUrl || signed.data.url)
          if (!url) {
            resolve({ error: '取音频失败，请稍后再试' })
            return
          }
          wx.downloadFile({
            url: url,
            success: function (r) {
              if (r.statusCode === 200 && r.tempFilePath) {
                finish(r.tempFilePath)
              } else {
                resolve({ error: '下载录音失败' })
              }
            },
            fail: function () {
              resolve({ error: '下载录音失败' })
            }
          })
        })
        .catch(function () {
          resolve({ error: '取音频失败，请稍后再试' })
        })
      return
    }
    finish(path)
  })
}

function sleep(ms) {
  return new Promise(function (resolve) {
    setTimeout(resolve, ms)
  })
}

/**
 * 转写一段录音。
 * @param {string} path 录音文件路径（云端 shared/ 或本地）
 * @returns {Promise<{ok:true,text:string}|{ok:false,error:string}>}
 */
async function transcribe(path) {
  if (!configured()) return { ok: false, error: '还没有配置转文字服务' }
  const audio = await readAudioBase64(path)
  if (audio.error) return { ok: false, error: audio.error }
  const created = await callApi('CreateRecTask', {
    EngineModelType: '16k_zh',
    ChannelNum: 1,
    ResTextFormat: 2, // 纯文本，不带分段时间戳
    SourceType: 1,
    Data: audio.base64,
    DataLen: audio.rawLen
  })
  if (created.error) return { ok: false, error: created.error }
  // 腾讯云返回结构：{ Response: { Data: { TaskId }, RequestId } }
  const taskId = created.Data && created.Data.TaskId
  if (!taskId) {
    console.warn('[asr] CreateRecTask 异常响应', JSON.stringify(created))
    return { ok: false, error: '转写任务创建失败' }
  }
  for (let i = 0; i < POLL_MAX; i++) {
    await sleep(POLL_INTERVAL)
    const st = await callApi('DescribeTaskStatus', { TaskId: taskId })
    if (st.error) return { ok: false, error: st.error }
    // 响应结构：{ Response: { Data: { Status, Result, ErrorMsg } } }
    // Status: 0 等待 1 进行中 2 成功 3 失败
    const d = st.Data || {}
    if (d.Status === 2) {
      return { ok: true, text: (d.Result || '').trim() }
    }
    if (d.Status === 3) {
      return { ok: false, error: d.ErrorMsg || '转写失败' }
    }
  }
  return { ok: false, error: '转写超时了，稍后再试' }
}

module.exports = { transcribe, configured, callApi, readAudioBase64 }
