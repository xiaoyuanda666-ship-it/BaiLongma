import assert from 'node:assert/strict';
import fs from 'node:fs';
import { HotspotEarth } from './ui/brain-ui/hotspot-earth.js';
import {
  HOTSPOT_EARTH_RELEASE_MS,
  HotspotEarthLifecycle,
} from './ui/brain-ui/hotspot-earth-lifecycle.js';
import { createHotspotPanel } from './ui/brain-ui/hotspot-panel.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createFakeClock() {
  let now = 0;
  let nextId = 1;
  const timers = new Map();
  return {
    setTimeout(callback, delay) {
      const id = nextId++;
      timers.set(id, { callback, at: now + delay });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    advance(ms) {
      now += ms;
      while (true) {
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.at <= now)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        due[1].callback();
      }
    },
    get size() {
      return timers.size;
    },
  };
}

class FakeEarth {
  constructor(name, initialization = deferred()) {
    this.name = name;
    this.initialization = initialization;
    this.initCalls = 0;
    this.pauseCalls = 0;
    this.resumeCalls = 0;
    this.presentCalls = 0;
    this.disposeCalls = 0;
  }

  init() {
    this.initCalls += 1;
    return this.initialization.promise;
  }

  pause() {
    this.pauseCalls += 1;
  }

  resume() {
    this.resumeCalls += 1;
  }

  present() {
    this.presentCalls += 1;
    this.resume();
  }

  dispose() {
    this.disposeCalls += 1;
  }
}

function createHarness(earths) {
  const clock = createFakeClock();
  const states = [];
  const errors = [];
  let createCalls = 0;
  const lifecycle = new HotspotEarthLifecycle({
    createEarth() {
      const earth = earths[createCalls];
      createCalls += 1;
      if (!earth) throw new Error(`unexpected earth creation #${createCalls}`);
      return earth;
    },
    onStateChange(state) {
      states.push(state);
    },
    onError(error) {
      errors.push(error);
    },
    setReleaseTimeout: clock.setTimeout,
    clearReleaseTimeout: clock.clearTimeout,
  });
  return { lifecycle, clock, states, errors, get createCalls() { return createCalls; } };
}

// The status overlay itself must be present on the first paint and must not inherit
// the panel's old 500 ms staggered boot delay.
{
  const panelMarkup = createHotspotPanel();
  const styles = fs.readFileSync(new URL('./ui/brain-ui/styles.css', import.meta.url), 'utf8');
  assert.match(panelMarkup, /id="hs-earth-container"[^>]+data-earth-state="idle"/);
  assert.match(panelMarkup, /id="hs-earth-status"[^>]+role="status"/);
  assert.match(panelMarkup, /id="hs-earth-retry"/);
  assert.equal(styles.includes('.hotspot-panel.hs-booting .hs-earth-container'), false,
    'the earth loading feedback is not hidden by the staggered panel boot sequence');
  assert.match(styles, /\[data-earth-state="loading"\] \.hs-earth-status/);
  assert.match(styles, /\[data-earth-state="failed"\] \.hs-earth-retry/);
}

// First open: loading must be synchronous and end only when initialization reports a rendered scene.
{
  const first = new FakeEarth('first');
  const harness = createHarness([first]);
  const opened = harness.lifecycle.open();
  assert.deepEqual(harness.states, ['loading'], 'first open immediately exposes loading feedback');
  assert.equal(harness.createCalls, 1);
  assert.equal(first.resumeCalls, 0, 'the animation loop does not start before initialization');

  first.initialization.resolve(first);
  assert.equal(await opened, first);
  assert.deepEqual(harness.states, ['loading', 'ready']);
  assert.equal(first.initCalls, 1);
  assert.equal(first.presentCalls, 1, 'a new earth submits its animated first frame');
  assert.equal(first.resumeCalls, 1);
}

