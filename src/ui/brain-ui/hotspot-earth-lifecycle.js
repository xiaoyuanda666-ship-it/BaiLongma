export const HOTSPOT_EARTH_RELEASE_MS = 5 * 60 * 1000;

// Keep the WebGL instance while the panel is only briefly hidden, but make every
// asynchronous completion prove that it still belongs to the current resource.
export class HotspotEarthLifecycle {
  constructor({
    createEarth,
    onStateChange = () => {},
    onError = () => {},
    releaseMs = HOTSPOT_EARTH_RELEASE_MS,
    setReleaseTimeout = globalThis.setTimeout?.bind(globalThis),
    clearReleaseTimeout = globalThis.clearTimeout?.bind(globalThis),
  } = {}) {
    if (typeof createEarth !== 'function') throw new TypeError('createEarth must be a function');
    this.createEarth = createEarth;
    this.onStateChange = onStateChange;
    this.onError = onError;
    this.releaseMs = releaseMs;
    this.setReleaseTimeout = setReleaseTimeout;
    this.clearReleaseTimeout = clearReleaseTimeout;

    this.active = false;
    this.earth = null;
    this.ready = false;
    this.initPromise = null;
    this.releaseTimer = null;
    this.resourceVersion = 0;
  }

  open() {
    this.active = true;
    this._clearReleaseTimer();

    if (this.earth && this.ready) {
      const instance = this.earth;
      let usable = true;
      try {
        if (typeof instance.isUsable === 'function') usable = instance.isUsable();
      } catch (error) {
        usable = false;
        this.onError(error);
      }
      if (!usable) {
        this._releaseCurrentEarth();
        this.onStateChange('loading');
        return this._ensureEarth();
      }
      // WebGL/贴图资源可以复用，但每次面板重新入场都重播地球放大动画。
      return Promise.resolve(this._presentReadyEarth(instance) ? instance : null);
    }

    // This notification is deliberately synchronous so the first visible paint
    // can never be an empty earth container.
    this.onStateChange('loading');
    return this._ensureEarth();
  }

  close() {
    if (!this.active) return;
    this.active = false;
    this.earth?.pause();
    this._scheduleRelease();
  }

  retry() {
    if (!this.active) return Promise.resolve(null);
    this._releaseCurrentEarth();
    this.onStateChange('loading');
    return this._ensureEarth();
  }

  pause() {
    this.earth?.pause();
  }

  resume() {
    if (this.active && this.ready && this.earth) this._resumeReadyEarth(this.earth);
  }

  release() {
    this._clearReleaseTimer();
    this._releaseCurrentEarth();
  }

  _ensureEarth() {
    if (this.initPromise) return this.initPromise;

    let instance;
    try {
      instance = this.createEarth();
      if (!instance) throw new Error('3D earth canvas is unavailable');
    } catch (error) {
      this._reportFailure(error);
      return Promise.resolve(null);
    }

    const version = ++this.resourceVersion;
    this.earth = instance;
    this.ready = false;

    const pending = Promise.resolve()
      .then(() => instance.init())
      .then((initialized) => {
        if (!initialized) throw new Error('3D earth initialization did not produce a rendered scene');
        if (!this._isCurrent(instance, version)) return null;

        this.ready = true;
        if (this.active) {
          if (!this._presentReadyEarth(instance)) return null;
        } else {
          instance.pause();
        }
        return instance;
      })
      .catch((error) => {
        if (!this._isCurrent(instance, version)) return null;
        this.earth = null;
        this.ready = false;
        this.resourceVersion += 1;
        try { instance.dispose(); } catch (disposeError) { this.onError(disposeError); }
        this._reportFailure(error);
        return null;
      })
      .finally(() => {
        if (this.initPromise === pending) this.initPromise = null;
      });

    this.initPromise = pending;
    return pending;
  }

  _reportFailure(error) {
    this.onError(error);
    if (this.active) this.onStateChange('failed', error);
  }

  _resumeReadyEarth(instance) {
    try {
      instance.resume();
      this.onStateChange('ready');
      return true;
    } catch (error) {
      if (this.earth === instance) this._releaseCurrentEarth();
      this._reportFailure(error);
      return false;
    }
  }

  _presentReadyEarth(instance) {
    try {
      if (typeof instance.present === 'function') instance.present();
      else instance.resume();
      this.onStateChange('ready');
      return true;
    } catch (error) {
      if (this.earth === instance) this._releaseCurrentEarth();
      this._reportFailure(error);
      return false;
    }
  }

  _isCurrent(instance, version) {
    return this.earth === instance && this.resourceVersion === version;
  }

  _scheduleRelease() {
    this._clearReleaseTimer();
    if (typeof this.setReleaseTimeout !== 'function') return;
    this.releaseTimer = this.setReleaseTimeout(() => {
      this.releaseTimer = null;
      if (!this.active) this._releaseCurrentEarth();
    }, this.releaseMs);
  }

  _clearReleaseTimer() {
    if (this.releaseTimer !== null && typeof this.clearReleaseTimeout === 'function') {
      this.clearReleaseTimeout(this.releaseTimer);
    }
    this.releaseTimer = null;
  }

  _releaseCurrentEarth() {
    const instance = this.earth;
    this.earth = null;
    this.ready = false;
    this.initPromise = null;
    this.resourceVersion += 1;
    try { instance?.dispose(); } catch (error) { this.onError(error); }
  }
}
