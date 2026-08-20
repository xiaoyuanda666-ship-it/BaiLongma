import assert from 'node:assert/strict';
import { HotspotEarth } from './ui/brain-ui/hotspot-earth.js';

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

console.log('Hotspot earth lifecycle tests passed');
