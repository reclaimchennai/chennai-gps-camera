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
import { measureLensFactor } from "./lens-calibrate";

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
    // Open the known 1x lens by deviceId when we have one. `facingMode:
    // environment` is not a promise of the main camera — several phones
    // hand back the ultra-wide — so relying on it meant the viewfinder
    // started on a wide shot that the app then called 1x. The id has to be
    // re-resolved against the live device list every time (see
    // resolveLensProfile): saved ids go stale between launches.
    const known =
      facing === "environment" ? await this.knownMainDeviceId() : null;
    const byFacing: MediaTrackConstraints = { facingMode: facing, ...size };
    const video: MediaTrackConstraints = known
      ? { deviceId: { exact: known }, ...size }
      : byFacing;

    /**
     * Relax the VIDEO constraint before touching audio.
     *
     * The old ladder reused the same video constraint for its first three
     * rungs and only varied audio, so one unusable deviceId meant the only
     * attempt that could succeed was the `audio: false` one — every
     * recording came out silent, and the four rejections in a row put a
     * multi-second spinner on the launch screen.
     */
    const attempts: MediaStreamConstraints[] = [
      { audio, video },
      ...(known ? [{ audio, video: byFacing }] : []),
      { audio: baseAudio, video: byFacing },
      { audio: false, video: byFacing },
      { audio: false, video: { facingMode: facing } },
    ];
    let opened: MediaStream | null = null;
    let lastErr: unknown = null;
    for (const c of attempts) {
      try {
        opened = await navigator.mediaDevices.getUserMedia(c);
        break;
      } catch (e) {
        lastErr = e;
      }
    }
    if (!opened) throw lastErr instanceof Error ? lastErr : new Error("camera");
    this.stream = opened;
    this.zoomValue = 1;
    this.digitalZoom = 1;
    this.torchOn = false;
    this.activeLensId = null;
    this.mainDeviceId =
      this.stream.getVideoTracks()[0]?.getSettings?.().deviceId ?? null;
    if (this.video) this.video.style.transform = "";
    // discover the phone's other rear lenses in the background so pinch
    // zoom can hand over to real optics
    void this.detectLenses();
    return this.stream;
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

  /**
   * Current deviceId of the remembered 1x lens, or null if there is no
   * usable profile. Enumerating costs a few ms and opens nothing, unlike
   * trusting a saved id and discovering it is dead one getUserMedia at a
   * time.
   */
  private async knownMainDeviceId(): Promise<string | null> {
    try {
      if (!loadLensProfile().length) return null;
      const devices = await navigator.mediaDevices.enumerateDevices();
      const resolved = resolveLensProfile(devices);
      if (!resolved.length) return null;
      this.lenses = resolved;
      return pickMainLens(resolved)?.deviceId ?? null;
    } catch {
      return null;
    }
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
    // track.stop() returns immediately but Android releases the camera
    // asynchronously, so opening the next lens straight away hits
    // NotReadableError. That is why lens switching worked on the very first
    // launch (discovery's probe sequence supplied natural gaps) and then
    // failed on every launch afterwards, reporting that the phone would not
    // allow the lens at all. Give the hardware a moment, then retry.
    await CameraController.settle(RELEASE_MS);

    const open = async (id: string | null): Promise<MediaStreamTrack | null> => {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const s = await navigator.mediaDevices.getUserMedia({
            audio: false,
            video: wanted(id),
          });
          return s.getVideoTracks()[0] ?? null;
        } catch {
          // busy, not unsupported: wait longer each time before giving up
          await CameraController.settle(RELEASE_MS * (attempt + 2));
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
    // this lens works: clear any recorded misses so a single hiccup earlier
    // cannot accumulate toward writing it off
    if (lensId) this.lensFailures.delete(lensId);
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
    // the held frame must match what was on screen, digital crop included
    c.style.transform = v.style.transform || "";
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

    // OPTICAL first: hand over to the physical lens that natively covers
    // this factor (ultra-wide below 1×, telephoto at its factor and up),
    // then crop only the remainder. That is what keeps a 3× shot sharp
    // instead of upscaling a crop of the main sensor. A swap-in-flight
    // flag stops a fast pinch firing overlapping getUserMedia calls.
    if (this.lenses.length > 1 && !this.lensSwapping) {
      const want = this.lensFor(clamped);
      if (want && want.deviceId !== (this.activeLensId ?? this.mainDeviceId)) {
        this.lensSwapping = true;
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
  async focusAt(): Promise<void> {
    if (!this.track) return;
    try {
      await this.track.applyConstraints({
        advanced: [
          { focusMode: "single-shot" } as unknown as MediaTrackConstraintSet,
        ],
      });
    } catch {
      // not supported — the tap still shows the focus ring for feedback
    }
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
  async lockFocus(): Promise<boolean> {
    if (!this.track) return false;
    try {
      // A track that has only just started can report an empty capability
      // set for a moment, which read as "this camera cannot lock focus" and
      // stuck until the app was restarted. Give it a beat to fill in.
      let caps = (this.track.getCapabilities?.() ?? {}) as Record<string, unknown>;
      for (let i = 0; i < 3 && !caps.focusMode; i++) {
        await new Promise((r) => window.setTimeout(r, 150));
        if (!this.track) return false;
        caps = (this.track.getCapabilities?.() ?? {}) as Record<string, unknown>;
      }
      const modes = caps.focusMode as string[] | undefined;
      if (!modes?.includes("manual")) {
        // some Android WebViews expose a one-shot lock instead of manual
        if (modes?.includes("single-shot")) {
          await this.track.applyConstraints({
            advanced: [
              { focusMode: "single-shot" } as unknown as MediaTrackConstraintSet,
            ],
          });
          return true;
        }
        return false;
      }
      const settings = (this.track.getSettings?.() ?? {}) as Record<string, unknown>;
      const fd = settings.focusDistance as number | undefined;
      await this.track.applyConstraints({
        advanced: [
          (fd != null
            ? { focusMode: "manual", focusDistance: fd }
            : { focusMode: "manual" }) as unknown as MediaTrackConstraintSet,
        ],
      });
      return true;
    } catch {
      return false;
    }
  }

  /** Back to continuous autofocus (unlock). */
  async unlockFocus(): Promise<void> {
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
