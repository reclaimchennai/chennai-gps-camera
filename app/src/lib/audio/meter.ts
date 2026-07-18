/**
 * Live ambient sound-level meter (§ watermark "Sound level" field).
 *
 * Reads microphone RMS via a WebAudio AnalyserNode and publishes an
 * approximate dB figure to the live store ~4×/second. Phone microphones
 * are not calibrated SPL meters — the value is dBFS shifted by a fixed
 * offset that lands typical scenes in the familiar 30–110 dB range, and
 * the watermark renders it with an "≈" for honesty.
 *
 * When the camera stream already carries an audio track (video mode) it
 * is reused; otherwise a mic-only stream is opened. Everything stops and
 * releases the mic in stop().
 */
import { useLiveStore, useSettingsStore } from "../../store";
import { preferredAudioConstraints } from "./source";

// dBFS→"dB" shift chosen so readings land close to common phone
// noise-meter apps (quiet room ~35–40, conversation ~60, traffic ~75).
// Phone mics + AGC vary per device, so Settings exposes a user
// calibration offset added on top of this.
const DB_OFFSET = 90;
const FLOOR = 20;
const CEIL = 120;

let audioCtx: AudioContext | null = null;
let analyser: AnalyserNode | null = null;
let srcNode: MediaStreamAudioSourceNode | null = null;
let ownStream: MediaStream | null = null;
let timer: number | null = null;
let smoothed: number | null = null;
let starting = false;
let generation = 0;
// session statistics — reset only when the app reloads, not on meter
// restarts, so "average since the app opened" stays true across screens
let statSum = 0;
let statCount = 0;
let statMin = Infinity;
let statMax = -Infinity;

function teardownGraph() {
  if (timer != null) {
    window.clearInterval(timer);
    timer = null;
  }
  try {
    srcNode?.disconnect();
  } catch {
    // already gone
  }
  srcNode = null;
  analyser = null;
  if (ownStream) {
    for (const t of ownStream.getTracks()) t.stop();
    ownStream = null;
  }
  smoothed = null;
  useLiveStore.getState().setDb(null);
}

function tick() {
  if (!analyser) return;
  // Autoplay policy (strictest inside the Android WebView): an
  // AudioContext created without a user gesture sits "suspended" and the
  // analyser reads pure zeros forever — retry resuming every tick until
  // a gesture lands and it sticks.
  if (audioCtx && audioCtx.state === "suspended") {
    void audioCtx.resume();
    return;
  }
  const buf = new Float32Array(analyser.fftSize);
  analyser.getFloatTimeDomainData(buf);
  let sum = 0;
  for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
  const rms = Math.sqrt(sum / buf.length);
  if (rms <= 1e-7) return; // silent buffer before the mic warms up
  const cal = useSettingsStore.getState().settings.dbCalibration || 0;
  const db = Math.min(
    CEIL,
    Math.max(FLOOR, 20 * Math.log10(rms) + DB_OFFSET + cal)
  );
  // fast attack, slower decay — how physical SPL meters behave
  smoothed =
    smoothed == null
      ? db
      : db > smoothed
        ? smoothed * 0.4 + db * 0.6
        : smoothed * 0.75 + db * 0.25;
  const rounded = Math.round(smoothed);
  statSum += rounded;
  statCount++;
  if (rounded < statMin) statMin = rounded;
  if (rounded > statMax) statMax = rounded;
  const stats = {
    avg: Math.round(statSum / statCount),
    min: statMin,
    max: statMax,
  };
  // only touch the store when displayed values change — every set
  // triggers a full watermark-overlay repaint in the viewfinder
  const live = useLiveStore.getState();
  if (live.db !== rounded) live.setDb(rounded);
  const prev = live.dbStats;
  if (
    !prev ||
    prev.avg !== stats.avg ||
    prev.min !== stats.min ||
    prev.max !== stats.max
  ) {
    live.setDbStats(stats);
  }
}

/**
 * Start (or restart) metering. Prefers an existing camera audio track
 * (video mode) so only ONE microphone capture is ever open — a second
 * concurrent getUserMedia({audio}) conflicts on Android and silences the
 * recording. Falls back to its own mic stream (photo mode / Settings),
 * always with voice processing OFF: echo cancellation, noise suppression
 * and especially auto gain control rewrite the very levels an SPL meter
 * exists to measure. Safe to call repeatedly — the graph is torn down
 * first.
 */
export function startMeter(cameraStream?: MediaStream | null): void {
  const gen = ++generation;
  if (starting) return; // a start is in flight; it checks generation
  starting = true;
  void (async () => {
    try {
      teardownGraph();
      let stream: MediaStream | null = null;
      if (cameraStream?.getAudioTracks().length) {
        // reuse the recording's (already unprocessed) mic track
        stream = cameraStream;
      } else {
        const baseAudio: MediaTrackConstraints = {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        };
        // Same input pick as the recording: prefer an external mic, else
        // pin the built-in one so mic-less headphones don't flatline the
        // meter at its floor. Retry OS-default if the exact device fails.
        const audio = await preferredAudioConstraints(baseAudio);
        try {
          ownStream = await navigator.mediaDevices.getUserMedia({ audio });
        } catch {
          try {
            ownStream = await navigator.mediaDevices.getUserMedia({
              audio: baseAudio,
            });
          } catch {
            return; // mic denied/unavailable — dB simply not shown
          }
        }
        stream = ownStream;
      }
      if (gen !== generation) {
        // superseded while we awaited the mic
        if (ownStream) {
          for (const t of ownStream.getTracks()) t.stop();
          ownStream = null;
        }
        return;
      }
      audioCtx ??= new AudioContext();
      if (audioCtx.state === "suspended") {
        void audioCtx.resume();
        // policies that reject resume() outside a gesture accept it
        // inside one — hook the next few taps until it sticks
        const onGesture = () => {
          if (audioCtx && audioCtx.state === "suspended") {
            void audioCtx.resume();
          } else {
            window.removeEventListener("pointerdown", onGesture);
            window.removeEventListener("touchend", onGesture);
          }
        };
        window.addEventListener("pointerdown", onGesture);
        window.addEventListener("touchend", onGesture);
      }
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 2048;
      srcNode = audioCtx.createMediaStreamSource(stream);
      srcNode.connect(analyser); // analysis only — never to speakers
      timer = window.setInterval(tick, 250);
    } finally {
      starting = false;
    }
  })();
}

export function stopMeter(): void {
  generation++;
  teardownGraph();
}

/** Compute an approximate dB value from an existing AnalyserNode — used
 *  by the video export to meter the clip's own audio track. */
export function dbFromAnalyser(node: AnalyserNode): number | null {
  const buf = new Float32Array(node.fftSize);
  node.getFloatTimeDomainData(buf);
  let sum = 0;
  for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
  const rms = Math.sqrt(sum / buf.length);
  if (rms <= 1e-7) return null;
  const cal = useSettingsStore.getState().settings.dbCalibration || 0;
  return Math.round(
    Math.min(CEIL, Math.max(FLOOR, 20 * Math.log10(rms) + DB_OFFSET + cal))
  );
}
