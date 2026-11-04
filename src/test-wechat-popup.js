import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

const source = fs.readFileSync(new URL('./ui/brain-ui/wechat-popup.js', import.meta.url), 'utf8')
  .replace(/^import .*;\n/, 'const API = "http://test";\n').replaceAll('export ', '');
const response = data => ({ ok: true, json: async () => data });
function setup(fetch) {
  const elements = new Map();
  const timers = new Map();
  const events = {};
  let id = 0;
  const element = () => ({
    style: {}, textContent: '', attributes: new Set(), handlers: {},
    setAttribute(key) { this.attributes.add(key); },
    removeAttribute(key) { this.attributes.delete(key); },
    hasAttribute(key) { return this.attributes.has(key); },
    addEventListener(key, fn) { this.handlers[key] = fn; },
  });
  const context = vm.createContext({
    fetch, encodeURIComponent,
    document: {
      createElement: element, body: { appendChild() {} },
      getElementById(key) { if (!elements.has(key)) elements.set(key, element()); return elements.get(key); },
    },
    window: { addEventListener(name, handler) { events[name] = handler; } },
    setInterval(fn) { timers.set(++id, fn); return id; },
    clearInterval(id) { timers.delete(id); }, setTimeout() {}, clearTimeout() {},
  });
  vm.runInContext(source, context);
  context.initWechatPopup();
  return { context, timers, emit: detail => events['bailongma:social_status']({ detail: { platform: 'wechat-clawbot', ...detail } }), get: suffix => elements.get(`wechat-popup-${suffix}`) };
}

test('opening an unconnected popup automatically requests and displays a QR code', async () => {
  const calls = [];
  const replies = [{ status: 'idle' }, { ok: true }, { status: 'qr_ready', qr_url: 'https://wechat.test/scan?a=1' }];
  const ui = setup(async (url, options) => { calls.push({ url, options }); return response(replies.shift()); });
  await ui.context.showWechatPopup();
  assert.equal(calls.length, 3);
  assert.deepEqual(JSON.parse(calls[1].options.body), { _clawbot_connect: '1' });
  assert.equal(ui.get('qr-wrap').style.display, 'block');
  assert.match(ui.get('qr-img').src, /data=https%3A%2F%2Fwechat.test/);
  assert.equal(ui.timers.size, 1);
  await ui.context.showWechatPopup();
  assert.equal(calls.length, 3, 'repeated open does not restart login');
  ui.context.hideWechatPopup();
  assert.equal(ui.timers.size, 0);
});

for (const status of ['connected', 'qr_pending', 'qr_ready']) {
  test(`opening preserves ${status} without starting another login`, async () => {
    let calls = 0;
    const ui = setup(async () => { calls++; return response({ status, qr_url: 'https://wechat.test' }); });
    await ui.context.showWechatPopup();
    assert.equal(calls, 1);
    assert.equal(ui.timers.size, status === 'connected' ? 0 : 1);
  });
}

test('failed connection exposes retry and does not poll forever', async () => {
  let calls = 0;
  const ui = setup(async () => ++calls === 1 ? response({ status: 'idle' }) : { ok: false });
  await ui.context.showWechatPopup();
  assert.equal(ui.get('connect-btn').disabled, false);
  assert.equal(ui.get('connect-btn').textContent, '重试连接');
  assert.equal(ui.timers.size, 0);
});

test('closing while status loads prevents a late connection request', async () => {
  let resolve;
  let calls = 0;
  const ui = setup(() => { calls++; return new Promise(r => { resolve = r; }); });
  const opening = ui.context.showWechatPopup();
  ui.context.hideWechatPopup();
  resolve(response({ status: 'idle' }));
  await opening;
  assert.equal(calls, 1);
  assert.equal(ui.timers.size, 0);
});


test('retry after a failed status query preserves an existing connection', async () => {
  let calls = 0;
  const ui = setup(async () => ++calls === 1 ? { ok: false } : response({ status: 'connected' }));
  await ui.context.showWechatPopup();
  await ui.get('connect-btn').handlers.click({});
  assert.equal(calls, 2, 'retry only queries status, without posting a restart');
  assert.equal(ui.get('connect-btn').style.display, 'none');
  assert.equal(ui.get('logout-btn').style.display, 'inline-flex');
});

test('a delayed poll cannot undo the connected event', async () => {
  let resolve;
  let calls = 0;
  const ui = setup(() => ++calls === 1 ? response({ status: 'qr_ready', qr_url: 'https://wechat.test' }) : new Promise(r => { resolve = r; }));
  await ui.context.showWechatPopup();
  const polling = [...ui.timers.values()][0]();
  ui.emit({ status: 'connected' });
  resolve(response({ status: 'qr_ready', qr_url: 'https://wechat.test' }));
  await polling;
  assert.equal(ui.get('status').textContent, '● 已连接');
  assert.equal(ui.get('qr-wrap').style.display, 'none');
  assert.equal(ui.timers.size, 0);
});

for (const status of ['error', 'session_expired']) {
  test(`opening with ${status} automatically starts a new login`, async () => {
    const replies = [{ status }, { ok: true }, { status: 'qr_pending' }];
    const ui = setup(async () => response(replies.shift()));
    await ui.context.showWechatPopup();
    assert.equal(replies.length, 0);
    assert.equal(ui.timers.size, 1);
  });
}

test('expired QR polling stops and allows retry', async () => {
  const replies = [{ status: 'qr_ready', qr_url: 'https://wechat.test' }, { status: 'idle' }];
  const ui = setup(async () => response(replies.shift()));
  await ui.context.showWechatPopup();
  await [...ui.timers.values()][0]();
  assert.equal(ui.timers.size, 0);
  assert.equal(ui.get('connect-btn').disabled, false);
  assert.equal(ui.get('qr-wrap').style.display, 'none');
});
