/**
 * Camera controller for the PWA build (getUserMedia).
 *
 * Pre-warmed at app launch (§2): start() is called from the root
 * component's first effect, so the viewfinder is live without any
 * intermediate screen. Capture prefers ImageCapture.takePhoto() for
 * full sensor resolution, falling back to grabbing the video frame.
 */

import { isNativeApp } from "./native";
import { preferredAudioConstraints } from "./audio/source";
import { qualityPlan } from "./quality";
import { measureLensFactor, snapFactor } from "./lens-calibrate";

export type FacingMode = "environment" | "user";

export interface CameraCapabilitiesLite {
  zoom?: { min: number; max: number; step: number };
  torch: boolean;
  focus: boolean;
}

interface ImageCaptureLike {
  takePhoto(): Promise<Blob>;
}

declare global {
  interface Window {
    ImageCapture?: new (track: MediaStreamTrack) => ImageCaptureLike;
  }
}

/** Zoom capability, unified across hardware (camera-native) and digital
 *  (crop) modes so the UI can present one consistent zoom control. */
export interface ZoomInfo {
  min: number;
  max: number;
  /** true = the camera track zooms natively; false = digital crop. */
  hardware: boolean;
}

const MAX_DIGITAL_ZOOM = 4;
/** How long Android needs to actually release a camera after track.stop().
 *  Opening the next lens sooner fails with NotReadableError. */
const RELEASE_MS = 180;
/** Effective zoom factor an ultra-wide lens represents (~0.6× on most
 *  Android phones — matches the ".6" chip Samsung/Pixel cameras show). */
const ULTRA_WIDE_FACTOR = 0.6;
/** Typical telephoto factor when the label doesn't state one (S-series
 *  and most flagships put their tele at 3×). */
const TELEPHOTO_FACTOR = 3;
/** user's per-lens factor corrections, keyed by deviceId */
const LENS_KEY = "gpscam-lens-factors";
/** the whole discovered lens line-up, so it survives a camera restart */
const LENS_PROFILE_KEY = "gpscam-lens-profile";

/** A physical rear camera the app can switch to. */
export interface Lens {
  deviceId: string;
  label: string;
  /** effective zoom factor relative to the main lens (0.6, 1, 3, …) */
  factor: number;
  isMain: boolean;
}

/**
 * One-time reset of stored lens state. Versions up to 1.11.2 auto-saved
 * optical measurements INTO the manual-override store, and a wrong one
 * (e.g. from a flat scene) is indistinguishable from a user choice — it
 * poisons every later detection. That is why the web app could stay
 * swapped while a fresh APK install was fine. Wipe once; detection is
 * reliable now and rebuilds the profile on the next start.
 */
try {
  if (localStorage.getItem("gpscam-lens-v") !== "2") {
    localStorage.removeItem("gpscam-lens-factors");
    localStorage.removeItem("gpscam-lens-profile");
    localStorage.setItem("gpscam-lens-v", "2");
  }
} catch {
  // storage unavailable — nothing stored to migrate either
}

export function loadLensOverrides(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(LENS_KEY) ?? "{}");
  } catch {
    return {};
  }
}

export function saveLensOverride(deviceId: string, factor: number): void {
  try {
    const all = loadLensOverrides();
    all[deviceId] = factor;
    localStorage.setItem(LENS_KEY, JSON.stringify(all));
  } catch {
    // storage unavailable — the guess stands for this session
  }
}

/**
 * The discovered line-up, remembered across restarts.
 *
 * Discovery has to open each camera in turn, and Android allows only ONE
 * camera open at a time — so it cannot run while the viewfinder is live.
 * Re-deriving the list on every start() therefore failed every probe and
 * silently fell back to the old index-order guess (which is what put the
 * ultra-wide at "1x"), and it wiped the list Settings was displaying.
 * Discover once, write it here, and read it back instantly afterwards.
 */
export function loadLensProfile(): Lens[] {
  try {
    const raw = JSON.parse(localStorage.getItem(LENS_PROFILE_KEY) ?? "null");
    if (!raw || raw.v !== 1 || !Array.isArray(raw.lenses)) return [];
    const over = loadLensOverrides();
    const lenses: Lens[] = raw.lenses
      .filter((l: Lens) => l && typeof l.deviceId === "string")
      .map((l: Lens) => ({
        deviceId: l.deviceId,
        label: String(l.label ?? "Camera"),
        // a manual correction always wins over what discovery decided
        factor: over[l.deviceId] ?? (Number(l.factor) || 1),
        isMain: !!l.isMain,
      }));
    return lenses.length > 1 ? lenses.sort((a, b) => a.factor - b.factor) : [];
  } catch {
    return [];
  }
}

/**
 * The lens the app calls "1x" — the one whose factor is 1, NOT whichever
 * camera `facingMode: environment` happened to hand over. Deriving it from
 * the factor (rather than a stored flag) is what makes a correction in
 * Settings take effect at once: name a lens 1x and it becomes the lens the
 * viewfinder opens on.
 */
export function pickMainLens(lenses: Lens[]): Lens | null {
  if (lenses.length < 2) return null;
  let best: Lens | null = null;
  for (const l of lenses) {
    if (!best || Math.abs(l.factor - 1) < Math.abs(best.factor - 1)) best = l;
  }
  return best;
}

/**
 * Re-point a remembered line-up at the CURRENT deviceIds.
 *
 * deviceId is not a durable handle: the browser salts it per session, so a
 * saved id can be dead on the next launch even though the camera is the
 * same one. The label ("camera2 0, facing back") IS stable, so the saved
 * entries are matched by label and given whatever id that camera has now.
 * Without this, every remembered id went stale and the app fell all the way
 * down its getUserMedia fallback ladder — which is what silently dropped
 * audio, broke lens switching and put a multi-second spinner on launch.
 */
export function resolveLensProfile(devices: MediaDeviceInfo[]): Lens[] {
  const saved = loadLensProfile();
  if (!saved.length) return [];
  const cams = devices.filter((d) => d.kind === "videoinput");
  const out: Lens[] = [];
  for (const l of saved) {
    const byLabel = l.label
      ? cams.find((d) => d.label === l.label)
      : undefined;
    const match = byLabel ?? cams.find((d) => d.deviceId === l.deviceId);
    if (!match) continue;
    out.push({ ...l, deviceId: match.deviceId, label: match.label || l.label });
  }
  // a partial match means the phone is not the one this profile describes
  return out.length === saved.length && out.length > 1
    ? out.sort((a, b) => a.factor - b.factor)
    : [];
}

export function saveLensProfile(lenses: Lens[]): void {
  try {
    localStorage.setItem(
      LENS_PROFILE_KEY,
      JSON.stringify({ v: 1, lenses })
    );
  } catch {
    // storage unavailable — discovery just repeats next launch
  }
}

/** Sensor pixel count for a camera, or null when it can't be opened.
 *  Retries: back-to-back opens race Android's async camera release. */
async function probeSensorPixels(deviceId: string): Promise<number | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const s = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { deviceId: { exact: deviceId }, width: { ideal: 320 } },
      });
      const caps = (s.getVideoTracks()[0]?.getCapabilities?.() ?? {}) as Record<
        string,
        unknown
      >;
      for (const t of s.getTracks()) t.stop();
      const w = (caps.width as { max?: number } | undefined)?.max ?? 0;
      const h = (caps.height as { max?: number } | undefined)?.max ?? 0;
      await new Promise((r) => window.setTimeout(r, RELEASE_MS));
      return w && h ? w * h : null;
    } catch {
      await new Promise((r) => window.setTimeout(r, RELEASE_MS * (attempt + 2)));
    }
  }
  return null;
}

export class CameraController {
  /** Give the camera hardware a moment (see RELEASE_MS). */
  static settle(ms: number): Promise<void> {
    return new Promise((r) => window.setTimeout(r, ms));
  }

