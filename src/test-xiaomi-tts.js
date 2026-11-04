import assert from 'node:assert/strict'
import { streamXiaomi } from './voice/tts-providers.js'
const original = globalThis.fetch
try {
 globalThis.fetch=async(url,options)=>{
  assert.equal(url,'https://api.xiaomimimo.com/v1/chat/completions')
  assert.equal(options.headers['api-key'],'test-key')
  const body=JSON.parse(options.body)
  assert.equal(body.messages[0].role,'assistant');assert.equal(body.messages[0].content,'你好')
  assert.equal(body.audio.format,'mp3');assert.equal(body.model,'mimo-v2.5-tts')
  return {ok:true,json:async()=>({choices:[{message:{audio:{data:Buffer.from('test audio').toString('base64')}}}]})}
 }
 const chunks=[];for await(const chunk of await streamXiaomi({text:'你好',apiKey:'test-key'}))chunks.push(chunk)
 assert.equal(Buffer.concat(chunks).toString(),'test audio')
 globalThis.fetch=async()=>({ok:false,status:401})
 await assert.rejects(streamXiaomi({text:'你好',apiKey:'test-key'}),/401/)
 globalThis.fetch=async()=>({ok:true,json:async()=>({choices:[]})})
 await assert.rejects(streamXiaomi({text:'你好',apiKey:'test-key'}),/未返回音频/)
}finally{globalThis.fetch=original}
console.log('PASS Xiaomi request shape, authentication, audio normalization and provider errors')