// Reopen inside five minutes: reuse the renderer but replay the entrance animation.
{
  const retained = new FakeEarth('retained');
  const harness = createHarness([retained]);
  const opened = harness.lifecycle.open();
  retained.initialization.resolve(retained);
  await opened;

  harness.lifecycle.close();
  harness.lifecycle.close();
  assert.equal(retained.pauseCalls, 1, 'repeated close does not duplicate lifecycle work');
  assert.equal(harness.clock.size, 1, 'only one release timer is retained');
  harness.clock.advance(HOTSPOT_EARTH_RELEASE_MS - 1);
  assert.equal(retained.disposeCalls, 0);

  await harness.lifecycle.open();
  assert.equal(harness.clock.size, 0, 'reopen cancels the pending release');
  assert.equal(harness.createCalls, 1, 'the retained renderer is reused');
  assert.equal(retained.initCalls, 1, 'the retained scene is not initialized twice');
  assert.equal(retained.presentCalls, 2, 'every panel entrance replays the earth animation');
  assert.equal(retained.resumeCalls, 2);
  assert.equal(harness.states.filter((state) => state === 'loading').length, 1,
    'retained resources animate without pretending to initialize again');
  assert.equal(harness.states.at(-1), 'ready');
}

// Reopen after five minutes: dispose the old context and synchronously show loading for a new one.
{
  const oldEarth = new FakeEarth('old');
  const rebuiltEarth = new FakeEarth('rebuilt');
  const harness = createHarness([oldEarth, rebuiltEarth]);
  const firstOpen = harness.lifecycle.open();
  oldEarth.initialization.resolve(oldEarth);
  await firstOpen;
  harness.lifecycle.close();
  harness.clock.advance(HOTSPOT_EARTH_RELEASE_MS);
  assert.equal(oldEarth.disposeCalls, 1);

  const rebuilt = harness.lifecycle.open();
  assert.equal(harness.states.at(-1), 'loading', 'post-release reopen immediately returns to loading');
  assert.equal(harness.createCalls, 2);
  rebuiltEarth.initialization.resolve(rebuiltEarth);
  assert.equal(await rebuilt, rebuiltEarth);
  assert.equal(rebuiltEarth.initCalls, 1);
  assert.equal(rebuiltEarth.presentCalls, 1, 'a rebuilt scene replays its entrance animation');
  assert.equal(rebuiltEarth.resumeCalls, 1);
  assert.equal(harness.states.at(-1), 'ready');
}

// Failure: surface a retry state, dispose partial resources, and allow a real retry.
{
  const failedEarth = new FakeEarth('failed');
  const retryEarth = new FakeEarth('retry');
  const harness = createHarness([failedEarth, retryEarth]);
  const failedOpen = harness.lifecycle.open();
  const initializationError = new Error('WebGL unavailable');
  failedEarth.initialization.reject(initializationError);
  assert.equal(await failedOpen, null);
  assert.equal(harness.states.at(-1), 'failed');
  assert.equal(harness.errors.at(-1), initializationError);
  assert.equal(failedEarth.disposeCalls, 1, 'partial resources are released after failure');

  const retried = harness.lifecycle.retry();
  assert.equal(harness.states.at(-1), 'loading', 'retry restores feedback synchronously');
  retryEarth.initialization.resolve(retryEarth);
  assert.equal(await retried, retryEarth);
  assert.equal(harness.states.at(-1), 'ready');
  assert.equal(harness.createCalls, 2);
}

// If initialization finishes while hidden, defer the entrance until the panel is visible again.
{
  const hiddenEarth = new FakeEarth('hidden-during-init');
  const harness = createHarness([hiddenEarth]);
  const opened = harness.lifecycle.open();
  harness.lifecycle.close();
  hiddenEarth.initialization.resolve(hiddenEarth);
  assert.equal(await opened, hiddenEarth);
  assert.equal(hiddenEarth.presentCalls, 0);

  assert.equal(await harness.lifecycle.open(), hiddenEarth);
  assert.deepEqual(harness.states.slice(-2), ['loading', 'ready']);
  assert.equal(hiddenEarth.presentCalls, 1);
}

// A retained renderer that can no longer resume is not treated as valid or left blank.
{
  const invalidEarth = new FakeEarth('invalid-retained');
  const harness = createHarness([invalidEarth]);
  const opened = harness.lifecycle.open();
  invalidEarth.initialization.resolve(invalidEarth);
  await opened;
  harness.lifecycle.close();
  invalidEarth.resume = () => { throw new Error('WebGL context lost'); };

  assert.equal(await harness.lifecycle.open(), null);
  assert.equal(harness.states.at(-1), 'failed');
  assert.equal(invalidEarth.disposeCalls, 1);
}