  stream: MediaStream | null = null;
  facing: FacingMode = "environment";
  private video: HTMLVideoElement | null = null;
  private zoomValue = 1;
  private digitalZoom = 1; // used when the track has no native zoom
  private torchOn = false;

  /**
   * ONE stream serves both photo and video mode, so switching modes is
   * instant (no camera restart), the torch state survives, and the
   * sound meter never has to re-attach. Audio rides along from the
   * start — voice processing disabled so recordings and the dB meter
   * both see the real signal. Stills are unaffected by the 1080p
   * stream: ImageCapture.takePhoto() reads the full sensor.
   */
  /**
   * Whether this session needs the microphone at all.
   *
   * Holding it for the whole time the viewfinder is up blocks every other
   * app from recording audio — the stock camera app opens the mic only
   * when it needs it, and so do we now: video mode, or the noise-level
   * watermark field. ensureAudio() acquires it on demand before a
   * recording starts, so nothing is lost by waiting.
   */
  audioWanted = true;

  /** Release the microphone without disturbing the picture. */
  releaseAudio(): void {
    for (const t of this.stream?.getAudioTracks() ?? []) {
      t.stop();
      this.stream?.removeTrack(t);
    }
  }

  async start(facing: FacingMode = this.facing): Promise<MediaStream> {
    this.stop();
    this.facing = facing;
    const baseAudio: MediaTrackConstraints = {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    };
    // Prefer a connected external mic; failing that, pin the built-in one so
    // mic-less headphones can't silence the recording (see audio/source.ts).
    const audio = await preferredAudioConstraints(baseAudio);
    // Preview size comes from the device-tier plan, NOT "as big as
    // possible": a 4K preview made digital zoom stutter badly (the video
    // element is CSS-scaled by the zoom factor, so a 4× zoom on 4K is an
    // enormous composite every frame). Zoomed photo quality no longer
    // depends on preview size — those captures take the full-sensor
    // ImageCapture path — so this is purely a smoothness dial.
    const plan = qualityPlan();
    const size = {
      width: { ideal: plan.previewLongEdge },
      height: { ideal: Math.round((plan.previewLongEdge * 9) / 16) },
    };
    // Open the remembered 1x lens DIRECTLY when a profile exists. A profile
    // is only ever saved on phones WITHOUT a logical cross-lens camera
    // (detectLenses skips discovery entirely when the track zooms below 1x
    // by itself), so this cannot cost the seamless path — but it removes
    // the open-default-then-switch-to-main dance that every start on this
    // class of Samsung was paying: that switch was the 1-2 s launch delay
    // and the black gap with the stray white dot, on cold start and on
    // every return from the background alike. Ids are re-resolved by label
    // each time (they go stale between sessions).
    let known: Lens | null = null;
    if (facing === "environment") {
      try {
        if (loadLensProfile().length) {
          known = pickMainLens(
            resolveLensProfile(await navigator.mediaDevices.enumerateDevices())
          );
        }
      } catch {
        known = null;
      }
    }
    const video: MediaTrackConstraints = known
      ? { deviceId: { exact: known.deviceId }, ...size }
      : { facingMode: facing, ...size };

    /**
     * Relax the VIDEO constraint before touching audio.
     *
     * The old ladder reused the same video constraint for its first three
     * rungs and only varied audio, so one unusable deviceId meant the only
     * attempt that could succeed was the `audio: false` one — every
     * recording came out silent, and the four rejections in a row put a
     * multi-second spinner on the launch screen.
     */
    const byFacing: MediaTrackConstraints = { facingMode: facing, ...size };
    const attempts: MediaStreamConstraints[] = this.audioWanted
      ? [
      { audio, video },
      // a dead deviceId must fall back to the default camera BEFORE any
      // rung gives up the microphone (see v1.11.4)
      ...(known ? [{ audio, video: byFacing }] : []),
      { audio: baseAudio, video: byFacing },
      { audio: false, video: byFacing },
      { audio: false, video: { facingMode: facing } },
        ]
      : [
          { audio: false, video },
          { audio: false, video: byFacing },
          { audio: false, video: { facingMode: facing } },
        ];
    let opened: MediaStream | null = null;
    let lastErr: unknown = null;
    // Returning from the background, Android often has not finished
    // releasing the camera we just stopped, so EVERY rung fails in one
    // quick cascade — which used to both lose the microphone and leave a
    // dark viewfinder until an unrelated watchdog retried seconds later.
    // Retry the whole ladder with a short settle instead: round two
    // starts again from the best constraints, audio included.
    for (let round = 0; round < 3 && !opened; round++) {
      if (round > 0) await CameraController.settle(RELEASE_MS * round);
      for (const c of attempts) {
        try {
          opened = await navigator.mediaDevices.getUserMedia(c);
          break;
        } catch (e) {
          lastErr = e;
        }
      }
    }
    if (!opened) throw lastErr instanceof Error ? lastErr : new Error("camera");
    this.stream = opened;
    // A fresh stream always starts at 1x, but the user's chosen zoom must
    // survive minimising the app: it used to silently drop to 1x while the
    // indicator still read 3x, so the label and the picture disagreed.
    const wanted = this.desiredZoom;
    this.zoomValue = 1;
    this.digitalZoom = 1;
    this.torchOn = false;
    this.activeLensId = null;
    this.mainDeviceId =
      this.stream.getVideoTracks()[0]?.getSettings?.().deviceId ?? null;
    if (this.video) this.video.style.transform = "";
    // discover the phone's other rear lenses in the background so pinch
    // zoom can hand over to real optics, then put the zoom back
    void this.detectLenses().then(() => this.restoreZoom(wanted));
    return this.stream;
  }

  /** Zoom the user last asked for; survives a stream restart. */
  private desiredZoom = 1;

  /** Re-apply the remembered zoom once a new stream is ready. */
  private async restoreZoom(wanted: number): Promise<void> {
    if (Math.abs(wanted - 1) < 0.01) return;
    const got = await this.setZoom(wanted);
    this.desiredZoom = wanted; // setZoom may have clamped; keep the intent
    window.dispatchEvent(
      new CustomEvent("gpscam:zoom-changed", { detail: { zoom: got } })
    );
  }

  attach(video: HTMLVideoElement): void {
    this.video = video;
    if (this.stream) {
      video.srcObject = this.stream;
      // play() can reject once during WebView startup (load-interrupt /
      // visibility races). A single swallowed rejection used to leave the
      // viewfinder paused behind Chromium's overlay play button until the
      // user tapped it — retry instead.
      const tryPlay = () => {
        video.play().catch(() => {
          window.setTimeout(() => {
            if (video.srcObject && video.paused) tryPlay();
          }, 400);
        });
      };
      video.onloadedmetadata = tryPlay;
      tryPlay();
    }
  }

  stop(): void {
    if (this.stream) {
      for (const t of this.stream.getTracks()) t.stop();
      this.stream = null;
    }
  }

  get track(): MediaStreamTrack | null {
    return this.stream?.getVideoTracks()[0] ?? null;
  }

  capabilities(): CameraCapabilitiesLite {
    const caps = (this.track?.getCapabilities?.() ?? {}) as Record<
      string,
      unknown
    >;
    const zoom = caps.zoom as
      | { min: number; max: number; step: number }
      | undefined;
    // min < 1 means the logical camera exposes an ultra-wide range —
    // pinch-out below 1× is supported on those devices. (Switching to a
    // separate ultra-wide deviceId is NOT attempted: the web platform
    // gives no reliable way to identify lenses.)
    return {
      zoom:
        zoom &&
        typeof zoom.max === "number" &&
        (zoom.max > 1 || zoom.min < 1)
          ? zoom
          : undefined,
      torch: Boolean(caps.torch),
      focus: Array.isArray(caps.focusMode),
    };
  }

