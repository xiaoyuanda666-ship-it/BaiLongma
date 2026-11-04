import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { splitSpeechText, synthesizeSpeechSegments, normalizeDoubaoCues } from './voice/speech-session.js'
import { visibleSpeechText, createSpeechPlayback } from './ui/brain-ui/speech-playback.js'
const source = '你好。第二句！还有英文 hello.'
assert.equal(splitSpeechText(source, 7).join(''), source)
assert.deepEqual(normalizeDoubaoCues({ words: [{ text:'你好',start_time:0,end_time:1 }] }, '你好。'), [{ startMs:0,endMs:1000,endOffset:2 }])
for (const provider of ['doubao','xiaomi']) {
 const out=[]
 for await (const item of synthesizeSpeechSegments({ text:'你好。再见。',credentials:{provider,doubaoKey:'test',xiaomiKey:'test'} }, { synthesize:async args=>{
  if(provider==='doubao')args.onMetadata({words:[{text:args.text,start_time:0,end_time:1}]})
  return Readable.from([Buffer.from('audio')])
 }}))out.push(item)
 assert.equal(out.length,2)
 assert.equal(out[0].alignment,provider==='doubao'?'provider':'estimated')
}
assert.equal(visibleSpeechText({text:'一二三四',alignment:'estimated'},2,4),'一二')
assert.equal(visibleSpeechText({text:'一二',alignment:'estimated'},0,NaN),'')
assert.equal(visibleSpeechText({text:'一二',alignment:'provider',cues:[{startMs:100,endOffset:1},{startMs:200,endOffset:2}]},.15,2),'一')
let resumes=0;let pauses=0;const shown=[];const states=[]
const message={content:'第一句。第二句。',speech:{id:'session',segments:[{text:'第一句。',path:'a',alignment:'estimated'},{text:'第二句。',path:'b',alignment:'estimated'}]}}
function fakeAudio(fail=false){return {currentTime:0,duration:4,pause(){},removeAttribute(){},load(){},async play(){if(fail)throw Error('blocked');this.currentTime=2;this.ontimeupdate();this.currentTime=4;this.onended()}}}
const player=createSpeechPlayback({createAudio:()=>fakeAudio(),suspend:()=>pauses++,resume:()=>resumes++})
assert.equal(await player.play(message,{render:t=>shown.push(t),status:t=>states.push(t)}),true)
assert.ok(shown.includes('第一'));assert.ok(shown.includes('第一句。第二'));assert.equal(shown.at(-1),message.content)
assert.equal(resumes,1);assert.equal(pauses,1)
assert.equal(await player.play(message,{render(){}}),false,'duplicate event must not replay')
const failing=createSpeechPlayback({createAudio:()=>fakeAudio(true)})
assert.equal(await failing.play(message,{render:t=>shown.push(t),status:t=>states.push(t)}),false)
assert.equal(shown.at(-1),message.content);assert.ok(states.includes('播放失败，可重试'))
let current
const interrupted=createSpeechPlayback({createAudio:()=>{current=fakeAudio();current.play=async()=>{};return current}})
const pending=interrupted.play(message,{render:t=>shown.push(t)})
interrupted.stop();assert.equal(await pending,false);assert.equal(shown.at(-1),message.content)
console.log('PASS provider normalization, audio-clock text, duplicate prevention, playback failure and interruption')

assert.deepEqual(normalizeDoubaoCues({sentence:{words:[{text:'你',startTime:0.115,endTime:0.445}]}},'你好'),[{startMs:115,endMs:445,endOffset:1}])
const abort = new AbortController();abort.abort()
await assert.rejects(async()=>{for await(const s of synthesizeSpeechSegments({text:'你好',credentials:{provider:'xiaomi',xiaomiKey:'test'},signal:abort.signal})) {}},{name:'AbortError'})
console.log('PASS real Doubao seconds-to-ms format and aborted synthesis')
