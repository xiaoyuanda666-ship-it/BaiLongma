import { createActivationIntroOrb } from "./activation-intro-orb.js";
import { createActivationIntroSoundscape } from "./activation-intro-sound.js";

const INTRO_SOURCE_URL = "/activation.html";
const INTRO_CSS_MARKER = "/* ── Activation arrival film";
const INTRO_DURATION_SECONDS = 12.768;
export const INTRO_START_DELAY_MS = 300;
const INTRO_CLOCK_ROLL_START_SECONDS = 7.98;
const INTRO_CLOCK_ROLL_END_SECONDS = 9.15;
const INTRO_PROGRESS_START_SECONDS = 8.45;
const INTRO_PROGRESS_END_SECONDS = 9.75;

async function mountIntroTemplate() {
  const response = await fetch(INTRO_SOURCE_URL, { cache: "no-cache" });
  if (!response.ok) throw new Error(`intro template unavailable (${response.status})`);
  const source = await response.text();
  const parsed = new DOMParser().parseFromString(source, "text/html");
  const intro = parsed.getElementById("activation-intro");
  if (!intro) throw new Error("intro template is missing #activation-intro");

  const cssStart = source.indexOf(INTRO_CSS_MARKER);
  const cssEnd = cssStart >= 0 ? source.indexOf("</style>", cssStart) : -1;
  if (cssStart < 0 || cssEnd < 0) throw new Error("intro stylesheet marker is missing");

  const style = document.createElement("style");
  style.dataset.brainUiIntroStyle = "true";
  style.textContent = `${source.slice(cssStart, cssEnd)}\n#activation-intro { z-index: 10000; }`;
  document.head.append(style);
  document.body.append(intro);
  return { intro, style };
}