  /** Unified zoom range. Prefers the camera's native zoom (best quality,
   *  can reach ultra-wide < 1× on phones that expose it); otherwise falls
   *  back to a digital crop zoom, which works on every device — many
   *  Android WebViews simply don't surface the `zoom` track constraint.
   *  When a separate ultra-wide LENS exists, the range extends below 1×
   *  (pinching out past 1× switches to that camera). */
  zoomInfo(): ZoomInfo {
    const hw = this.capabilities().zoom;
    // SEAMLESS: a zoom range reaching below 1× means this track is the
    // phone's LOGICAL rear camera, which switches physical sensors inside
    // the camera stack as the zoom ratio crosses their boundaries. That is
    // how the stock camera app crosses .6×→1× with no interruption at all,
    // and it is available to us for free — as long as we drive zoom instead
    // of opening physical cameras ourselves, which throws the logical
    // camera (and its seamless handover) away.
    if (hw && hw.min < 0.95) {
      return { min: hw.min, max: Math.min(hw.max, 10), hardware: true };
    }
    // widest and longest real lenses set the ends of the range; digital
    // crop extends past the longest one
    const factors = this.lenses.map((l) => l.factor);
    const floor = factors.length ? Math.min(1, ...factors) : 1;
    const longest = factors.length ? Math.max(1, ...factors) : 1;
    if (hw) {
      return {
        min: Math.min(hw.min, floor),
        max: Math.max(hw.max, longest * MAX_DIGITAL_ZOOM),
        hardware: true,
      };
    }
    return { min: floor, max: longest * MAX_DIGITAL_ZOOM, hardware: false };
  }

  /** True when the live track can zoom across lenses by itself. */
  get seamlessZoom(): boolean {
    const hw = this.capabilities().zoom;
    return !!hw && hw.min < 0.95;
  }

  /**
   * Physical rear lenses (ultra-wide / main / telephoto), so pinch zoom
   * can hand over to real optics instead of cropping pixels.
   *
   * Android exposes each physical camera as its own deviceId, but the
   * labels are only ever "camera2 N, facing back" — they never name the
   * lens, and no web API reports field of view. So: parse what the label
   * DOES give (index + facing), probe each camera's sensor, then apply
   * the near-universal Android convention that back cameras are ordered
   * main, ultra-wide, telephoto. Guesses can be wrong on unusual phones,
   * so Settings lets the user correct any lens's factor, and those
   * overrides win here.
   */
  lenses: Lens[] = [];
  private mainDeviceId: string | null = null;

  /**
   * Load the remembered line-up, or discover it once.
   *
   * Discovery has to take the camera away from the viewfinder for about a
   * second (see loadLensProfile), so it happens behind the freeze-frame
   * cover and only when there is nothing cached: on this phone, on this
   * install, exactly once.
   */
  private async detectLenses(): Promise<void> {
    if (this.facing !== "environment") {
      this.lenses = [];
      return;
    }
    // Nothing to discover, and nothing we should touch: this track already
    // zooms across its own lenses. Probing would mean closing it, and
    // re-seating onto a single physical camera would cost exactly the
    // seamless handover we want. Leave it alone.
    if (this.seamlessZoom) {
      this.lenses = [];
      // start at exactly 1.0 rather than wherever the stack happened to be,
      // so the viewfinder's "1x" is the main-lens field of view
      try {
        await this.track?.applyConstraints({
          advanced: [{ zoom: 1 } as MediaTrackConstraintSet],
        });
        this.zoomValue = 1;
      } catch {
        // leave it wherever it opened
      }
      window.dispatchEvent(new Event("gpscam:lenses-updated"));
      return;
    }
    // Resolve against the live device list, never against saved ids alone:
    // a profile whose labels no longer match this hardware is worse than no
    // profile, because every id in it is a dead end.
    let cached: Lens[] = [];
    try {
      cached = resolveLensProfile(
        await navigator.mediaDevices.enumerateDevices()
      );
    } catch {
      cached = [];
    }
    if (cached.length > 1) {
      this.lenses = cached;
      this.lensFailures.clear();
      this.lensUnavailable = false;
      window.dispatchEvent(new Event("gpscam:lenses-updated"));
      await this.ensureOnMainLens();
      return;
    }
    // wait for a frame first — there is nothing to hold up otherwise, and
    // discovery would show as the black viewfinder it is meant to hide
    await this.waitForFirstFrame();
    this.freeze();
    try {
      await this.discoverLenses();
    } finally {
      await this.ensureOnMainLens();
      this.unfreeze();
    }
  }

