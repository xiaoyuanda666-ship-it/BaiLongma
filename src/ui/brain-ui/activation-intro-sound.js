const SOUND_ROOT = "/src/ui/brain-ui/assets";
const MAX_EVENT_LATENESS_SECONDS = 0.32;

export const ACTIVATION_INTRO_SOUND_EVENTS = Object.freeze([
  { id: "startup", at: 0, file: "intro-startup.mp3", gain: 0.62 },
  { id: "bailongma", at: 1.49, file: "intro-bailongma.mp3", gain: 0.52 },
  { id: "task-1", at: 3.34, file: "intro-tasks.mp3", gain: 0.36 },
  { id: "task-2", at: 3.80, file: "intro-tasks.mp3", gain: 0.36 },
  { id: "task-3", at: 4.26, file: "intro-tasks.mp3", gain: 0.36 },
  { id: "task-4", at: 4.72, file: "intro-tasks.mp3", gain: 0.36 },
  { id: "week-1", at: 6.60, file: "intro-week.mp3", gain: 0.22 },
  { id: "week-2", at: 6.71, file: "intro-week.mp3", gain: 0.22 },
  { id: "week-3", at: 6.82, file: "intro-week.mp3", gain: 0.22 },
  { id: "week-4", at: 6.93, file: "intro-week.mp3", gain: 0.22 },
  { id: "week-5", at: 7.04, file: "intro-week.mp3", gain: 0.22 },
  { id: "week-6", at: 7.15, file: "intro-week.mp3", gain: 0.22 },
  { id: "week-7", at: 7.26, file: "intro-week.mp3", gain: 0.22 },
  { id: "time", at: 7.90, file: "intro-time.mp3", gain: 0.52 },
]);

export function createActivationIntroSoundscape({ level = 0.72, onEvent, onStateChange } = {}) {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  const canPlayAudio = typeof window.Audio === "function";
  const notifyState = (state) => {
    try { onStateChange?.(state); } catch {}
  };

  if (!canPlayAudio) {
    notifyState("unavailable");
    return {
      audioContext: null,
      start() {},
      update() {},
      stop() {},
    };
  }

  let audioContext = null;
  let mixBus = null;
  let running = false;
  let previousSeconds = -0.001;
  const firedEvents = new Set();
  const activeSounds = new Set();
  const audioTemplates = new Map();

  for (const event of ACTIVATION_INTRO_SOUND_EVENTS) {
    if (audioTemplates.has(event.file)) continue;
    const template = new Audio(`${SOUND_ROOT}/${event.file}`);
    template.preload = "auto";
    template.load();
    audioTemplates.set(event.file, template);
  }

  if (AudioContextClass) {
    try {
      audioContext = new AudioContextClass({ latencyHint: "interactive" });
      mixBus = audioContext.createGain();
      const compressor = audioContext.createDynamicsCompressor();
      const masterGain = audioContext.createGain();
      mixBus.gain.value = 1;
      compressor.threshold.value = -24;
      compressor.knee.value = 18;
      compressor.ratio.value = 5;
      compressor.attack.value = 0.004;
      compressor.release.value = 0.24;
      masterGain.gain.value = Math.max(0, Math.min(1, Number(level) || 0.72));
      mixBus.connect(compressor);
      compressor.connect(masterGain);
      masterGain.connect(audioContext.destination);
    } catch (error) {
      console.warn("[brain-ui] welcome sound mix unavailable:", error?.message || error);
      try { audioContext?.close(); } catch {}
      audioContext = null;
      mixBus = null;
    }
  }

  function playEvent(event) {
    const template = audioTemplates.get(event.file);
    if (!template) return;

    const audio = template.cloneNode(true);
    const active = { audio, source: null, gain: null };
    const cleanup = () => {
      activeSounds.delete(active);
      try { active.source?.disconnect(); } catch {}
      try { active.gain?.disconnect(); } catch {}
    };

    audio.preload = "auto";
    audio.currentTime = 0;
    audio.addEventListener("ended", cleanup, { once: true });
    audio.addEventListener("error", cleanup, { once: true });

    if (audioContext && mixBus) {
      try {
        active.source = audioContext.createMediaElementSource(audio);
        active.gain = audioContext.createGain();
        active.gain.gain.value = event.gain;
        active.source.connect(active.gain);
        active.gain.connect(mixBus);
        audio.volume = 1;
      } catch (error) {
        console.warn("[brain-ui] welcome sound routing unavailable:", error?.message || error);
        audio.volume = Math.max(0, Math.min(1, event.gain * level));
      }
    } else {
      audio.volume = Math.max(0, Math.min(1, event.gain * level));
    }

    activeSounds.add(active);
    audio.play().catch((error) => {
      cleanup();
      if (running) {
        console.warn("[brain-ui] welcome sound could not play:", error?.message || error);
      }
    });
  }

  function start() {
    if (running) return;
    running = true;
    previousSeconds = -0.001;
    firedEvents.clear();
    notifyState("starting");
    if (!audioContext) {
      notifyState("running");
      return;
    }
    audioContext.resume()
      .then(() => {
        if (running && audioContext) {
          notifyState(audioContext.state === "running" ? "running" : "suspended");
        }
      })
      .catch(() => {
        if (running) notifyState("suspended");
      });
  }

  function update(seconds) {
    if (!running) return;
    const currentSeconds = Math.max(0, Number(seconds) || 0);
    if (currentSeconds < previousSeconds - 0.2) {
      firedEvents.clear();
      previousSeconds = -0.001;
    }

    for (const event of ACTIVATION_INTRO_SOUND_EVENTS) {
      if (firedEvents.has(event.id)) continue;
      if (event.at > currentSeconds) continue;
      firedEvents.add(event.id);
      if (currentSeconds - event.at > MAX_EVENT_LATENESS_SECONDS) continue;
      try { onEvent?.(event.id); } catch {}
      playEvent(event);
    }
    previousSeconds = currentSeconds;
  }

  function stop() {
    if (!running && !audioContext && activeSounds.size === 0) return;
    running = false;
    notifyState("stopped");
    for (const active of activeSounds) {
      try { active.audio.pause(); } catch {}
      try { active.audio.currentTime = 0; } catch {}
      try { active.source?.disconnect(); } catch {}
      try { active.gain?.disconnect(); } catch {}
    }
    activeSounds.clear();
    for (const template of audioTemplates.values()) {
      try {
        template.pause();
        template.removeAttribute("src");
        template.load();
      } catch {}
    }
    audioTemplates.clear();
    const contextToClose = audioContext;
    audioContext = null;
    mixBus = null;
    try { contextToClose?.close(); } catch {}
  }

  return {
    get audioContext() { return audioContext; },
    start,
    update,
    stop,
  };
}