// A retained renderer with a lost WebGL context is rebuilt instead of being shown as ready.
{
  const contextLostEarth = new FakeEarth('context-lost');
  const replacementEarth = new FakeEarth('context-replacement');
  const harness = createHarness([contextLostEarth, replacementEarth]);
  const opened = harness.lifecycle.open();
  contextLostEarth.initialization.resolve(contextLostEarth);
  await opened;
  harness.lifecycle.close();
  contextLostEarth.isUsable = () => false;

  const rebuilt = harness.lifecycle.open();
  assert.equal(harness.states.at(-1), 'loading');
  assert.equal(contextLostEarth.disposeCalls, 1);
  assert.equal(harness.createCalls, 2);
  replacementEarth.initialization.resolve(replacementEarth);
  assert.equal(await rebuilt, replacementEarth);
  assert.equal(harness.states.at(-1), 'ready');
}

// Rapid toggles: share a still-valid task, then reject stale work after a timed release/rebuild.
{
  const staleEarth = new FakeEarth('stale');
  const currentEarth = new FakeEarth('current');
  const harness = createHarness([staleEarth, currentEarth]);

  const staleOpen = harness.lifecycle.open();
  harness.lifecycle.close();
  const sharedOpen = harness.lifecycle.open();
  assert.equal(sharedOpen, staleOpen, 'quick reopen shares the valid in-flight initialization');
  assert.equal(harness.createCalls, 1);

  harness.lifecycle.close();
  harness.clock.advance(HOTSPOT_EARTH_RELEASE_MS);
  assert.equal(staleEarth.disposeCalls, 1);

  const currentOpen = harness.lifecycle.open();
  currentEarth.initialization.resolve(currentEarth);
  assert.equal(await currentOpen, currentEarth);
  const readyStateCount = harness.states.filter((state) => state === 'ready').length;

  staleEarth.initialization.reject(new Error('late stale failure'));
  assert.equal(await staleOpen, null);
  assert.equal(await sharedOpen, null);
  assert.equal(harness.states.at(-1), 'ready', 'stale work cannot replace the current ready state');
  assert.equal(harness.states.filter((state) => state === 'ready').length, readyStateCount);
  assert.equal(harness.states.includes('failed'), false, 'a stale failure is ignored');
  assert.equal(staleEarth.resumeCalls, 0, 'a released instance never restarts its animation loop');
  assert.equal(currentEarth.resumeCalls, 1);
}

// Low-level WebGL disposal: release once and replace the canvas whose context was force-lost.
{
  const calls = [];
  const parent = {};
  const replacementCanvas = {
    id: 'hs-earth-canvas',
    parentNode: parent,
  };
  let currentCanvas = null;

  const canvas = {
    id: 'hs-earth-canvas',
    parentNode: parent,
    removeEventListener() {},
    cloneNode(deep) {
      calls.push('canvas.clone');
      assert.equal(deep, false, 'the replacement must not inherit runtime children');
      return replacementCanvas;
    },
    replaceWith(next) {
      calls.push('canvas.replace');
      assert.equal(next, replacementCanvas);
      currentCanvas = next;
      this.parentNode = null;
    },
  };
  currentCanvas = canvas;

  const earth = new HotspotEarth(canvas);
  earth.scene = { traverse() {} };
  earth.renderer = {
    renderLists: {
      dispose() { calls.push('renderLists.dispose'); },
    },
    dispose() { calls.push('renderer.dispose'); },
    forceContextLoss() { calls.push('renderer.forceContextLoss'); },
  };

  const freshCanvas = earth.dispose();
  assert.equal(freshCanvas, replacementCanvas, 'dispose returns the fresh canvas');
  assert.equal(currentCanvas, replacementCanvas, 'the lost-context canvas is replaced in the DOM');
  assert.equal(earth.canvas, null, 'the disposed instance releases its canvas reference');
  assert.deepEqual(calls, [
    'renderLists.dispose',
    'renderer.dispose',
    'renderer.forceContextLoss',
    'canvas.clone',
    'canvas.replace',
  ]);

  const reopenedEarth = new HotspotEarth(currentCanvas);
  assert.equal(reopenedEarth.canvas, replacementCanvas, 'reopening uses the fresh canvas');
  assert.equal(reopenedEarth.disposed, false, 'the replacement instance can initialize normally');
  assert.equal(earth.dispose(), null, 'repeated disposal is a no-op');
  assert.equal(calls.filter((call) => call === 'renderer.forceContextLoss').length, 1,
    'the old WebGL context is released only once');
}

console.log('Hotspot earth lifecycle tests passed');