  /** Resolve once the viewfinder has something on it (or give up). */
  private waitForFirstFrame(): Promise<void> {
    const v = this.video;
    if (!v || v.videoWidth) return Promise.resolve();
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        resolve();
      };
      v.addEventListener("loadeddata", finish, { once: true });
      window.setTimeout(finish, 900);
    });
  }

  private mainLens(): Lens | null {
    return pickMainLens(this.lenses);
  }


  /** At 1x, make sure we are actually streaming the 1x lens. */
  private async ensureOnMainLens(): Promise<void> {
    const main = this.mainLens();
    if (!main || this.zoomValue !== 1 || this.lensSwapping) return;
    const streaming = this.stream?.getVideoTracks()[0]?.getSettings?.().deviceId;
    if (!streaming || streaming === main.deviceId) {
      this.activeLensId = streaming ?? null;
      return;
    }
    this.lensSwapping = true;
    await this.useDevice(main.deviceId);
    this.lensSwapping = false;
    this.digitalZoom = 1;
    this.applyDigitalTransform();
    this.zoomValue = 1;
  }

  private async discoverLenses(): Promise<void> {
    this.lenses = [];
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const backs = devices.filter(
        (d) =>
          d.kind === "videoinput" &&
          !/front|facing front|\buser\b/i.test(d.label ?? "")
      );
      if (backs.length < 2) return; // single logical camera: nothing to switch

      // "camera2 3, facing back" → index 3, for the ordering convention
      const idxOf = (label: string): number => {
        const m = /camera2\s+(\d+)/i.exec(label ?? "");
        return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER;
      };
      const ordered = [...backs].sort((a, b) => idxOf(a.label) - idxOf(b.label));

      // A label that actually names the lens beats any convention.
      const fromLabel = (label: string): number | null => {
        const l = (label ?? "").toLowerCase();
        const x = /(\d(?:\.\d)?)\s*x/.exec(l);
        if (/ultra|wide.?angle/.test(l)) return ULTRA_WIDE_FACTOR;
        if (/tele/.test(l)) return x ? Number(x[1]) : 3;
        if (x) return Number(x[1]);
        return null;
      };

      const saved = loadLensOverrides();

      // Probe EVERY back camera's sensor first. Identifying the main lens
      // by "whatever facingMode:environment gave us" was wrong: on this
      // class of Samsung, Chrome hands out the ULTRA-WIDE as the default
      // rear camera, so the app's 1x was already a wide shot and the lens
      // it called 0.6x was the real main — exactly the swap reported from
      // the field. The main camera is instead the one with the largest
      // sensor (50 MP main vs 12 MP ultra-wide vs 10 MP tele), which is
      // true across essentially every multi-lens phone.
      //
      // Probing opens each camera in turn, and Android permits only one
      // open at a time, so the viewfinder's own track has to be released
      // first — otherwise every probe fails, every sensor size reads 0,
      // and the main lens silently falls back to the index-order guess
      // this code exists to replace.
      for (const t of this.stream?.getVideoTracks() ?? []) t.stop();
      const probed: { d: MediaDeviceInfo; px: number }[] = [];
      for (const d of ordered.slice(0, 4)) {
        const px = await probeSensorPixels(d.deviceId);
        // cameras that refuse to open, or tiny depth/macro helpers, are
        // not shooting lenses
        if (px !== null && px < 2_000_000) continue;
        probed.push({ d, px: px ?? 0 });
      }
      if (probed.length < 2) return;
      const mainPx = Math.max(...probed.map((p) => p.px));
      const mainEntry =
        probed.find((p) => p.px === mainPx && mainPx > 0) ?? probed[0];

      const list: Lens[] = [];
      let assignedWide = false;
      for (const { d } of probed) {
        const isMain = d.deviceId === mainEntry.d.deviceId;
        // the remaining lenses: ultra-wide first (Android orders it before
        // the tele), then telephoto
        const conventional = isMain
          ? 1
          : assignedWide
            ? TELEPHOTO_FACTOR
            : ULTRA_WIDE_FACTOR;
        if (!isMain && !assignedWide) assignedWide = true;
        const factor = saved[d.deviceId] ?? fromLabel(d.label) ?? conventional;
        list.push({
          deviceId: d.deviceId,
          label: d.label || "Camera",
          factor,
          isMain,
        });
      }
      list.sort((a, b) => a.factor - b.factor);
      this.lenses = list.length > 1 ? list : [];
      if (this.lenses.length) saveLensProfile(this.lenses);
      window.dispatchEvent(new Event("gpscam:lenses-updated"));
    } catch {
      this.lenses = [];
    }
  }

  /**
   * Measure each lens optically and label it the way this phone's own
   * camera would (.5x/.6x wide; 2x/3x/5x/10x tele).
   *
   * Explicit, not automatic: it needs the camera to itself for a few
   * seconds, which is fine from Settings (no viewfinder) but would mean a
   * frozen preview if it ran on its own. Returns how many lenses it was
   * able to measure — a flat scene simply yields none and leaves the
   * existing values alone.
   */
  async calibrateLenses(): Promise<number> {
    if (this.lenses.length < 2) this.lenses = loadLensProfile();
    const main = this.mainLens();
    if (!main) return 0;
    // whatever is streaming has to let go: one camera at a time
    const wasLive = !!this.stream;
    for (const t of this.stream?.getVideoTracks() ?? []) t.stop();
    let measured = 0;
    try {
      for (const lens of this.lenses) {
        if (lens.deviceId === main.deviceId) continue;
        const f = await measureLensFactor(main.deviceId, lens.deviceId);
        if (f == null) continue;
        lens.factor = f;
        saveLensOverride(lens.deviceId, f);
        measured++;
      }
    } finally {
      this.lenses.sort((a, b) => a.factor - b.factor);
      saveLensProfile(this.lenses);
      if (wasLive) await this.useDevice(this.mainLens()?.deviceId ?? null);
      window.dispatchEvent(new Event("gpscam:lenses-updated"));
    }
    return measured;
  }

  /**
   * Apply a manual correction from Settings. Kept here (rather than only
   * writing localStorage) so the running controller re-sorts immediately
   * and the very next 1x really opens the lens the user just named 1x.
   */
  setLensFactor(deviceId: string, factor: number): void {
    saveLensOverride(deviceId, factor);
    if (this.lenses.length < 2) this.lenses = loadLensProfile();
    const lens = this.lenses.find((l) => l.deviceId === deviceId);
    if (lens) lens.factor = factor;
    this.lenses.sort((a, b) => a.factor - b.factor);
    if (this.lenses.length) saveLensProfile(this.lenses);
    // re-seat the viewfinder if 1x now means a different lens. Cheaper and
    // far less jarring than restarting the whole camera, which is what
    // used to resize the viewfinder box on every edit here.
    void this.ensureOnMainLens();
    window.dispatchEvent(new Event("gpscam:lenses-updated"));
  }

  /** Forget everything discovered, so the next start() re-detects. */
  forgetLenses(): void {
    try {
      localStorage.removeItem(LENS_PROFILE_KEY);
      localStorage.removeItem(LENS_KEY);
    } catch {
      // nothing to clear
    }
    this.lenses = [];
  }

  /** Zoom stops the UI can offer (one per real lens, plus 2× digital). */
  zoomStops(): number[] {
    const info = this.zoomInfo();
    const stops = new Set<number>();
    // seamless track: there are no separate lenses to enumerate, so offer
    // the wide end the hardware actually reports, named the way this phone
    // would name it (.5× or .6×), plus the usual steps
    if (this.seamlessZoom) stops.add(snapFactor(info.min));
    for (const l of this.lenses) stops.add(l.factor);
    // standard steps so there is always something to tap, even on phones
    // that expose a single camera
    for (const z of [1, 2, 3]) stops.add(z);
    return [...stops]
      .filter((z) => z >= info.min - 1e-6 && z <= info.max + 1e-6)
      .sort((a, b) => a - b);
  }

  /** The lens that natively covers a target zoom factor. */
  private lensFor(factor: number): Lens | null {
    if (!this.lenses.length) return null;
    // the widest lens whose factor is <= target (so the rest is a crop in)
    let best: Lens | null = null;
    for (const l of this.lenses) {
      if (l.factor <= factor + 1e-6 && (!best || l.factor > best.factor)) best = l;
    }
    return best ?? this.lenses[0];
  }

  /** Switch the running stream to a specific physical camera (lens). */
  /**
   * Switch the running stream to a specific physical camera (lens).
   *
   * CRITICAL on Android: only ONE camera may be open at a time. Opening
   * the new lens while the old track is still live fails (NotReadable /
   * Overconstrained), which is why lens switching silently did nothing —
   * the caller then fell back to a digital "zoom" that scaled the preview
   * DOWN, shrinking the viewfinder into a small rectangle instead of
   * showing a wider view. So: release the current video track FIRST, then
   * open the new one, and if that fails, reopen what we had so the user is
   * never left with a dead viewfinder.
   */
  private async useDevice(deviceId: string | null): Promise<boolean> {
    const audio = this.stream?.getAudioTracks()[0] ?? null;
    const previous = this.activeLensId;
    // Same width AND height as start(): asking for width alone let the new
    // lens come back 4:3 where the old one was 16:9, so the viewfinder box
    // visibly shrank every time the lens changed.
    const plan = qualityPlan();
    const size = {
      width: { ideal: plan.previewLongEdge },
      height: { ideal: Math.round((plan.previewLongEdge * 9) / 16) },
    };
    const wanted = (id: string | null): MediaTrackConstraints =>
      id
        ? { deviceId: { exact: id }, ...size }
        : { facingMode: this.facing, ...size };

    // Hold the last frame over the viewfinder for the switch. Releasing
    // one camera and opening another takes a few hundred ms during which
    // the <video> has nothing to show, which read as a black flash every
    // time zoom crossed from the wide lens to the main one (1x→2x→3x
    // never flashed because those are crops of one lens, not a switch).
    this.freeze();
    // free the camera before asking for another one
    for (const t of this.stream?.getVideoTracks() ?? []) t.stop();

    /**
     * track.stop() returns immediately but Android releases the camera
     * asynchronously, so an open can come back NotReadableError while the
     * previous lens is still letting go. Try AT ONCE and only wait if that
     * actually happens: waiting first cost every switch a fixed delay even
     * on phones that hand the camera over straight away, which is the lag
     * still visible next to the stock camera app.
     */
    const open = async (id: string | null): Promise<MediaStreamTrack | null> => {
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          const s = await navigator.mediaDevices.getUserMedia({
            audio: false,
            video: wanted(id),
          });
          return s.getVideoTracks()[0] ?? null;
        } catch {
          // busy, not unsupported: back off a little more each time
          await CameraController.settle(RELEASE_MS * (attempt + 1) * 0.5);
        }
      }
      return null;
    };

    let track = await open(deviceId);
    let landedOn = deviceId;
    if (!track) {
      // couldn't get the requested lens — restore the previous one
      track = await open(previous);
      landedOn = previous;
      if (!track) {
        track = await open(null);
        landedOn = null;
      }
      if (!track) return false;
      this.attachStream(track, await this.liveAudio(audio), landedOn);
      return false; // restored, but the requested switch did not happen
    }
    this.attachStream(track, await this.liveAudio(audio), landedOn);
    return true;
  }

  /**
   * A live audio track for the new stream.
   *
   * Carrying the old track across a lens switch is the intent, but Android
   * can end it when the camera session is torn down — and a MediaStream
   * holding an ENDED audio track records perfect video with no sound, which
   * is exactly what happened in the APK while the web build was fine. So
   * check, and re-acquire the mic if the track we were about to reuse is
   * already dead.
   */
  private async liveAudio(
    existing: MediaStreamTrack | null
  ): Promise<MediaStreamTrack | null> {
    if (existing && existing.readyState === "live") return existing;
    const base: MediaTrackConstraints = {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    };
    for (const audio of [await preferredAudioConstraints(base), base]) {
      try {
        const s = await navigator.mediaDevices.getUserMedia({ audio });
        const t = s.getAudioTracks()[0];
        if (t) return t;
      } catch {
        // try the next, plainer constraint
      }
    }
    return null;
  }

  /**
   * Guarantee the stream has a live microphone track, re-acquiring if not.
   * Called immediately before recording starts, because a silent recording
   * cannot be salvaged afterwards.
   */
  async ensureAudio(): Promise<boolean> {
    const s = this.stream;
    if (!s) return false;
    const have = s.getAudioTracks()[0] ?? null;
    if (have && have.readyState === "live") return true;
    if (have) s.removeTrack(have);
    const fresh = await this.liveAudio(null);
    if (!fresh) return false;
    s.addTrack(fresh);
    return true;
  }

  private attachStream(
    videoTrack: MediaStreamTrack,
    audio: MediaStreamTrack | null,
    lensId: string | null
  ): void {
    const combined = new MediaStream(
      audio ? [videoTrack, audio] : [videoTrack]
    );
    this.stream = combined;
    if (this.video) {
      this.video.srcObject = combined;
      void this.video.play().catch(() => {});
    }
    this.activeLensId = lensId;
    // a camera opened: the hardware is clearly healthy, so wipe EVERY
    // lens's recorded misses. Counting misses per-lens across unrelated
    // busy spells is what produced the occasional false "this phone
    // doesn't let apps use that lens" that later cleared on its own.
    this.lensFailures.clear();
    // A new track focuses continuously and has its own torch state, so any
    // AF lock the UI is showing is no longer real. Say so rather than
    // leaving a padlock on screen that locks nothing.
    this.torchOn = false;
    window.dispatchEvent(new Event("gpscam:track-changed"));
    // drop the held frame only once the new lens is actually painting,
    // otherwise the cross-fade just reveals the black gap it was hiding
    this.unfreezeOnFirstFrame();
  }

  /* ---- freeze-frame cover -------------------------------------------- */

  private freezeCanvas: HTMLCanvasElement | null = null;
  /** How the NEXT held frame should scale while the lens opens: >1 when
   *  zooming in (.6x->1x), <1 when zooming out. Read once by freeze(). */
  private freezeScale = 1;

  /** The canvas CameraView stacks over the viewfinder for lens switches. */
  setFreezeSurface(el: HTMLCanvasElement | null): void {
    this.freezeCanvas = el;
  }

  /** Paint the current frame onto the cover and show it. */
  private freeze(): void {
    const c = this.freezeCanvas;
    const v = this.video;
    if (!c || !v || !v.videoWidth) return;
    c.width = v.videoWidth;
    c.height = v.videoHeight;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    try {
      ctx.drawImage(v, 0, 0, c.width, c.height);
    } catch {
      return; // nothing paintable yet
    }
    // The held frame must match what was on screen, digital crop included —
    // and then GLIDE toward the target framing while the lens opens, so the
    // hardware gap reads as a deliberate zoom animation instead of a stall.
    // Nothing can make the physical switch itself instant in a WebView;
    // this is the honest way to spend that time.
    const base = v.style.transform || "";
    const glide = Math.min(2, Math.max(0.5, this.freezeScale));
    this.freezeScale = 1;
    c.style.transition = "none";
    c.style.transform = base;
    if (glide !== 1) {
      requestAnimationFrame(() => {
        if (c.dataset.on !== "1") return;
        c.style.transition = "transform 0.55s cubic-bezier(0.3, 0.6, 0.3, 1)";
        c.style.transform = `${base} scale(${glide})`.trim();
      });
    }
    // Pin the box while the video has no data. The box takes its size from
    // the <video>, so an emptied element collapsed it to a couple of pixels
    // — and because the box clips its overflow, that clipped the held frame
    // away and showed a black flash in the middle of the switch.
    const box = c.parentElement;
    if (box) {
      box.style.minWidth = `${box.offsetWidth}px`;
      box.style.minHeight = `${box.offsetHeight}px`;
    }
    c.dataset.on = "1";
  }

  private unfreeze(): void {
    const c = this.freezeCanvas;
    if (!c) return;
    delete c.dataset.on;
    const box = c.parentElement;
    if (box) {
      box.style.minWidth = "";
      box.style.minHeight = "";
    }
  }

  private unfreezeOnFirstFrame(): void {
    const v = this.video;
    if (!v) {
      this.unfreeze();
      return;
    }
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      this.unfreeze();
    };
    type WithRvfc = HTMLVideoElement & {
      requestVideoFrameCallback?: (cb: () => void) => number;
    };
    const rvfc = (v as WithRvfc).requestVideoFrameCallback;
    if (rvfc) rvfc.call(v, finish);
    else v.addEventListener("loadeddata", finish, { once: true });
    // Belt and braces: never leave a still frame standing in for a live
    // camera, however the new track behaves. Generous, because a slow phone
    // may need a retry or two to hand the lens over and dropping the cover
    // early just exposes the black gap it exists to hide.
    window.setTimeout(finish, 3000);
  }

  /** deviceId of the lens currently streaming (null = default/main). */
  private activeLensId: string | null = null;
  private lensSwapping = false;
  /** consecutive open failures per lens, so one miss is not fatal */
  private lensFailures = new Map<string, number>();
  /** true once a physical lens has repeatedly refused to open here */
  lensUnavailable = false;

  /** Zoom factor of the lens currently in use. */
  get activeLensFactor(): number {
    const l = this.lenses.find((x) => x.deviceId === this.activeLensId);
    return l?.factor ?? 1;
  }

  async setZoom(value: number): Promise<number> {
    const info = this.zoomInfo();
    const clamped = Math.min(info.max, Math.max(info.min, value));
    this.desiredZoom = clamped;

    // SEAMLESS first. When the track's own zoom range spans the lenses, the
    // camera stack does the handover internally: no stop, no reopen, no gap
    // to paper over — the same mechanism that makes the stock camera app's
    // .6×→1× transition continuous. Doing our own physical switch here
    // would be strictly worse, so don't.
    if (this.seamlessZoom && this.track) {
      try {
        await this.track.applyConstraints({
          advanced: [{ zoom: clamped } as MediaTrackConstraintSet],
        });
        this.digitalZoom = 1;
        this.applyDigitalTransform();
        this.zoomValue = clamped;
        return this.zoomValue;
      } catch {
        // fall through to the lens-switching path below
      }
    }

    // OPTICAL: hand over to the physical lens that natively covers
    // this factor (ultra-wide below 1×, telephoto at its factor and up),
    // then crop only the remainder. That is what keeps a 3× shot sharp
    // instead of upscaling a crop of the main sensor. A swap-in-flight
    // flag stops a fast pinch firing overlapping getUserMedia calls.
    if (this.lenses.length > 1 && !this.lensSwapping) {
      const want = this.lensFor(clamped);
      if (want && want.deviceId !== (this.activeLensId ?? this.mainDeviceId)) {
        this.lensSwapping = true;
        this.freezeScale = clamped / (this.zoomValue || 1);
        // always switch by explicit deviceId — plain facingMode can hand
        // back a different lens entirely on some phones
        const ok = await this.useDevice(want.deviceId);
        this.lensSwapping = false;
        if (ok) {
          this.digitalZoom = Math.max(1, clamped / want.factor);
          this.applyDigitalTransform();
          this.zoomValue = clamped;
          return this.zoomValue;
        }
        // The lens did not open. Do NOT write it off on the first failure:
        // a camera can be momentarily busy (another switch still settling,
        // the app returning from the background), and permanently dropping
        // it on one miss is what left zoom broken until the app was killed
        // and relaunched. Only give up after it has failed repeatedly.
        const misses = (this.lensFailures.get(want.deviceId) ?? 0) + 1;
        this.lensFailures.set(want.deviceId, misses);
        if (misses >= 3) {
          this.lenses = this.lenses.filter((l) => l.deviceId !== want.deviceId);
          this.lensUnavailable = true;
        }
        const floor = this.zoomInfo().min;
        this.digitalZoom = Math.max(1, clamped);
        this.applyDigitalTransform();
        this.zoomValue = Math.max(floor, Math.max(1, clamped));
        return this.zoomValue;
      }
      // already on the right lens: the residual is a digital crop on top
      const base = this.activeLensFactor;
      if (base !== 1) {
        this.digitalZoom = Math.max(1, clamped / base);
        this.applyDigitalTransform();
        this.zoomValue = clamped;
        return this.zoomValue;
      }
    }

    if (info.hardware && this.track) {
      try {
        await this.track.applyConstraints({
          advanced: [{ zoom: clamped } as MediaTrackConstraintSet],
        });
        this.zoomValue = clamped;
      } catch {
        // unsupported after all — ignore
      }
      return this.zoomValue;
    }
    // Digital: crop-scale the preview; capture/record apply the same crop.
    // NEVER below 1 — cropping cannot add field of view, and scaling the
    // video element down just shrank the viewfinder into a small
    // rectangle (exactly what a failed ultra-wide switch used to do).
    this.digitalZoom = Math.max(1, clamped);
    this.zoomValue = this.digitalZoom;
    this.applyDigitalTransform();
    return this.zoomValue;
  }

  /** Scale factor to crop by when capturing/recording (1 = no crop). */
  get captureZoom(): number {
    return this.zoomInfo().hardware ? 1 : this.digitalZoom;
  }

  private applyDigitalTransform(): void {
    if (!this.video) return;
    const z = this.digitalZoom;
    const mirror = this.facing === "user";
    // combine with the front-camera mirror so both survive
    this.video.style.transformOrigin = "center";
    this.video.style.transform = mirror
      ? `scaleX(${-z}) scaleY(${z})`
      : `scale(${z})`;
  }

  get zoom(): number {
    return this.zoomValue;
  }

  async setTorch(on: boolean): Promise<boolean> {
    if (!this.track || !this.capabilities().torch) return false;
    try {
      await this.track.applyConstraints({
        advanced: [{ torch: on } as MediaTrackConstraintSet],
      });
      this.torchOn = on;
      return true;
    } catch {
      return false;
    }
  }

  get torch(): boolean {
    return this.torchOn;
  }

  /** Best-effort tap-to-focus; most browsers silently ignore this. */
  /**
   * Focus (and meter) where the user tapped.
   *
   * `point` is normalised 0..1 across the frame the viewfinder is showing.
   * This used to send focusMode alone with no coordinates, so every tap
   * re-ran autofocus on whatever the camera already considered the subject
   * — the ring moved, the focus did not. pointsOfInterest is what actually
   * aims it; falls back through progressively simpler constraints for
   * pipelines that accept less.
   */
  async focusAt(point?: { x: number; y: number }): Promise<boolean> {
    const track = this.track;
    if (!track) return false;
    // a fresh tap always wins over a sweep still in progress
    this.afGeneration++;
    this.afRunning = false;
    window.clearTimeout(this.afResumeTimer);
    const poi = point
      ? [
          {
            x: Math.min(1, Math.max(0, point.x)),
            y: Math.min(1, Math.max(0, point.y)),
          },
        ]
      : null;
    // AIMED forms only. A bare focusMode: single-shot must NOT be treated
    // as success here: it is accepted by cameras that ignore the aim point
    // entirely, so returning on it meant the app reported "focused" while
    // refocusing on whatever it already liked — which is exactly why
    // tapping different places did nothing on the owner's phone.
    const tries: Record<string, unknown>[] = poi
      ? [
          { pointsOfInterest: poi, focusMode: "single-shot" },
          { pointsOfInterest: poi },
        ]
      : [{ focusMode: "single-shot" }];
    for (const advanced of tries) {
      try {
        await track.applyConstraints({
          advanced: [advanced as unknown as MediaTrackConstraintSet],
        });
      } catch {
        continue; // this pipeline rejects this form — try a simpler one
      }
      // An UNSUPPORTED advanced constraint is silently ignored rather than
      // rejected, so a resolved promise proves nothing. Read back.
      if (advanced.pointsOfInterest) {
        const now = (track.getSettings?.() ?? {}) as Record<string, unknown>;
        const got = now.pointsOfInterest as { x: number }[] | undefined;
        this.aimSupported = Array.isArray(got) && got.length > 0;
        if (this.aimSupported) {
          this.aimMethod = "aim point accepted";
          return true;
        }
        continue;
      }
      return true;
    }
    if (!poi) return false;
    // some pipelines only accept it as a BASIC constraint
    {
      try {
        await track.applyConstraints({
          pointsOfInterest: poi,
        } as unknown as MediaTrackConstraints);
        const now = (track.getSettings?.() ?? {}) as Record<string, unknown>;
        this.aimSupported = Array.isArray(now.pointsOfInterest);
        if (this.aimSupported) return true;
      } catch {
        this.aimSupported = false;
      }
    }
    // The WebView ignores pointsOfInterest outright on some phones (the
    // owner's S25+ reports exactly that), but it DOES expose manual focus
    // with a focusDistance range. So focus the old-fashioned way: sweep the
    // lens and keep the distance that makes the tapped area sharpest. This
    // is what a camera does internally; we can do it from here because we
    // can both set the distance and see the result.
    if (point && this.focusDistanceRange()) {
      const ok = await this.contrastFocus(point);
      if (ok) {
        this.aimMethod = "contrast sweep (camera ignores aim points)";
        return true;
      }
    }
    // nothing aimed worked — at least re-run the camera's own autofocus
    try {
      await track.applyConstraints({
        advanced: [
          { focusMode: "single-shot" } as unknown as MediaTrackConstraintSet,
        ],
      });
    } catch {
      // nothing more to try
    }
    return false;
  }

  private focusDistanceRange(): { min: number; max: number } | null {
    const caps = (this.track?.getCapabilities?.() ?? {}) as Record<string, unknown>;
    const modes = caps.focusMode as string[] | undefined;
    const fd = caps.focusDistance as { min?: number; max?: number } | undefined;
    if (!fd || typeof fd.min !== "number" || typeof fd.max !== "number") return null;
    if (fd.max <= fd.min) return null;
    if (modes && !modes.includes("manual")) return null;
    return { min: fd.min, max: fd.max };
  }

  /** Sharpness of a region of the current frame (gradient energy). */
  private sharpnessAt(point: { x: number; y: number }): number | null {
    const v = this.video;
    if (!v || !v.videoWidth) return null;
    const N = 64; // sample the region into a small square
    const c = (this.afCanvas ??= document.createElement("canvas"));
    c.width = N;
    c.height = N;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    // a region around the tap, ~22% of the frame, kept inside the picture
    const rw = v.videoWidth * 0.22;
    const rh = v.videoHeight * 0.22;
    const sx = Math.min(v.videoWidth - rw, Math.max(0, point.x * v.videoWidth - rw / 2));
    const sy = Math.min(v.videoHeight - rh, Math.max(0, point.y * v.videoHeight - rh / 2));
    try {
      ctx.drawImage(v, sx, sy, rw, rh, 0, 0, N, N);
    } catch {
      return null;
    }
    const d = ctx.getImageData(0, 0, N, N).data;
    const lum = new Float32Array(N * N);
    for (let i = 0, j = 0; i < d.length; i += 4, j++) {
      lum[j] = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    }
    let energy = 0;
    let mean = 0;
    for (let i = 0; i < lum.length; i++) mean += lum[i];
    mean /= lum.length;
    for (let y = 1; y < N - 1; y++) {
      for (let x = 1; x < N - 1; x++) {
        const i = y * N + x;
        const gx = lum[i + 1] - lum[i - 1];
        const gy = lum[i + N] - lum[i - N];
        energy += gx * gx + gy * gy;
      }
    }
    // Normalise by brightness: autoexposure shifts during a sweep, and a
    // darker frame has smaller gradients for reasons that have nothing to
    // do with focus.
    return energy / Math.max(1, mean * mean);
  }

  /** Wait for the preview to actually deliver new frames. */
  private nextFrames(count: number, capMs: number): Promise<void> {
    const v = this.video as
      | (HTMLVideoElement & { requestVideoFrameCallback?: (cb: () => void) => number })
      | null;
    if (!v?.requestVideoFrameCallback) return CameraController.settle(capMs);
    return new Promise((resolve) => {
      let seen = 0;
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        resolve();
      };
      const step = () => {
        if (done) return;
        if (++seen >= count) return finish();
        v.requestVideoFrameCallback!(step);
      };
      v.requestVideoFrameCallback!(step);
      window.setTimeout(finish, capMs);
    });
  }

  private afCanvas: HTMLCanvasElement | null = null;
  private afRunning = false;

  /**
   * Focus on the tapped area by trying distances and keeping the sharpest.
   * Coarse pass across the whole range, then a fine pass around the winner.
   */
  private async contrastFocus(point: { x: number; y: number }): Promise<boolean> {
    const range = this.focusDistanceRange();
    const track = this.track;
    if (!range || !track || this.afRunning) return false;
    this.afRunning = true;
    this.afGeneration++;
    const gen = this.afGeneration;
    /**
     * Set a distance and measure once the lens has actually got there.
     * The first version waited a flat 110 ms, which is less than the lens
     * takes to move on real hardware — so each reading described the
     * PREVIOUS distance's picture and the sweep settled somewhere blurry.
     * Wait for real frames instead, and throw the first ones away.
     */
    const measure = async (
      distance: number
    ): Promise<{ at: number; score: number } | null> => {
      try {
        await track.applyConstraints({
          advanced: [
            { focusMode: "manual", focusDistance: distance } as unknown as MediaTrackConstraintSet,
          ],
        });
      } catch {
        return null;
      }
      await this.nextFrames(3, 320);
      if (gen !== this.afGeneration) return null; // a newer tap took over
      const score = this.sharpnessAt(point);
      if (score == null) return null;
      // Credit the reading to where the lens ACTUALLY is, not where it was
      // asked to go. A lens in motion means the frame just measured belongs
      // to a different distance than the one requested — attributing it to
      // the request is what made the sweep pick a distance that then turned
      // out blurry when it landed there.
      const now = (track.getSettings?.() ?? {}) as Record<string, unknown>;
      const at =
        typeof now.focusDistance === "number" ? now.focusDistance : distance;
      return { at, score };
    };
    try {
      let best = { d: range.min, score: -1 };
      const sweep = async (from: number, to: number, steps: number) => {
        for (let i = 0; i < steps; i++) {
          if (gen !== this.afGeneration) return;
          const d = from + ((to - from) * i) / (steps - 1);
          const r = await measure(d);
          if (r && r.score > best.score) best = { d: r.at, score: r.score };
        }
      };
      await sweep(range.min, range.max, 6);
      if (gen !== this.afGeneration || best.score <= 0) return false;
      const span = (range.max - range.min) / 5;
      await sweep(
        Math.max(range.min, best.d - span),
        Math.min(range.max, best.d + span),
        4
      );
      if (gen !== this.afGeneration) return false;
      // Land on the winner and CHECK it. If the picture there is much worse
      // than the reading that won, the sweep was misled (the scene moved,
      // or the lens lagged) — rather than leave the camera parked out of
      // focus, hand it back to the camera's own autofocus.
      // Land on the winner and CHECK it — patiently. The lens may have to
      // travel back across the range to get here, so the first reading can
      // still be describing where it was, not where it is. Give it longer
      // and take a second look before concluding the sweep was wrong.
      const first = await measure(best.d);
      if (gen !== this.afGeneration) return false;
      let confirmed = first?.score ?? null;
      if (confirmed == null || confirmed < best.score * 0.6) {
        // the lens may still be travelling — look again before giving up
        await this.nextFrames(4, 500);
        if (gen !== this.afGeneration) return false;
        confirmed = this.sharpnessAt(point);
      }
      if (confirmed == null || confirmed < best.score * 0.6) {
        await this.resumeAutoFocus();
        return false;
      }
      this.autoResumeFocus(gen);
      return true;
    } finally {
      if (gen === this.afGeneration) this.afRunning = false;
    }
  }

  /** Bumped by every new tap, so an in-flight sweep abandons quietly. */
  private afGeneration = 0;
  private afResumeTimer = 0;

  /** Back to the camera's own continuous autofocus. */
  private async resumeAutoFocus(): Promise<void> {
    try {
      await this.track?.applyConstraints({
        advanced: [
          { focusMode: "continuous" } as unknown as MediaTrackConstraintSet,
        ],
      });
    } catch {
      // nothing to undo
    }
  }

  /**
   * Hold the tapped focus for a few seconds, then let the camera take over
   * again — so a tap never leaves the preview parked out of focus, and the
   * user does not have to tap somewhere else to recover. Cancelled if the
   * focus gets locked, or another tap starts a new sweep.
   */
  private autoResumeFocus(gen: number): void {
    window.clearTimeout(this.afResumeTimer);
    this.afResumeTimer = window.setTimeout(() => {
      if (gen !== this.afGeneration || this.focusHeld) return;
      void this.resumeAutoFocus();
    }, 4000);
  }

  /** Set while the user has explicitly locked focus. */
  focusHeld = false;

  /** Did the camera accept an aim point the last time we sent one? */
  aimSupported: boolean | null = null;
  /** How the last tap-to-focus was actually achieved, for the report. */
  aimMethod: string | null = null;

  /**
   * What this camera pipeline actually lets us control. Shown in Settings:
   * the WebView and Chrome expose different sets on the SAME phone, and
   * guessing from the outside has cost several release cycles.
   */
  /**
   * Capability report for support.
   *
   * MUST open a camera if one is not already running: with no live track
   * every capability reads as "not offered", which is indistinguishable
   * from a phone that genuinely offers nothing. A report taken from the
   * Settings screen said exactly that about a Motorola with a working
   * ultra-wide, and it was wrong — the camera was simply not running.
   */
  async controlReport(): Promise<Record<string, string>> {
    if (this.track) return { ...this.controlReportCore() };
    let temp: MediaStream | null = null;
    try {
      temp = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment" },
      });
      const t = temp.getVideoTracks()[0];
      const caps = (t?.getCapabilities?.() ?? {}) as Record<string, unknown>;
      const set = (t?.getSettings?.() ?? {}) as Record<string, unknown>;
      const report = this.reportFrom(caps, set);
      report["Note"] = "measured from a temporary camera (viewfinder was idle)";
      return report;
    } catch (e) {
      return {
        Camera: "could not be opened",
        Why: (e as { name?: string })?.name ?? "unknown error",
        Note: "open the camera screen first, then check again",
        Runtime: isNativeApp() ? "Android app" : "browser",
        Build: `${__BUILD_TS__.slice(0, 16).replace("T", " ")} UTC`,
        Browser: navigator.userAgent.slice(0, 90),
      };
    } finally {
      for (const t of temp?.getTracks() ?? []) t.stop();
    }
  }

  private controlReportCore(): Record<string, string> {
    return this.reportFrom(
      (this.track?.getCapabilities?.() ?? {}) as Record<string, unknown>,
      (this.track?.getSettings?.() ?? {}) as Record<string, unknown>
    );
  }

  private reportFrom(
    caps: Record<string, unknown>,
    set: Record<string, unknown>
  ): Record<string, string> {
    const range = (v: unknown) => {
      const r = v as { min?: number; max?: number } | undefined;
      return r && typeof r.min === "number" ? `${r.min} – ${r.max}` : "not offered";
    };
    return {
      Camera: String(set.deviceId ?? "default").slice(0, 12),
      Zoom: range(caps.zoom),
      "Focus modes": Array.isArray(caps.focusMode)
        ? (caps.focusMode as string[]).join(", ")
        : "not offered",
      "Focus distance": range(caps.focusDistance),
      "Tap to focus":
        this.aimMethod ??
        (this.aimSupported === null
          ? "not tried yet — tap the viewfinder once"
          : "aim points ignored, and no manual focus to fall back on"),
      Exposure: range(caps.exposureCompensation),
      "Exposure mode": Array.isArray(caps.exposureMode)
        ? (caps.exposureMode as string[]).join(", ")
        : "not offered",
      "Aim (pointsOfInterest)": caps.pointsOfInterest ? "offered" : "not offered",
      "White balance": Array.isArray(caps.whiteBalanceMode)
        ? (caps.whiteBalanceMode as string[]).join(", ")
        : "not offered",
      Torch: caps.torch ? "yes" : "not offered",
      Resolution: `${set.width ?? "?"}x${set.height ?? "?"} @ ${set.frameRate ?? "?"}fps`,
      "Sensor max": `${(caps.width as { max?: number })?.max ?? "?"}x${
        (caps.height as { max?: number })?.max ?? "?"
      }`,
      Lenses: this.lenses.length
        ? this.lenses.map((l) => `${l.factor}x`).join(", ")
        : "single camera",
      "Seamless zoom": this.seamlessZoom ? "yes" : "no",
      Runtime: isNativeApp() ? "Android app" : "browser",
      Build: `${__BUILD_TS__.slice(0, 16).replace("T", " ")} UTC`,
      Browser: navigator.userAgent.slice(0, 90),
    };
  }

  /** Exposure-compensation range/value, when the camera exposes it
   *  (most Android Chromium camera pipelines do). null = hide the slider. */
  exposureInfo(): { min: number; max: number; step: number; value: number } | null {
    const caps = (this.track?.getCapabilities?.() ?? {}) as Record<string, unknown>;
    const ec = caps.exposureCompensation as
      | { min: number; max: number; step: number }
      | undefined;
    if (!ec || typeof ec.min !== "number" || ec.min === ec.max) return null;
    const settings = (this.track?.getSettings?.() ?? {}) as Record<string, unknown>;
    return {
      min: ec.min,
      max: ec.max,
      step: ec.step || 0.1,
      value:
        typeof settings.exposureCompensation === "number"
          ? (settings.exposureCompensation as number)
          : 0,
    };
  }

  /** Samsung-style brightness slider under the focus ring. */
  async setExposure(value: number): Promise<boolean> {
    if (!this.track) return false;
    try {
      await this.track.applyConstraints({
        advanced: [
          { exposureCompensation: value } as unknown as MediaTrackConstraintSet,
        ],
      });
      return true;
    } catch {
      return false;
    }
  }

  /** AF lock: freeze the lens at its current position (focusMode manual +
   *  the current focusDistance). Returns false when the device/browser
   *  doesn't support it, so the UI can skip the lock chip honestly. */
  /**
   * AF lock.
   *
   * This worked before the app started opening a specific physical camera
   * by deviceId: on Samsung the LOGICAL rear camera advertises
   * focusMode: ["manual", ...] while the individual camera2 devices behind
   * it often advertise nothing at all — so capability-gating the lock made
   * it "unsupported" on a camera that can in fact hold focus.
   *
   * So: do not gate on capabilities. Try every form of the constraint that
   * any Android WebView is known to accept, and confirm from getSettings()
   * that it actually took, rather than trusting either the capability list
   * or a silently-resolved applyConstraints.
   */
  async lockFocus(): Promise<boolean> {
    for (let attempt = 0; attempt < 2; attempt++) {
      // a tap landing mid-switch finds a track that is still settling
      if (this.lensSwapping) {
        await CameraController.settle(200);
        continue;
      }
      if (await this.tryLockFocus()) return true;
      await CameraController.settle(150);
    }
    return false;
  }

  private async tryLockFocus(): Promise<boolean> {
    const track = this.track;
    if (!track) return false;
    const settings = (track.getSettings?.() ?? {}) as Record<string, unknown>;
    const caps = (track.getCapabilities?.() ?? {}) as Record<string, unknown>;
    const fd = settings.focusDistance as number | undefined;
    const fdCap = caps.focusDistance as { min?: number; max?: number } | undefined;
    const distance = fd ?? fdCap?.min;
    // most specific first; single-shot last because it re-focuses once
    // before holding, which is the least "locked" of the options
    const tries: Record<string, unknown>[] = [
      ...(distance != null
        ? [{ focusMode: "manual", focusDistance: distance }]
        : []),
      { focusMode: "manual" },
      { focusMode: "single-shot" },
    ];
    for (const advanced of tries) {
      try {
        await track.applyConstraints({
          advanced: [advanced as unknown as MediaTrackConstraintSet],
        });
      } catch {
        continue; // this camera rejects this form; try the next
      }
      // did it stick? some pipelines resolve the promise and ignore it
      const now = (track.getSettings?.() ?? {}) as Record<string, unknown>;
      const mode = now.focusMode as string | undefined;
      if (mode === undefined || mode === advanced.focusMode) {
        // an explicit lock outranks the tap-to-focus auto-resume
        this.focusHeld = true;
        return true;
      }
    }
    return false;
  }

  /** Back to continuous autofocus (unlock). */
  async unlockFocus(): Promise<void> {
    this.focusHeld = false;
    if (!this.track) return;
    try {
      await this.track.applyConstraints({
        advanced: [
          { focusMode: "continuous" } as unknown as MediaTrackConstraintSet,
        ],
      });
    } catch {
      // ignore — a camera restart resets focus anyway
    }
  }

  /**
   * Grab a full-resolution frame. Returns an ImageBitmap (fast path for
   * canvas compositing) — never downscaled below the stream resolution.
   */
  async captureFrame(): Promise<ImageBitmap> {
    const track = this.track;
    if (!track) throw new Error("camera not running");
    const video = this.video;

    // Native app at 1× with no digital crop: grab the live preview frame
    // directly — instant, and there is no detail to gain. But when a
    // DIGITAL crop is active, that shortcut is exactly what destroyed
    // zoomed image quality: cropping a 1080p preview at 2× leaves ~540p
    // of real detail, upscaled to full size (blurry, unreadable text).
    // Zoomed digital captures therefore take the full-sensor photo path
    // below, so the crop comes out of a many-megapixel frame instead.
    if (
      isNativeApp() &&
      video &&
      video.readyState >= 2 &&
      this.captureZoom === 1
    ) {
      return await createImageBitmap(video);
    }

    if (window.ImageCapture) {
      try {
        const ic = new window.ImageCapture(track);
        const blob = await ic.takePhoto();
        return await createImageBitmap(blob);
      } catch {
        // fall through to video-frame grab
      }
    }
    if (!video || video.readyState < 2) throw new Error("no frame available");
    return await createImageBitmap(video);
  }
}

export const camera = new CameraController();
