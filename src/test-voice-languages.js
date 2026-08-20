import assert from 'node:assert/strict'
import {
  createCloudASRSession,
  getASRLanguageError,
  getXunfeiLanguageParam,
  normalizeASRLanguage,
} from './voice/cloud-asr.js'

assert.equal(normalizeASRLanguage('ug-CN'), 'ug', 'Uyghur locale normalizes to ug')
assert.equal(normalizeASRLanguage('cn_uyghur'), 'ug', 'iFLYTEK Uyghur code normalizes to ug')
assert.equal(normalizeASRLanguage('zh-CN'), 'zh', 'Mandarin locale normalizes to zh')
assert.equal(normalizeASRLanguage('en-US'), 'en', 'English locale normalizes to en')

assert.equal(getXunfeiLanguageParam('ug-CN'), 'cn_uyghur', 'Uyghur uses the iFLYTEK RTASR language code')
assert.equal(getXunfeiLanguageParam('en-US'), 'en', 'English uses the documented iFLYTEK RTASR code')
assert.equal(getXunfeiLanguageParam('zh-CN'), 'cn', 'Mandarin uses the iFLYTEK RTASR code')

assert.equal(getASRLanguageError('xunfei', 'ug-CN'), null, 'iFLYTEK accepts Uyghur')
assert.match(getASRLanguageError('aliyun', 'ug-CN'), /科大讯飞/, 'unsupported providers explain the Uyghur requirement')

let providerError = ''
const unsupportedSession = createCloudASRSession(
  { provider: 'aliyun', lang: 'ug-CN', aliyunApiKey: 'sk-validplaceholder123456789012345' },
  () => {},
  message => { providerError = message },
  () => {},
)
assert.equal(unsupportedSession, null, 'unsupported Uyghur provider is rejected before opening a session')
assert.match(providerError, /科大讯飞/, 'runtime rejection tells the user which provider to select')

console.log('PASS voice language normalization and Uyghur provider routing')
