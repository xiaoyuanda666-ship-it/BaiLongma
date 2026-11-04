const { app, BrowserWindow } = require('electron');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const root = process.cwd();
const source = fs.readFileSync(path.join(root, 'src/ui/brain-ui/app.js'), 'utf8');
const render = source.slice(source.indexOf('function renderCognition('), source.indexOf('function restoreCognitionHistory('));
const fixture = `<!doctype html><html><head><link rel="stylesheet" href="/src/ui/brain-ui/styles.css"><style>body{display:block;margin:0;padding:20px;background:#101720;color:#e8edf6}.cognition-module{width:380px;height:720px;position:relative}.cognition-surface{height:100%}.stream{height:640px;overflow:auto}.l2-module{border:1px solid #48566a;border-radius:16px;padding:20px}h2{font-size:16px}</style></head><body><section class="l2-module cognition-module"><div class="cognition-surface"><h2>Bailongma · 思考与工具</h2><span id="cognition-state"></span><div class="stream"><div id="si-l2"></div></div></div></section><script type="module">
import { ThoughtStream } from '/src/ui/brain-ui/thought-stream.js';
import { t } from '/src/ui/brain-ui/i18n/index.js';
const L2 = new ThoughtStream('si-l2','warm',{historyLimit:120});
function revealCognitionStream() {}
function setCognitionState(label,state) { document.getElementById('cognition-state').textContent=label; }
function heartbeatClock() { return '01:00:00'; }
${render}
L2.beginRound();
renderCognition({phase:'plan',round:0,summary:'读取配置文件，确认当前版本。',expected:'获得文件内容和版本号。',observation:'尚无工具结果。',decision:'continue'});
L2.tool('read_file',{path:'missing.txt'},JSON.stringify({ok:false,error:'文件不存在'}),false);
renderCognition({phase:'assessment',round:1,summary:'原路径不存在，改用已确认的配置路径。',expected:'成功读取版本号。',observation:'上一步返回文件不存在，与预期不符。',decision:'replan'});
L2.tool('read_file',{path:'config.json'},JSON.stringify({ok:true,content:'version: 2.2.164'}),true);
renderCognition({phase:'assessment',round:2,summary:'已读取版本号，可以汇报结果。',expected:'用户收到已验证的版本信息。',observation:'文件返回版本 2.2.164，符合预期。',decision:'finish'});
L2.end();
setCognitionState('本轮完成','done');
window.fixtureReady = true;
</script></body></html>`;
const server = http.createServer((req,res)=>{
 if(req.url==='/fixture'){res.setHeader('Content-Type','text/html; charset=utf-8');res.end(fixture);return;}
 const file=path.join(root,decodeURIComponent(req.url.split('?')[0]));
 if(!file.startsWith(root+path.sep)){res.writeHead(403);res.end();return;}
 try {res.setHeader('Content-Type',file.endsWith('.css')?'text/css':'text/javascript');res.end(fs.readFileSync(file));}catch{res.writeHead(404);res.end();}
});
(async()=>{await app.whenReady();await new Promise(r=>server.listen(0,'127.0.0.1',r));const win=new BrowserWindow({show:false,width:430,height:800,webPreferences:{contextIsolation:true}});await win.loadURL(`http://127.0.0.1:${server.address().port}/fixture`);
const check=await win.webContents.executeJavaScript(`new Promise((resolve,reject)=>{let count=0;const timer=setInterval(()=>{if(window.fixtureReady){clearInterval(timer);resolve({text:document.body.innerText,lines:document.querySelectorAll('.stream-line').length});}else if(++count>50){clearInterval(timer);reject(new Error('fixture timeout'));}},50);})`);
if(!check.text.includes('重新规划')||!check.text.includes('版本 2.2.164')||check.lines<3)throw Error(JSON.stringify(check));
await win.webContents.executeJavaScript(`document.querySelector('.stream').scrollTop=0`);
fs.writeFileSync(path.join(root,'.dev-test/cognition-preview.png'),(await win.webContents.capturePage()).toPNG());console.log('PASS real Electron rendering: plan, failure, replan, assessment retained');win.destroy();server.close();app.quit();})().catch(e=>{console.error(e);server.close();app.exit(1)});
