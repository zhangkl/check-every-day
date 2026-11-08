// 云服务客户端：全局唯一实例，Auth / Database 共用。
// endpoint 与 publishableKey 来自云服务开通结果，不要改动或从别处推导。
const { createMiniProgramWorkBuddyCloud } = require('@tencent-ai/workbuddy-cloud-sdk/miniprogram')
const { createDiagnosticWx } = require('./workbuddy-cloud-diagnostics')

const publicConfig = {
  endpoint: 'https://mp-api.app.workbuddy.host',
  publishableKey: 'wbpk_RcXQRfofGfmhSXvTK7lyCN_y7FFIxREst1x9FfXXk15csbPdr0atxI5',
  workBuddyOAuthClientId: 'cb_jq6QyEPkOkJXPcpz0JxS_wbapp_RcXQRfofGfmhSXvTK7lyCN'
}

const cloud = createMiniProgramWorkBuddyCloud({
  endpoint: publicConfig.endpoint,
  publishableKey: publicConfig.publishableKey,
  workBuddyOAuthClientId: publicConfig.workBuddyOAuthClientId,
  wx: createDiagnosticWx(wx)
})

module.exports = { cloud, publicConfig }