export async function playBrainUiIntro() {
  let mounted;
  try {
    mounted = await mountIntroTemplate();
  } catch (error) {
    document.documentElement.classList.remove("brain-ui-intro-pending");
    console.warn("[brain-ui] welcome intro could not mount:", error?.message || error);
    return { completed: false, reason: "mount-failed" };
  }

  const { intro, style } = mounted;
  const audio = intro.querySelector("#activation-intro-audio");
  const canvas = intro.querySelector("#activation-intro-voice-canvas");
  const skipButton = intro.querySelector("#intro-skip");
  const progressValue = intro.querySelector("#intro-progress-value");
  const clockHours = intro.querySelector("#intro-clock-hours");
  const clockMinutes = intro.querySelector("#intro-clock-minutes");
  const timelineElements = Array.from(intro.querySelectorAll("[data-intro-anim]"));

  if (!audio || !canvas || !skipButton || !progressValue || !clockHours || !clockMinutes) {
    intro.remove();
    style.remove();
    document.documentElement.classList.remove("brain-ui-intro-pending");
    console.warn("[brain-ui] welcome intro template is incomplete");
    return { completed: false, reason: "invalid-template" };
  }

  const now = new Date();
  const targetMinutes = now.getHours() * 60 + now.getMinutes();
  const randomDistance = 180 + Math.floor(Math.random() * 1080);
  const startMinutes = (targetMinutes + randomDistance) % 1440;
  let animationFrame = null;
  let fallbackStartedAt = 0;
  let fallbackTimer = null;
  let startTimer = null;
  let finished = false;
  let soundEventCount = 0;
  intro.dataset.soundState = "waiting";
  intro.dataset.startDelayMs = String(INTRO_START_DELAY_MS);
  intro.dataset.soundEventCount = "0";
  const soundscape = createActivationIntroSoundscape({
    onEvent(eventId) {
      soundEventCount += 1;
      intro.dataset.soundEvent = eventId;
      intro.dataset.soundEventCount = String(soundEventCount);
    },
    onStateChange(state) {
      intro.dataset.soundState = state;
    },
  });
  const orb = createActivationIntroOrb({
    canvas,
    audio,
    audioContext: soundscape.audioContext,
  });

  const syncClock = (seconds) => {
    const liveNow = new Date();
    const liveMinutes = liveNow.getHours() * 60 + liveNow.getMinutes();
    let shownMinutes = startMinutes;
    if (seconds >= INTRO_CLOCK_ROLL_END_SECONDS) {
      shownMinutes = liveMinutes;
    } else if (seconds > INTRO_CLOCK_ROLL_START_SECONDS) {
      const rawProgress = (seconds - INTRO_CLOCK_ROLL_START_SECONDS)
        / (INTRO_CLOCK_ROLL_END_SECONDS - INTRO_CLOCK_ROLL_START_SECONDS);
      const easedProgress = 1 - Math.pow(1 - Math.min(1, rawProgress), 3);
      const forwardDistance = (targetMinutes - startMinutes + 1440) % 1440;
      shownMinutes = (startMinutes + Math.round(forwardDistance * easedProgress)) % 1440;
    }
    clockHours.textContent = String(Math.floor(shownMinutes / 60)).padStart(2, "0");
    clockMinutes.textContent = String(shownMinutes % 60).padStart(2, "0");
  };

  const syncTimeline = (seconds) => {
    const time = Math.max(0, Math.min(INTRO_DURATION_SECONDS, Number(seconds) || 0));
    const delay = `-${time.toFixed(3)}s`;
    for (const element of timelineElements) {
      const offset = Number(element.dataset.introOffset) || 0;
      element.style.animationDelay = offset ? `calc(${delay} + ${offset}s)` : delay;
    }
    const progress = time <= INTRO_PROGRESS_START_SECONDS
      ? 60
      : Math.min(100, 60 + ((time - INTRO_PROGRESS_START_SECONDS)
        / (INTRO_PROGRESS_END_SECONDS - INTRO_PROGRESS_START_SECONDS)) * 40);
    progressValue.textContent = `${Math.round(progress)}%`;
    syncClock(time);
  };

  const stopRuntime = () => {
    if (animationFrame) cancelAnimationFrame(animationFrame);
    animationFrame = null;
    if (fallbackTimer) clearTimeout(fallbackTimer);
    fallbackTimer = null;
    if (startTimer) clearTimeout(startTimer);
    startTimer = null;
    orb.stop();
    soundscape.stop();
    try { audio.pause(); } catch {}
  };

  const result = await new Promise((resolve) => {
    const finish = (reason) => {
      if (finished) return;
      finished = true;
      stopRuntime();
      syncTimeline(INTRO_DURATION_SECONDS);
      intro.classList.remove("active");
      intro.setAttribute("aria-hidden", "true");
      window.setTimeout(() => {
        intro.remove();
        style.remove();
        resolve({ completed: true, reason });
      }, 240);
    };

    const render = () => {
      if (finished) return;
      const fallbackSeconds = fallbackStartedAt
        ? (performance.now() - fallbackStartedAt) / 1000
        : 0;
      const timelineSeconds = audio.paused ? fallbackSeconds : audio.currentTime;
      syncTimeline(timelineSeconds);
      soundscape.update(timelineSeconds);
      animationFrame = requestAnimationFrame(render);
    };

    audio.addEventListener("ended", () => finish("ended"), { once: true });
    skipButton.addEventListener("click", () => finish("skipped"), { once: true });
    window.addEventListener("pagehide", stopRuntime, { once: true });

    syncTimeline(0);
    intro.classList.add("active");
    intro.setAttribute("aria-hidden", "false");
    document.documentElement.classList.remove("brain-ui-intro-pending");
    animationFrame = requestAnimationFrame(render);

    startTimer = window.setTimeout(() => {
      startTimer = null;
      if (finished) return;
      soundscape.start();
      orb.start();
      try {
        audio.currentTime = 0;
        const playPromise = audio.play();
        if (playPromise?.catch) {
          playPromise.catch((error) => {
            console.warn("[brain-ui] welcome narration could not play:", error?.message || error);
            fallbackStartedAt = performance.now();
            fallbackTimer = window.setTimeout(() => finish("fallback"), INTRO_DURATION_SECONDS * 1000);
          });
        }
      } catch (error) {
        console.warn("[brain-ui] welcome narration could not play:", error?.message || error);
        fallbackStartedAt = performance.now();
        fallbackTimer = window.setTimeout(() => finish("fallback"), INTRO_DURATION_SECONDS * 1000);
      }
    }, INTRO_START_DELAY_MS);
  });

  return result;
}
