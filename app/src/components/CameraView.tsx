import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { camera } from "../lib/camera";
import { qualityPlan } from "../lib/quality";
import { startMeter, stopMeter, sampleNoiseOnce } from "../lib/audio/meter";
import { scheduleBackfill } from "../lib/backfill";
import { grabFrame, collectWatermarkData, getProfilePhoto } from "../lib/capture";
import { enqueueCapture, onPendingChange } from "../lib/captureQueue";
import { renderWatermark, type WatermarkAssets } from "../lib/watermark/render";
import { renderMiniMap } from "../lib/watermark/minimap";
import { renderLocationQr } from "../lib/watermark/qr";
import { loadCrest } from "../lib/watermark/crests";
import { nativeAudioFocus } from "../lib/native";
import { signStyle } from "../lib/watermark/chennaiSign";
import { latLngToDigipin } from "../lib/geo/digipin";
import { useLiveStore, useSettingsStore } from "../store";
import {
  isNativeApp,
  checkNativePermissions,
  ensureCameraPermissions,
  requestLocationPermissionNative,
  setShutterKeys,
} from "../lib/native";
import { navigate } from "../nav";
import { hapticTap, hapticDouble } from "../lib/haptics";
import { listMedia, getBlob, newId, putBlob, putMedia } from "../lib/db";
import { makeThumbnail } from "../lib/img";
import { detectFaces, type DetectedBox } from "../lib/detect/faces";
import { pickRecordingMime, finalizeVideoBlob } from "../lib/video/postprocess";
import { downloadBlob, suggestedName } from "../lib/share";
import type { VideoRecord } from "../types";
import {
  Zap,
  SwitchCamera,
  Settings,
  Images,
  Camera,
  Lock,
  LockOpen,
} from "lucide-react";

type Mode = "photo" | "video";

// 1×1 black PNG — used as the viewfinder <video> poster so the
// pre-stream gap renders dark instead of the UA play-button overlay.
const BLACK_POSTER =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC";

/** ".6×", "1×", "3×", "2.5×" — trims the pointless trailing zero. */
function fmtZoom(z: number): string {
  const s = z < 1 ? z.toFixed(1).replace(/^0/, "") : z.toFixed(1);
  return `${s.endsWith(".0") ? s.slice(0, -2) : s}×`;
}

export default function CameraView({ active }: { active: boolean }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const freezeRef = useRef<HTMLCanvasElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);

  // The video must never exceed the viewfinder zone, whatever the screen
  // or system-bar sizes — measure the real space instead of guessing, so
  // the watermark card (anchored to the video bottom) is always visible.
  useEffect(() => {
    const vp = viewportRef.current;
    const box = boxRef.current;
    if (!vp || !box) return;
    const apply = () => {
      // while the screen is display:none everything measures 0; writing that
      // in would collapse the viewfinder on the way back
      if (!vp.clientHeight || !vp.clientWidth) return;
      box.style.setProperty("--vph", `${vp.clientHeight}px`);
      box.style.setProperty("--vpw", `${vp.clientWidth}px`);
    };
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(vp);
    return () => ro.disconnect();
  }, []);
  const [mode, setMode] = useState<Mode>("photo");
  // true once the stream is genuinely painting, so the viewfinder zone can
  // stay flat black until then instead of showing a stray couple of pixels
  const [videoLive, setVideoLive] = useState(false);
  const livePollRef = useRef(0);
  // Poll instead of trusting media events: in the Android WebView the
  // 'emptied'/'loadeddata' pair does not fire reliably across srcObject
  // swaps, which left the collapsed <video> visible as a white speck in
  // the middle of the launch screen.
  const armLivePoll = useCallback(() => {
    // hide the stale element SYNCHRONOUSLY — the React state lands a frame
    // later, and that frame is the milliseconds-long flash of old picture
    // still visible on resume
    if (boxRef.current) boxRef.current.dataset.live = "false";
    setVideoLive(false);
    cancelAnimationFrame(livePollRef.current);
    const poll = () => {
      const v = videoRef.current;
      const track = (v?.srcObject as MediaStream | null)?.getVideoTracks?.()[0];
      // a REAL preview: transient junk streams report a 2 px frame with an
      // already-ended track, and counting that as live is what left the tiny
      // speck uncovered at boot
      if (
        v &&
        v.videoWidth >= 32 &&
        !v.paused &&
        track &&
        track.readyState === "live"
      )
        setVideoLive(true);
      else livePollRef.current = requestAnimationFrame(poll);
    };
    livePollRef.current = requestAnimationFrame(poll);
  }, []);
  const [ready, setReady] = useState(false);
  const [camError, setCamError] = useState<string | null>(null);
  const [torch, setTorch] = useState(false);
  const [zoomLabel, setZoomLabel] = useState<string | null>(null);
  // Lens stops (.6 / 1 / 3 …) shown ONLY while zooming, then faded out —
  // a permanent chip row would sit on top of the social-handle watermark.
  const [zoomStops, setZoomStops] = useState<number[]>([]);
  const [zoomNow, setZoomNow] = useState(1);
  // The stop list itself; the row lives in the controls bar and is always
  // visible, so there is no longer anything to show and hide.
  const showZoomBar = useCallback(() => {
    setZoomStops(camera.zoomStops());
  }, []);
  const [thumbUrl, setThumbUrl] = useState<string | null>(null);
  const [flashFx, setFlashFx] = useState(0);
  const [focusPos, setFocusPos] = useState<{ x: number; y: number; key: number } | null>(null);
  // Samsung-style focus UI: exposure slider under the ring + AF lock
  const [evInfo, setEvInfo] = useState<{ min: number; max: number; step: number } | null>(null);
  const [evVal, setEvVal] = useState(0);
  const [afLocked, setAfLocked] = useState(false);
  // Confirmation, not a permanent badge: two seconds, then it clears —
  // and the two seconds start when the focus cluster gets out of the way,
  // because the chip is hidden while that is on screen (the padlock there
  // is already showing the state). Counting from the tap instead meant the
  // window expired before the chip could ever be seen.
  const [afChip, setAfChip] = useState(false);
  const afChipPending = useRef(false);
  const afChipTimer = useRef(0);
  const flashAfChip = useCallback(() => {
    afChipPending.current = true;
  }, []);
  const focusHideTimer = useRef(0);
  const pinching = useRef(false);
  const tapCandidate = useRef<{ x: number; y: number } | null>(null);
  const lastZoomApply = useRef(0);

  /** Restart the auto-hide timer (any interaction keeps the UI alive). */
  const keepFocusUi = useCallback(() => {
    window.clearTimeout(focusHideTimer.current);
    focusHideTimer.current = window.setTimeout(() => setFocusPos(null), 2500);
  }, []);

  const evDragging = useRef(false);
  /**
   * Exposure from a pointer position, projected onto the slider's own axis.
   * Works at any rotation: the cluster turns with the device, so "along the
   * slider" is not "along the screen".
   */
  const applyEvFromPointer = useCallback(
    (clientX: number, clientY: number, el: HTMLElement) => {
      const info = camera.exposureInfo();
      if (!info) return;
      const r = el.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const rot = (useLiveStore.getState().uiRotation * Math.PI) / 180;
      const ax = Math.cos(rot);
      const ay = Math.sin(rot);
      // half the slider's VISUAL length along its own axis
      const half = (Math.abs(ax) > 0.5 ? r.width : r.height) / 2;
      if (half <= 0) return;
      const proj = (clientX - cx) * ax + (clientY - cy) * ay;
      const t = Math.min(1, Math.max(-1, proj / half));
      const raw = info.min + ((t + 1) / 2) * (info.max - info.min);
      const step = info.step || 0.1;
      const v = Math.round(raw / step) * step;
      const clamped = Math.min(info.max, Math.max(info.min, v));
      setEvVal(clamped);
      void camera.setExposure(clamped);
      keepFocusUi();
    },
    [keepFocusUi]
  );

  useEffect(() => {
    if (!afLocked) {
      afChipPending.current = false;
      setAfChip(false);
      return;
    }
    if (focusPos || !afChipPending.current) return;
    afChipPending.current = false;
    setAfChip(true);
    window.clearTimeout(afChipTimer.current);
    afChipTimer.current = window.setTimeout(() => setAfChip(false), 2000);
  }, [afLocked, focusPos]);

  const showFocusUi = useCallback(
    (x: number, y: number) => {
      // The group is ring + brightness + zoom stops stacked downward, so
      // a tap near an edge would push the lower rows off-screen. Keep the
      // whole cluster inside the viewport instead of just the ring.
      const box = boxRef.current?.getBoundingClientRect();
      const halfW = 105; // widest row (the stops) is ~200px
      const below = 150; // ring centre to the bottom of the stops
      const above = 46; // ring centre to the top of the padlock
      if (box) {
        const rot =
          ((useLiveStore.getState().uiRotation % 360) + 360) % 360;
        if (rot === 90 || rot === 270) {
          // the cluster is rotated: it now extends along screen-X
          const lead = rot === 90 ? below : above;
          const tail = rot === 90 ? above : below;
          x = Math.min(box.right - tail, Math.max(box.left + lead, x));
          y = Math.min(box.bottom - halfW, Math.max(box.top + halfW, y));
        } else {
          x = Math.min(box.right - halfW, Math.max(box.left + halfW, x));
          y = Math.min(box.bottom - below, Math.max(box.top + above, y));
        }
      }
      setFocusPos({ x, y, key: Date.now() });
      const info = camera.exposureInfo();
      setEvInfo(info ? { min: info.min, max: info.max, step: info.step } : null);
      if (info) setEvVal(info.value);
      keepFocusUi();
    },
    [keepFocusUi, showZoomBar]
  );
  const [toast, setToast] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [recSeconds, setRecSeconds] = useState(0);
  // live watermark card rect (rotated drawing space) from the overlay loop
  const cardInfoRef = useRef<{
    rect: { x: number; y: number; width: number; height: number } | null;
    rot: number;
    w: number;
    h: number;
  } | null>(null);
  const [recPos, setRecPos] = useState<{ left: number; top: number } | null>(null);
  // capture-in-flight UX: a preview that flies into the gallery button
  // and a pulse on the button while the real file finishes saving
  const [flyImg, setFlyImg] = useState<{ src: string; key: number } | null>(null);
  const [saving, setSaving] = useState(0);

  const settings = useSettingsStore((s) => s.settings);
  // physical device rotation → in-place icon/overlay rotation (camera-app
  // style; the layout itself never reflows)
  const uiRot = useLiveStore((s) => s.uiRotation);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const recChunksRef = useRef<Blob[]>([]);
  const recStartRef = useRef(0);
  const modeRef = useRef<Mode>("photo");
  modeRef.current = mode;

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast((t) => (t === msg ? null : t)), 2200);
  }, []);

  // ---- camera lifecycle (pre-warm on mount, §2) ---------------------
  // One stream serves both modes — startCam only runs on mount, camera
  // flip, and visibility restore. Photo/video switching never touches it.
  // iOS browser-tab sessions cannot persist camera/mic/location grants
  // across reloads (WebKit policy — Firefox/Chrome on iOS inherit it), so
  // those users get re-prompted every visit. Installing to the Home
  // Screen fixes it (standalone apps keep grants) — surface that once.
  const [iosHint, setIosHint] = useState(false);
  useEffect(() => {
    if (isNativeApp()) return;
    const standalone =
      window.matchMedia?.("(display-mode: standalone)").matches ||
      (navigator as { standalone?: boolean }).standalone === true;
    const isIos =
      /iPad|iPhone|iPod/.test(navigator.userAgent) ||
      (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
    if (isIos && !standalone && !localStorage.getItem("gpscam-ios-a2hs")) {
      setIosHint(true);
    }
  }, []);

  // First-run permission gate (native): NOTHING camera-related runs until
  // the Android permissions are actually held. getUserMedia racing the OS
  // dialogs is what poisoned the first launch (WebView caches the denial
  // for the page's lifetime — black camera until restart, capacitor#6881),
  // so the ONLY first-run prompt source is the explicit gate button below.
  //   "unknown"  → still checking (native boot)
  //   "needed"   → show the Enable-camera gate instead of a black box
  //   "denied"   → user refused; point at system settings
  //   "granted"  → normal camera lifecycle
  const [permState, setPermState] = useState<
    "unknown" | "needed" | "denied" | "granted"
  >(() => (isNativeApp() ? "unknown" : "granted"));
  useEffect(() => {
    if (!isNativeApp()) return;
    void (async () => {
      // The bridge can answer null — plugin not ready yet, or an older
      // build. Treating that as "granted" was catastrophic on a FRESH
      // INSTALL: the gate never rendered, nothing ever asked for
      // permissions, and the camera simply failed. Never infer a grant
      // from a missing answer; retry, then find out for real.
      let s = await checkNativePermissions();
      for (let i = 0; i < 5 && s === null; i++) {
        await new Promise((r) => window.setTimeout(r, 400));
        s = await checkNativePermissions();
      }
      if (s === null) {
        // no usable bridge: ask the camera itself. A refusal means we must
        // show the gate; anything else means we can proceed.
        try {
          const probe = await navigator.mediaDevices.getUserMedia({ video: true });
          for (const t of probe.getTracks()) t.stop();
          setPermState("granted");
        } catch (e) {
          const name = (e as { name?: string })?.name;
          setPermState(
            name === "NotAllowedError" || name === "SecurityError"
              ? "needed"
              : "granted"
          );
        }
        return;
      }
      setPermState(s.camera ? "granted" : "needed");
      // resume an interrupted first-run flow: camera already granted but
      // location missing (e.g. the app died between the split steps) →
      // finish the solo location request once the camera is up
      if (s.camera && !s.location) {
        window.setTimeout(() => void requestLocationPermissionNative(), 1500);
      }
    })();
  }, []);
  const permRequesting = useRef(false);
  const [permBusy, setPermBusy] = useState(false);
  const requestPermissions = useCallback(async () => {
    // SPLIT flow — camera + mic first (viewfinder comes alive), location
    // solo afterwards. Two hard-won rules encoded here:
    //  1. NEVER trust the request promise alone: fast grants can lose the
    //     plugin callback (field report: gate reappeared, needed a second
    //     tap). A state POLL runs alongside, so the UI converges on the
    //     truth no matter what happened to the callback.
    //  2. NEVER start the camera inside the result-dispatch window: fast
    //     grants crashed there. A settle delay lets the activity finish
    //     resuming before getUserMedia runs.
    if (permRequesting.current) return;
    permRequesting.current = true;
    setPermBusy(true);
    try {
      const req = ensureCameraPermissions().then(
        (s) => s === null || s.camera
      );
      const poll = (async () => {
        for (let i = 0; i < 40; i++) {
          await new Promise((r) => window.setTimeout(r, 1000));
          const s = await checkNativePermissions();
          if (s?.camera) return true;
        }
        return false;
      })();
      let granted = await Promise.race([req, poll]);
      if (!granted) {
        // request path said no (or timed out) — trust a fresh state check
        granted = (await checkNativePermissions())?.camera ?? false;
      }
      if (granted) {
        // settle: let the permission dialogs fully dismiss and the
        // activity resume before the first getUserMedia
        await new Promise((r) => window.setTimeout(r, 700));
        setPermState("granted");
        window.setTimeout(() => void requestLocationPermissionNative(), 2000);
      } else {
        setPermState("denied");
      }
    } finally {
      permRequesting.current = false;
      setPermBusy(false);
    }
  }, []);

  const pendingShots = useRef(0);
  const doCaptureRef = useRef<(() => Promise<void>) | null>(null);
  const camStarting = useRef(false);
  const startCamRef = useRef<((m?: Mode) => Promise<void>) | null>(null);
  const startCam = useCallback(async (_m?: Mode) => {
    if (camStarting.current) return;
    camStarting.current = true;
    setReady(false);
    setCamError(null);
    // Only claim the microphone when this session needs it (video mode or
    // the noise-level watermark field). In photo mode without that field,
    // other apps keep their access to the mic while our viewfinder is up.
    // Video needs the microphone. Photo mode does NOT hold it just to keep
    // a live noise reading on screen — recording audio stops other apps'
    // music on Android, and a viewfinder sitting idle has no business
    // silencing the user's music. A short reading is taken at capture
    // instead (see doCapture).
    const forMode = _m ?? modeRef.current;
    camera.audioWanted =
      forMode === "video" ||
      useSettingsStore.getState().watermark.fields.soundLevel;
    // cover the zone NOW: the old stream's element keeps its last size, so
    // without this the poll still thought the picture was live and the
    // collapsed/stale <video> showed as the white speck on every resume
    armLivePoll();
    try {
      await camera.start();
      if (videoRef.current) camera.attach(videoRef.current);
      setReady(true);
      setTorch(false);
      // fresh stream = fresh AF/exposure state
      setAfLocked(false);
      setFocusPos(null);
    } catch (e) {
      const name = (e as { name?: string })?.name;
      if (name === "NotAllowedError" || name === "SecurityError") {
        // A refusal USUALLY means the permission is not held — that is why
        // the gate reappears here (v1.12.7, where a fresh install could
        // otherwise never be granted anything). But the browser also
        // refuses transiently: a tab reopened before the previous camera
        // has been released answers NotAllowedError once and succeeds a
        // moment later. Flipping straight to the gate on that made the web
        // app demand "Enable camera" on every launch when the permission
        // was already granted. So ask the browser what it actually holds
        // before concluding anything.
        let held = false;
        try {
          const st = await navigator.permissions?.query({
            name: "camera" as PermissionName,
          });
          held = st?.state === "granted";
        } catch {
          // no Permissions API for camera — trust the error
        }
        if (held) {
          // transient: retry shortly, do not accuse the user of a denial
          window.setTimeout(() => {
            if (!camStarting.current) void startCamRef.current?.(modeRef.current);
          }, 400);
        } else {
          setPermState((p) => (p === "granted" ? "needed" : p));
        }
      } else {
        setCamError(
          "Camera unavailable. Check that permission is granted and no other app is using it."
        );
      }
    } finally {
      camStarting.current = false;
    }
  }, [armLivePoll]);
  startCamRef.current = startCam;

  // Self-heal: transient start failures (camera busy after a phone call,
  // slow HAL) retry quietly. Only runs once permissions are held, so it
  // can no longer race a permission dialog.
  useEffect(() => {
    if (!active || ready || permState !== "granted") return;
    let tries = 0;
    const t = window.setInterval(() => {
      if (tries++ >= 10) {
        window.clearInterval(t);
        return;
      }
      if (!camStarting.current) void startCam(modeRef.current);
    }, 3000);
    return () => window.clearInterval(t);
  }, [active, ready, permState, startCam]);

  useEffect(() => {
    if (permState !== "granted") return;
    void startCam(modeRef.current);
    const onVis = () => {
      if (document.hidden) {
        recorderRef.current?.stop();
        camera.stop();
        stopMeter();
        // hand the music back on the way out; stopMeter covers the meter's
        // own mic, this covers a recording's
        void nativeAudioFocus(false);
      } else {
        void startCam(modeRef.current);
      }
    };
    document.addEventListener("visibilitychange", onVis);
    // capture-quality change in Settings: restart so the new preview size
    // takes effect without the user having to leave and come back
    const onRestart = () => void startCam(modeRef.current);
    window.addEventListener("gpscam:restart-camera", onRestart);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("gpscam:restart-camera", onRestart);
      camera.stop();
    };
  }, [permState, startCam]);

  // ---- live sound meter (watermark "Sound level" field) ---------------
  const soundOn = useSettingsStore((s) => s.watermark.fields.soundLevel);
  // Only VIDEO mode meters continuously. The noise field is on by default,
  // and metering it in photo mode held the microphone for the whole
  // session — which is what stopped the user's music the moment the app
  // opened. Photo mode takes a ~0.6 s reading at capture instead
  // (sampleNoiseOnce), so the saved card still carries a level and the
  // mic is handed straight back.
  useEffect(() => {
    if (!active || !ready || !soundOn || mode !== "video") {
      stopMeter();
      return;
    }
    startMeter(camera.stream);
    return () => stopMeter();
  }, [active, ready, soundOn, mode]);

  const switchMode = useCallback(
    (m: Mode) => {
      if (m === modeRef.current || recording) return;
      // No camera restart: the shared stream keeps running, so the switch
      // is instant and torch/zoom/meter state all survive. The owner chose
      // this over matching the stock app's framing — steady video and an
      // instant switch matter more than the last 25% of width, since the
      // saved photo carries more than the viewfinder shows anyway.
      setMode(m);
    },
    [recording]
  );

  // ---- last-capture thumbnail ----------------------------------------
  useEffect(() => {
    void (async () => {
      const items = await listMedia();
      if (items[0]) {
        const t = await getBlob(items[0].id, "thumb");
        if (t) setThumbUrl(URL.createObjectURL(t));
      }
    })();
  }, []);

  const updateThumb = useCallback((_id: string, blob: Blob) => {
    setThumbUrl((old) => {
      if (old) URL.revokeObjectURL(old);
      return URL.createObjectURL(blob);
    });
  }, []);

  // ---- live watermark overlay (§4 step 2) -----------------------------
  const assetsRef = useRef<WatermarkAssets>({});
  // EXPERIMENTAL live face blur: latest detection results in video-natural
  // pixels (padded); detection runs throttled and never blocks drawing
  const liveBoxesRef = useRef<DetectedBox[]>([]);
  const detectBusyRef = useRef(false);
  const detectCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const pixelTinyRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    if (!active) return;
    let stop = false;

    void getProfilePhoto().then((p) => {
      assetsRef.current.profilePhoto = p;
    });

    let lastSig: unknown[] = [];
    const draw = () => {
      if (stop) return;
      // Pinching: the card can't change meaningfully mid-gesture, and a
      // full-canvas watermark re-render per zoom step is what made the
      // overlay stutter in the Android WebView. Skip redraws entirely
      // while two fingers are down; the gesture end triggers a fresh one.
      if (pinching.current) return;
      const canvas = overlayRef.current;
      const video = videoRef.current;
      if (!canvas || !video || video.videoWidth === 0) return;
      // Size from the BOX, never the video element: getBoundingClientRect
      // on the video includes the digital-zoom scale() transform, so the
      // card grew with every pinch and snapped back on release.
      const rect = (boxRef.current ?? video).getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = Math.round(rect.width * dpr);
      const h = Math.round(rect.height * dpr);
      const { watermark, profile, settings: s } = useSettingsStore.getState();
      const live = useLiveStore.getState();

      // Skip repaints when nothing visible changed — a full-canvas
      // watermark render several times a second is what WebViews choke
      // on. Live blur patches sample the moving video, so they always
      // repaint.
      const blurLive = s.liveFaceBlur && liveBoxesRef.current.length > 0;
      const sig: unknown[] = [
        w, h, Math.floor(Date.now() / 1000), live.db, live.fix,
        live.bearing == null ? null : Math.round(live.bearing),
        live.gpsStatus, live.address, live.lookupResult, watermark,
        profile, assetsRef.current.miniMap, assetsRef.current.profilePhoto,
        live.uiRotation,
      ];
      if (
        !blurLive &&
        sig.length === lastSig.length &&
        sig.every((v, i) => v === lastSig[i])
      ) {
        return;
      }
      lastSig = sig;

      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const data = collectWatermarkData();
      ctx.clearRect(0, 0, w, h);

      // live face blur preview: pixelate the latest detected head boxes
      if (s.liveFaceBlur && liveBoxesRef.current.length && video.videoWidth) {
        const kx = w / video.videoWidth;
        const ky = h / video.videoHeight;
        const tiny = (pixelTinyRef.current ??= document.createElement("canvas"));
        const tctx = tiny.getContext("2d");
        if (tctx) {
          for (const b of liveBoxesRef.current) {
            const cells = 9;
            tiny.width = cells;
            tiny.height = cells;
            tctx.drawImage(video, b.x, b.y, b.width, b.height, 0, 0, cells, cells);
            ctx.imageSmoothingEnabled = false;
            ctx.drawImage(
              tiny, 0, 0, cells, cells,
              b.x * kx, b.y * ky, b.width * kx, b.height * ky
            );
            ctx.imageSmoothingEnabled = true;
          }
        }
      }

      // Held landscape: rotate the drawing space the same way the icons
      // rotate (CSS --ui-rot), so the card previews upright and in its
      // true landscape layout — exactly what the capture will bake in.
      const rot = live.uiRotation;
      let cardRect: { x: number; y: number; width: number; height: number } | null = null;
      if (rot === 90 || rot === -90) {
        ctx.save();
        if (rot === 90) {
          ctx.translate(w, 0);
          ctx.rotate(Math.PI / 2);
        } else {
          ctx.translate(0, h);
          ctx.rotate(-Math.PI / 2);
        }
        cardRect = renderWatermark(
          ctx, h, w, data, watermark, profile, assetsRef.current,
          { preview: true }
        );
        ctx.restore();
      } else {
        cardRect = renderWatermark(
          ctx, w, h, data, watermark, profile, assetsRef.current,
          { preview: true }
        );
      }
      // the recording timer positions itself off the live card (never over
      // it); rects are in the ROTATED drawing space, dims in canvas px
      cardInfoRef.current = { rect: cardRect, rot, w, h };
    };

    // throttled on-device detection for the live blur preview
    const detectTick = () => {
      const video = videoRef.current;
      if (!useSettingsStore.getState().settings.liveFaceBlur) {
        liveBoxesRef.current = [];
        return;
      }
      if (detectBusyRef.current || !video || video.videoWidth === 0) return;
      detectBusyRef.current = true;
      // 512 (was 384): distant faces need more pixels to register in the
      // live preview too; still cheap enough for the 300 ms cadence
      const scale = 512 / Math.max(video.videoWidth, video.videoHeight);
      const dc = (detectCanvasRef.current ??= document.createElement("canvas"));
      dc.width = Math.max(1, Math.round(video.videoWidth * scale));
      dc.height = Math.max(1, Math.round(video.videoHeight * scale));
      dc.getContext("2d")?.drawImage(video, 0, 0, dc.width, dc.height);
      void detectFaces(dc, { thorough: false })
        .then((boxes) => {
          const inv = 1 / scale;
          liveBoxesRef.current = (boxes ?? []).map((b) => {
            const padX = b.width * 0.15;
            const padY = b.height * 0.2;
            return {
              x: Math.max(0, b.x - padX) * inv,
              y: Math.max(0, b.y - padY) * inv,
              width: (b.width + padX * 2) * inv,
              height: (b.height + padY * 2) * inv,
              score: b.score,
            };
          });
        })
        .finally(() => {
          detectBusyRef.current = false;
        });
    };

    // Refresh the cached mini-map when position/jurisdiction changes.
    const refreshMap = () => {
      const { fix, lookupResult } = useLiveStore.getState();
      const { watermark } = useSettingsStore.getState();
      if (!fix) return;
      if (watermark.fields.miniMap) {
        void renderMiniMap(fix.lat, fix.lng, lookupResult).then((m) => {
          if (m) assetsRef.current.miniMap = m;
        });
      }
      if (watermark.fields.qrCode) {
        void renderLocationQr({
          lat: fix.lat,
          lng: fix.lng,
          digipin: latLngToDigipin(fix.lat, fix.lng) ?? undefined,
        }).then(
          (q) => {
            if (q) assetsRef.current.qr = q;
          }
        );
      } else {
        assetsRef.current.qr = null;
      }
      // the Chennai plate's emblems, resolved on the same cadence so the
      // live card matches what a capture will burn
      if (watermark.preset === "chennai") {
        const { lookupResult } = useLiveStore.getState();
        const style = lookupResult?.jurisdiction
          ? signStyle({ jurisdiction: lookupResult.jurisdiction } as never)
          : null;
        const corpSlot =
          style?.leftLogo && style.leftLogo !== "gcc"
            ? style.leftLogo
            : style?.centreLogo && style.centreLogo !== "singara"
              ? style.centreLogo
              : null;
        void Promise.all([
          loadCrest(style?.leftLogo === "gcc" ? "gcc" : null),
          loadCrest(style?.centreLogo === "singara" ? "singara" : null),
          loadCrest(corpSlot),
        ]).then(([g, sg, corp]) => {
          assetsRef.current.gccEmblem = g;
          assetsRef.current.singaraLogo = sg;
          assetsRef.current.corpLogo = corp;
        });
      }
    };

    refreshMap();
    draw();
    // 300 ms keeps the watermark's seconds display ticking smoothly;
    // the mini-map refresh stays at its old 600 ms cadence
    let evenTick = false;
    const interval = window.setInterval(() => {
      evenTick = !evenTick;
      if (evenTick) refreshMap();
      // watchdog: a viewfinder that ended up paused (WebView play()
      // races) restarts itself — no tap on the overlay button needed
      const v = videoRef.current;
      if (v && v.srcObject && v.paused) void v.play().catch(() => {});
      detectTick();
      draw();
    }, 300);
    const unsubLive = useLiveStore.subscribe(draw);
    const onRedraw = () => draw();
    window.addEventListener("gpscam:redraw-overlay", onRedraw);
    const unsubSettings = useSettingsStore.subscribe(() => {
      void getProfilePhoto().then((p) => {
        assetsRef.current.profilePhoto = p;
        draw();
      });
    });
    return () => {
      stop = true;
      window.clearInterval(interval);
      window.removeEventListener("gpscam:redraw-overlay", onRedraw);
      unsubLive();
      unsubSettings();
    };
  }, [active]);

  // ---- capture ----------------------------------------------------------
  // A tiny lock around the sensor grab ONLY, so back-to-back shots are
  // limited only by how fast the camera returns a frame. All the heavy
  // work (watermark, encode, save) runs off-thread in the queue, so the
  // shutter is ready again almost immediately.
  const grabbing = useRef(false);
  const doCapture = useCallback(async () => {
    if (!ready) return;
    // BURST: a tap landing while the previous capture is still grabbing
    // used to be thrown away, so hammering the shutter silently lost half
    // the shots. Remember it instead and fire it the moment the camera is
    // free. Bounded, so a stuck finger cannot queue a hundred frames.
    if (grabbing.current) {
      if (pendingShots.current < 4) pendingShots.current += 1;
      return;
    }
    grabbing.current = true;
    hapticTap(); // confirm the shutter fired, before any of the slow work
    setFlashFx((k) => k + 1);
    // Photo mode keeps the microphone released so other apps can keep
    // playing audio. If the watermark carries a noise level, take one
    // short reading — started here, NOT awaited, so it never delays the
    // shutter; the capture pipeline reads whatever has landed by the time
    // it stamps the card.
    if (
      useSettingsStore.getState().watermark.fields.soundLevel &&
      !camera.audioWanted
    ) {
      void sampleNoiseOnce();
    }
    try {
      const { job, preview } = await grabFrame();
      if (preview) setFlyImg({ src: preview, key: Date.now() });
      enqueueCapture(
        job,
        ({ record, thumb }) => updateThumb(record.id, thumb),
        () => showToast("Couldn't save that photo. Try again")
      );
    } catch {
      showToast("Capture failed. Try again");
    } finally {
      grabbing.current = false;
      if (pendingShots.current > 0) {
        pendingShots.current -= 1;
        // let the queue drain without recursing into a deep stack
        window.setTimeout(() => void doCaptureRef.current?.(), 0);
      }
    }
  }, [ready, showToast, updateThumb]);
  doCaptureRef.current = doCapture;

  // "saving" pulse reflects the background queue depth
  useEffect(() => onPendingChange(setSaving), []);

  // ---- video record -------------------------------------------------------
  const stopRecording = useCallback(() => {
    hapticDouble(); // two pulses: stopping, distinct from starting
    recorderRef.current?.stop();
  }, []);

  const startRecording = useCallback(async () => {
    const stream = camera.stream;
    if (!stream) return;
    // A MediaStream can hold an ENDED microphone track — Android can kill it
    // when a camera session is torn down — and that records flawless video
    // with no sound at all. Nothing is recoverable afterwards, so make sure
    // the mic is live before the recorder starts.
    if (!(await camera.ensureAudio())) {
      showToast("No microphone available — this recording will be silent");
    }
    const liveVideo = videoRef.current;
    const liveBlurOn = useSettingsStore.getState().settings.liveFaceBlur;

    // The saved video must match what the viewfinder shows: the watermark
    // card (ticking clock, dB, jurisdiction) and — when enabled — face
    // blur are composited into the recorded frames, so the file on disk
    // carries them without any export step. We record that composite
    // canvas rather than the raw camera stream.
    let recStream: MediaStream = stream;
    let stopComposite: (() => void) | null = null;
    let burned = false; // blur burned in
    let watermarked = false;
    let burnW = 0;
    let burnH = 0;
    if (liveVideo && liveVideo.videoWidth) {
      try {
        // physical rotation at record START decides the file's orientation
        // for the whole clip (standard camera-app behaviour): held
        // landscape → a true landscape recording, frame + card upright
        const recRot = useLiveStore.getState().uiRotation;
        // Recording resolution comes from the device-tier plan (Settings →
        // Advanced can override): compositing full-size frames at 30 fps
        // is what stutters on low-RAM phones, so entry devices record 720p
        // while high-end ones go to 1080p+.
        const REC_LONG_EDGE = qualityPlan().recordLongEdge;
        const srcW = liveVideo.videoWidth;
        const srcH = liveVideo.videoHeight;
        const recScale = Math.min(1, REC_LONG_EDGE / Math.max(srcW, srcH));
        const vw = Math.floor((srcW * recScale) / 2) * 2;
        const vh = Math.floor((srcH * recScale) / 2) * 2;
        burnW = recRot === 0 ? vw : vh;
        burnH = recRot === 0 ? vh : vw;
        const cc = document.createElement("canvas");
        cc.width = burnW;
        cc.height = burnH;
        const cctx = cc.getContext("2d")!;
        const tiny = document.createElement("canvas");
        const tctx = tiny.getContext("2d")!;

        // watermark burned at full recording resolution, re-rendered
        // ~2×/s so the seconds and dB tick without re-rendering every
        // frame (that is what makes WebViews stutter)
        const wmCanvas = document.createElement("canvas");
        wmCanvas.width = burnW;
        wmCanvas.height = burnH;
        const wmCtx = wmCanvas.getContext("2d")!;
        const { watermark, profile } = useSettingsStore.getState();
        let lastWmTick = -1;
        // How the phone is held NOW versus at record start. The file's
        // dimensions are fixed for the whole clip (MediaRecorder cannot
        // resize mid-stream), but the card can still turn inside them —
        // and it must, because the viewfinder turns. Without this the
        // overlay rotated on screen while the recording kept the card at
        // whatever angle the clip started on.
        let wmDelta = 0;
        const deltaNow = () => {
          const cur = useLiveStore.getState().uiRotation;
          return (((cur - recRot) % 360) + 360) % 360;
        };
        const renderWm = () => {
          wmDelta = deltaNow();
          const swap = wmDelta === 90 || wmDelta === 270;
          const w = swap ? burnH : burnW;
          const h = swap ? burnW : burnH;
          if (wmCanvas.width !== w || wmCanvas.height !== h) {
            wmCanvas.width = w;
            wmCanvas.height = h;
          }
          wmCtx.clearRect(0, 0, w, h);
          renderWatermark(
            wmCtx,
            w,
            h,
            collectWatermarkData(),
            watermark,
            profile,
            assetsRef.current
          );
        };
        renderWm();

        let rafId = 0;
        let compositeDone = false;
        // true once at least one real camera frame has been composited, so
        // a gap can hold that frame instead of writing black
        let lastGoodFrame = false;
        const paint = () => {
          if (compositeDone) return;
          // frame + blur draw in the camera's own (portrait) pixel space;
          // when recording landscape the whole space is rotated upright
          // first, then the (already landscape) watermark goes on top
          cctx.save();
          if (recRot === 90) {
            cctx.translate(0, cc.height);
            cctx.rotate(-Math.PI / 2);
          } else if (recRot === -90) {
            cctx.translate(cc.width, 0);
            cctx.rotate(Math.PI / 2);
          }
          // While a lens switch has the camera closed the <video> has no
          // frame, and painting it burned a black stretch into the saved
          // recording. Hold the previous composited frame instead — the
          // canvas already contains it, so simply skip this paint.
          if (!liveVideo.videoWidth || liveVideo.readyState < 2) {
            if (lastGoodFrame) {
              cctx.restore(); // balance the save() above
              return;
            }
          }
          // match digital zoom by cropping the centre of the frame
          const dz = camera.captureZoom;
          if (dz > 1) {
            const sw = liveVideo.videoWidth / dz;
            const sh = liveVideo.videoHeight / dz;
            cctx.drawImage(
              liveVideo,
              (liveVideo.videoWidth - sw) / 2,
              (liveVideo.videoHeight - sh) / 2,
              sw, sh, 0, 0, vw, vh
            );
          } else {
            cctx.drawImage(liveVideo, 0, 0, vw, vh);
          }
          lastGoodFrame = true;
          if (liveBlurOn) {
            for (const b of liveBoxesRef.current) {
              const cells = 9;
              tiny.width = cells;
              tiny.height = cells;
              // sample from the FULL-res video, paint into the (possibly
              // downscaled) composite space — recScale keeps the mosaic
              // aligned with the face when the two differ
              tctx.drawImage(liveVideo, b.x, b.y, b.width, b.height, 0, 0, cells, cells);
              cctx.imageSmoothingEnabled = false;
              cctx.drawImage(
                tiny,
                0, 0, cells, cells,
                b.x * recScale, b.y * recScale,
                b.width * recScale, b.height * recScale
              );
              cctx.imageSmoothingEnabled = true;
            }
          }
          cctx.restore();
          const wmTick = Math.floor(Date.now() / 500);
          // re-render on the clock tick, and immediately when the phone
          // turns — waiting up to half a second to follow a flip reads as
          // the card being stuck
          if (wmTick !== lastWmTick || deltaNow() !== wmDelta) {
            lastWmTick = wmTick;
            renderWm();
          }
          cctx.save();
          if (wmDelta === 90) {
            cctx.translate(cc.width, 0);
            cctx.rotate(Math.PI / 2);
          } else if (wmDelta === 270) {
            cctx.translate(0, cc.height);
            cctx.rotate(-Math.PI / 2);
          } else if (wmDelta === 180) {
            cctx.translate(cc.width, cc.height);
            cctx.rotate(Math.PI);
          }
          cctx.drawImage(wmCanvas, 0, 0);
          cctx.restore();
        };
        // Drive compositing on a steady requestAnimationFrame clock, NOT
        // the video's requestVideoFrameCallback. rVFC stops firing the
        // moment the source <video> briefly stops *presenting* frames
        // (which happens even while the camera is still delivering them,
        // notably in desktop/mobile web near the end of a clip) — the
        // canvas then froze and captureStream kept emitting that frozen
        // frame, so the recording's last seconds were a freeze-frame over
        // live audio. rAF keeps pulling the current live frame every tick,
        // throttled to ~30 fps to match the capture rate, so the tail
        // never freezes. (The Android WebView didn't hit the rVFC stall,
        // which is why it looked fine there.)
        let lastPaintTs = 0;
        const loop = (ts: number) => {
          if (compositeDone) return;
          if (ts - lastPaintTs >= 1000 / 30 - 1) {
            lastPaintTs = ts;
            paint();
          }
          rafId = requestAnimationFrame(loop);
        };
        paint();
        rafId = requestAnimationFrame(loop);
        const tracks = [
          ...cc.captureStream(30).getVideoTracks(),
          ...stream.getAudioTracks(),
        ];
        recStream = new MediaStream(tracks);
        stopComposite = () => {
          compositeDone = true;
          cancelAnimationFrame(rafId);
        };
        burned = liveBlurOn;
        watermarked = true;
      } catch {
        // compositing unavailable — record the raw stream as before
        recStream = stream;
        burned = false;
        watermarked = false;
      }
    }

    // MP4 preferred where supported: phone galleries read its duration
    // and GPS metadata, and editors accept it (webm often reads as
    // "corrupted or unsupported" outside the browser)
    let mimeType = pickRecordingMime();
    let rec: MediaRecorder;
    // canvas captureStream defaults to a low bitrate — keep the
    // composited recording at camera-like quality
    const recOpts = watermarked
      ? { videoBitsPerSecond: qualityPlan().videoBitsPerSecond }
      : {};
    try {
      rec = new MediaRecorder(
        recStream,
        mimeType ? { mimeType, ...recOpts } : recOpts
      );
    } catch {
      // some devices accept the mp4 type probe but fail with this track
      // combination — fall back to webm
      mimeType = "video/webm";
      rec = new MediaRecorder(recStream, { mimeType, ...recOpts });
    }
    recChunksRef.current = [];
    rec.ondataavailable = (e) => {
      if (e.data.size) recChunksRef.current.push(e.data);
    };
    rec.onstop = () => {
      setRecording(false);
      stopComposite?.();
      const duration = (Date.now() - recStartRef.current) / 1000;
      const rawBlob = new Blob(recChunksRef.current, {
        type: mimeType || "video/webm",
      });
      recChunksRef.current = [];
      void (async () => {
        const video = videoRef.current;
        const track = camera.track;
        const s = track?.getSettings();
        const data = collectWatermarkData();
        const { watermark: wmConfig, settings: appSettings } =
          useSettingsStore.getState();
        // address not resolved yet (offline or geocoder still working) —
        // queue it so a later export carries the full watermark
        const needsBackfill =
          Boolean(data.fix) &&
          appSettings.geocoder !== "off" &&
          wmConfig.fields.address &&
          !data.address;
        const record: VideoRecord = {
          id: newId(),
          kind: "video",
          createdAt: recStartRef.current,
          duration,
          width: watermarked ? burnW : (s?.width ?? video?.videoWidth ?? 0),
          height: watermarked ? burnH : (s?.height ?? video?.videoHeight ?? 0),
          mimeType: rawBlob.type,
          data,
          config: wmConfig,
          liveBlur: liveBlurOn || undefined,
          blurBurned: burned || undefined,
          watermarkBurned: watermarked || undefined,
          backfill: needsBackfill ? "pending" : "not-needed",
        };
        // container fixes: GPS atom for MP4, duration header for webm —
        // so the file is a proper geotagged video outside this app too
        const blob = await finalizeVideoBlob(
          rawBlob,
          duration * 1000,
          record.data.fix
        );
        await putBlob(record.id, "source", blob);
        let thumb: Blob | null = null;
        if (video && video.videoWidth) {
          try {
            thumb = await makeThumbnail(video, video.videoWidth, video.videoHeight);
            await putBlob(record.id, "thumb", thumb);
          } catch {
            // no thumb — gallery shows a placeholder
          }
        }
        await putMedia(record);
        if (needsBackfill) scheduleBackfill();
        if (thumb) updateThumb(record.id, thumb);
        // auto-save to device, same as photos
        if (useSettingsStore.getState().settings.autoSaveToDevice || isNativeApp()) {
          try {
            downloadBlob(
              blob,
              suggestedName("video", record.createdAt, blob.type)
            );
          } catch {
            // download blocked — in-app copy is already saved
          }
        }
      })();
    };
    recStartRef.current = Date.now();
    hapticTap(); // recording is starting
    rec.start(1000);
    recorderRef.current = rec;
    setRecording(true);
    setRecSeconds(0);
  }, [updateThumb, showToast]);

  useEffect(() => {
    if (!recording) return;
    const t = window.setInterval(
      () => setRecSeconds(Math.floor((Date.now() - recStartRef.current) / 1000)),
      500
    );
    return () => window.clearInterval(t);
  }, [recording]);

  const onShutter = useCallback(() => {
    if (mode === "photo") void doCapture();
    else if (recording) stopRecording();
    else void startRecording();
  }, [mode, recording, doCapture, startRecording, stopRecording]);

  // Desktop convenience: space/enter as shutter.
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.code === "Space" || e.code === "Enter") {
        const tag = (e.target as HTMLElement)?.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "BUTTON") return;
        e.preventDefault();
        onShutter();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, onShutter]);

  // Coming back to the camera (from the gallery or the background):
  // - the element can be left paused by display:none (shows the WebView's
  //   play overlay), so play it;
  //  - the WebView may have killed the camera track while it was hidden —
  //   restart if so, which also re-applies the remembered zoom;
  // - and whatever happened, make the chips read what the controller is
  //   actually doing, so the label can never disagree with the picture.
  useEffect(() => {
    if (!active) return;
    const v = videoRef.current;
    if (v && v.srcObject && v.paused) void v.play().catch(() => {});
    const track = camera.stream?.getVideoTracks()[0];
    if (ready && permState === "granted" && (!track || track.readyState !== "live")) {
      void startCam(modeRef.current);
    }
    setZoomNow(camera.zoom);
    setZoomStops(camera.zoomStops());
  }, [active, ready, permState, startCam]);

  // give the controller the canvas it holds the last frame on during a
  // lens switch
  useEffect(() => {
    camera.setFreezeSurface(freezeRef.current);
    return () => camera.setFreezeSurface(null);
  }, []);

  // calibration finished renaming a lens (.6x vs .5x, 3x vs 5x): refresh
  // the stop chips so they read what this phone actually has
  useEffect(() => {
    const onLenses = () => setZoomStops(camera.zoomStops());
    window.addEventListener("gpscam:lenses-updated", onLenses);
    return () => window.removeEventListener("gpscam:lenses-updated", onLenses);
  }, []);

  // Android app: volume buttons fire the shutter (MainActivity intercepts
  // the key events and relays them as this window event). Debounced so
  // key auto-repeat can't machine-gun the camera.
  useEffect(() => {
    if (!active) return;
    let last = 0;
    const onVolumeShutter = () => {
      const now = Date.now();
      if (now - last < 350) return;
      last = now;
      onShutter();
    };
    window.addEventListener("gpscamShutterKey", onVolumeShutter);
    // Claim the rocker only while the viewfinder is actually up. Holding it
    // app-wide meant the gallery couldn't set playback volume on a video.
    void setShutterKeys(true);
    return () => {
      window.removeEventListener("gpscamShutterKey", onVolumeShutter);
      void setShutterKeys(false);
    };
  }, [active, onShutter]);

  // the stream restarted (minimise/restore) and the controller put the zoom
  // back: follow it, so the chips and the indicator match the picture
  useEffect(() => {
    const onZoom = (e: Event) => {
      const z = (e as CustomEvent<{ zoom: number }>).detail?.zoom;
      if (typeof z !== "number") return;
      setZoomNow(z);
      setZoomStops(camera.zoomStops());
    };
    window.addEventListener("gpscam:zoom-changed", onZoom);
    return () => window.removeEventListener("gpscam:zoom-changed", onZoom);
  }, []);

  /**
   * Dynamic placement for the recording timer pill and the free-floating
   * zoom chips, from the live card rect, in BOTH orientations:
   * - portrait: pill top-left ON THE FLASH/SETTINGS LINE (not up against
   *   the status bar); chips just above the card. Card anchored top-left
   *   instead: pill drops below the card, chips below the pill.
   * - landscape: pill directly below the card (above it when the card hugs
   *   the rotated bottom edge); chips on the OPPOSITE side of the card, so
   *   pill, chips and card can never cover each other.
   */
  const [toastPos, setToastPos] = useState<{ left: number; top: number } | null>(null);
  useEffect(() => {
    const wantToast = !!toast || !!zoomLabel || (afLocked && afChip);
    if (!recording && !wantToast) {
      setRecPos(null);
      setToastPos(null);
      return;
    }
    const tick = () => {
      const info = cardInfoRef.current;
      const canvas = overlayRef.current;
      const vp = viewportRef.current;
      if (!info || !canvas || !vp) return;
      const cr = canvas.getBoundingClientRect();
      const br = vp.getBoundingClientRect();
      if (!cr.width || !info.w) return;
      const kx = cr.width / info.w;
      const ky = cr.height / info.h;
      const { rect, rot, w, h } = info;
      const landscape = rot === 90 || rot === -90;
      const rotH = landscape ? w : h;
      const gap = 8 / ky;
      const M = 12 / kx;
      const PILL_H = 34 / ky;
      const toScreen = (u: number, v: number) => {
        let x = u;
        let y = v;
        if (rot === 90) {
          x = w - v;
          y = u;
        } else if (rot === -90) {
          x = v;
          y = h - u;
        }
        return {
          left: cr.left - br.left + x * kx,
          top: cr.top - br.top + y * ky,
        };
      };
      const cardIsTop = !!rect && rect.y < rotH / 2;

      // ---- recording pill ----
      if (recording) {
        let pill: { left: number; top: number };
        const PILL_W = 88 / kx; // canvas px, generous "00:00" + dot
        if (!landscape) {
          // portrait home: ON the flash/settings line, left edge — used
          // unless the card actually covers that spot
          const icon = document.querySelector(".cam-top button");
          const ir = icon?.getBoundingClientRect();
          const homeTop = ir ? ir.top + ir.height / 2 - 17 - br.top : 12;
          const cardCovers =
            !!rect &&
            rect.y * ky + (cr.top - br.top) < homeTop + 34 &&
            rect.x * kx + (cr.left - br.left) < 12 + 96;
          if (!cardCovers) {
            pill = { left: 12, top: homeTop };
          } else if (rect) {
            pill = toScreen(rect.x, rect.y + rect.height + gap);
          } else {
            pill = { left: 12, top: 12 };
          }
        } else {
          // landscape: centred at the TOP of the rotated view (the line
          // the social strip runs along); when the user anchors the card
          // at the top, take the opposite edge — the bottom — instead
          const rotW = w === rotH ? h : w; // width of the rotated space
          const u = Math.max(M, (rotW - PILL_W) / 2);
          const v = cardIsTop ? rotH - M - PILL_H : M;
          pill = toScreen(u, v);
        }
        setRecPos((p) =>
          p && Math.abs(p.left - pill.left) < 2 && Math.abs(p.top - pill.top) < 2
            ? p
            : pill
        );
      }

      // ---- messages ----
      // Always on the edge OPPOSITE the watermark card, centred along it,
      // and below the recording pill when that shares the edge. In
      // landscape this puts them above the focus ring, upright with the
      // rest of the rotated UI — they used to stay horizontal at the
      // bottom, on top of the card.
      {
        const TOAST_H = 44 / ky;
        const rotW = landscape ? h : w;
        const atTop = !rect || !cardIsTop; // card at the bottom (or none)
        // The CENTRE of the notice, in rotated space — the element then
        // centres itself on it with translate(-50%, -50%), so chips and
        // messages of different widths all sit in the same place. Anchoring
        // by top-left is what threw the "AF locked" chip off-centre.
        let v = atTop ? M + TOAST_H : rotH - M - TOAST_H / 2;
        // the recording pill owns the very top edge: sit under it
        if (recording && atTop) v += PILL_H + gap;
        const t2 = toScreen(rotW / 2, v);
        setToastPos((p) =>
          p && Math.abs(p.left - t2.left) < 3 && Math.abs(p.top - t2.top) < 3
            ? p
            : t2
        );
      }
    };
    // drop the stale position the moment orientation changes, so the pill
    // vanishes for a frame instead of flashing at its previous corner
    setRecPos(null);
    tick();
    const t = window.setInterval(tick, 400);
    return () => window.clearInterval(t);
  }, [recording, focusPos, uiRot, toast, zoomLabel, afLocked, afChip]);

  // Acquire or release the microphone as the need changes, without
  // restarting the camera: entering video mode needs it, going back to
  // photo (with the noise field off) hands it back to other apps.
  useEffect(() => {
    if (!active || !ready) return;
    // NOT `|| soundOn`: the noise field defaults on, so that clause meant
    // the microphone was held from the moment the viewfinder appeared
    const need = mode === "video";
    camera.audioWanted = need;
    if (need) void camera.ensureAudio();
    else camera.releaseAudio();
  }, [active, ready, mode, soundOn]);

  // an AF lock does not survive the track it was applied to (a lens switch
  // opens a new one), so drop the padlock rather than show a dead one
  useEffect(() => {
    const onTrack = () => {
      setAfLocked(false);
      setTorch(false);
      armLivePoll();
      // the meter was listening to the previous stream's audio track
      const wantsMeter =
        useSettingsStore.getState().watermark.fields.soundLevel;
      if (wantsMeter && camera.stream) {
        stopMeter();
        startMeter(camera.stream);
      }
    };
    window.addEventListener("gpscam:track-changed", onTrack);
    return () => {
      window.removeEventListener("gpscam:track-changed", onTrack);
    };
  }, [armLivePoll]);

  // ---- gestures: tap-to-focus + pinch-to-zoom -----------------------------
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinchBase = useRef<{ dist: number; zoom: number } | null>(null);

  // A tap that starts on a control (flash, settings, zoom pills, …)
  // must not trigger tap-to-focus.
  const onControl = (target: EventTarget | null) =>
    Boolean(
      (target as HTMLElement | null)?.closest(
        "button, a, input, select, .cam-top, .cam-zoombar, .cam-controls"
      )
    );

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    if (onControl(e.target)) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      pinchBase.current = {
        dist: Math.hypot(a.x - b.x, a.y - b.y),
        zoom: camera.zoom,
      };
    }
    // a second finger = pinch, never a focus tap: hide any focus UI that
    // a first-finger tap may have just shown (it must not appear during
    // zooming) and cancel the pending tap
    if (pointers.current.size >= 2) {
      pinching.current = true;
      tapCandidate.current = null;
      window.clearTimeout(focusHideTimer.current);
      setFocusPos(null);
    } else {
      tapCandidate.current = { x: e.clientX, y: e.clientY };
    }
  }, []);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    // real movement means a drag/pinch, not a tap
    const tc = tapCandidate.current;
    if (tc && Math.hypot(e.clientX - tc.x, e.clientY - tc.y) > 10) {
      tapCandidate.current = null;
    }
    if (pointers.current.size === 2 && pinchBase.current) {
      const [a, b] = [...pointers.current.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const target = pinchBase.current.zoom * (dist / pinchBase.current.dist);
      // Throttle the zoom applications themselves: every setZoom triggers
      // a constraint apply (and a store write via the label), and in the
      // Android WebView that firehose is what made the watermark overlay
      // stutter during a pinch. ~60 ms is imperceptible to the gesture.
      const now = performance.now();
      if (now - lastZoomApply.current < 60) return;
      lastZoomApply.current = now;
      void camera.setZoom(target).then((z) => {
        setZoomLabel(fmtZoom(z));
        setZoomNow(z);
        showZoomBar();
      });
    }
  }, []);

  const onPointerUp = useCallback(
    (e: React.PointerEvent) => {
      const start = pointers.current.get(e.pointerId);
      pointers.current.delete(e.pointerId);
      if (pointers.current.size < 2) pinchBase.current = null;
      if (pointers.current.size === 0) {
        // a pinch just ended: swallow this release entirely so no focus
        // ring/slider pops up after zooming
        if (pinching.current) {
          pinching.current = false;
          tapCandidate.current = null;
          // repaint the overlay now that redraws are unblocked
          window.dispatchEvent(new Event("gpscam:redraw-overlay"));
          window.setTimeout(() => setZoomLabel(null), 1200);
          return;
        }
        if (start && tapCandidate.current) {
          const dx = e.clientX - start.x;
          const dy = e.clientY - start.y;
          if (Math.hypot(dx, dy) < 8) {
            // single tap = focus here (and drop any existing AF lock)
            if (afLocked) {
              setAfLocked(false);
              void camera.unlockFocus();
            }
            showFocusUi(e.clientX, e.clientY);
            // aim the camera at the tapped point, not just anywhere: the
            // video's rect already includes the digital-zoom transform, so
            // this maps the tap straight into frame coordinates
            const vr = videoRef.current?.getBoundingClientRect();
            let point: { x: number; y: number } | undefined;
            if (vr && vr.width > 0 && vr.height > 0) {
              let nx = (e.clientX - vr.left) / vr.width;
              const ny = (e.clientY - vr.top) / vr.height;
              if (camera.facing === "user") nx = 1 - nx; // preview is mirrored
              point = { x: nx, y: ny };
            }
            void camera.focusAt(point);
          }
        }
        tapCandidate.current = null;
      }
      window.setTimeout(() => setZoomLabel(null), 1200);
    },
    [afLocked, showFocusUi]
  );

  const toggleTorch = useCallback(async () => {
    const ok = await camera.setTorch(!torch);
    if (ok) setTorch(!torch);
    else showToast("Flash not available on this camera");
  }, [torch, showToast]);

  const flipCamera = useCallback(async () => {
    camera.facing = camera.facing === "environment" ? "user" : "environment";
    await startCam(modeRef.current);
  }, [startCam]);

  const mirrored = camera.facing === "user";
  const fmtRec = (s: number) =>
    `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;

  return (
    <div
      className="cam-screen"
      style={
        {
          visibility: active ? "visible" : "hidden",
          // display:none, not just hidden. The live viewfinder is a
          // hardware-composited video layer in the Android WebView, and
          // leaving it in the render tree behind the gallery made every
          // open/close of a photo flicker. `visibility` keeps compositing;
          // `display` removes it. The stream itself keeps running, so
          // coming back is still instant.
          display: active ? undefined : "none",
          "--ui-rot": `${uiRot}deg`,
        } as React.CSSProperties
      }
    >
      {/* Viewfinder zone — the live watermark card anchors to the bottom
          of the video box, which ends ABOVE the opaque controls bar, so
          nothing ever covers it (GPS-Map-Camera-style layout). */}
      <div
        ref={viewportRef}
        className="cam-viewport"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        style={{ touchAction: "none" }}
      >
        <div
          ref={boxRef}
          className={`cam-video-box${mirrored ? " mirrored" : ""}`}
          data-live={videoLive}
          // long-pressing a live preview must not open the WebView's media
          // context menu (downloadfile.bin / Copy video frame / PiP)
          onContextMenu={(e) => e.preventDefault()}
        >
          {/* Black poster: a paused WebView <video> shows the play-button
              overlay only when it has NO poster. With one, the pre-stream
              gap and every mode switch render as a black frame instead. */}
          <video
            ref={videoRef}
            playsInline
            muted
            autoPlay
            poster={BLACK_POSTER}
            onLoadedData={(e) => {
              // same bar as the poll: 2 px junk streams must not count
              if (e.currentTarget.videoWidth >= 32) setVideoLive(true);
            }}
            onEmptied={() => setVideoLive(false)}
          />
          {/* Holds the last frame while a lens switch releases one camera
              and opens another, so crossing 0.6x→1x fades instead of
              flashing black. */}
          <canvas ref={freezeRef} className="cam-freeze" />
          {settings.gridLines && (
            <div
              className="cam-grid"
              style={{
                backgroundImage:
                  "linear-gradient(to right, rgba(255,255,255,0.3) 1px, transparent 1px)," +
                  "linear-gradient(to bottom, rgba(255,255,255,0.3) 1px, transparent 1px)",
                backgroundSize: "33.4% 33.4%",
                backgroundPosition: "-1px -1px",
              }}
            />
          )}
          <canvas ref={overlayRef} className="cam-overlay" />
          {/* Lens stops, OVER the picture: living in the controls strip
                resized that strip as they came and went, so the viewfinder
                kept growing and shrinking. With a focus group on screen
                they ride along underneath it instead (see below). */}

        </div>

        {/* Black fill over the whole viewfinder zone until the stream
            paints. Must sit outside .cam-video-box: that box is sized by
            the <video>, so it has no size to fill before the first frame. */}
        {!videoLive && permState === "granted" && <div className="cam-prefill" />}

        {(permState === "needed" || permState === "denied") && (
          <div
            className="empty-note"
            style={{ position: "absolute", inset: "26% 24px auto", zIndex: 9 }}
          >
            <Camera size={34} style={{ opacity: 0.8 }} />
            <div style={{ marginTop: 10, fontWeight: 600 }}>
              Camera &amp; location access
            </div>
            <div style={{ marginTop: 8, fontSize: 13, lineHeight: 1.5 }}>
              Photos are stamped with your location entirely on this phone —
              nothing is uploaded anywhere.
            </div>
            {permState === "denied" && (
              <div style={{ marginTop: 8, fontSize: 13, color: "var(--danger, #f87171)" }}>
                Permission was declined. Enable Camera and Microphone for
                this app in your phone&apos;s Settings, then try again.
              </div>
            )}
            <div style={{ marginTop: 16 }}>
              <button
                className="primary-btn"
                disabled={permBusy}
                onClick={() => void requestPermissions()}
              >
                {permBusy
                  ? "Waiting for permission…"
                  : permState === "denied"
                    ? "Try again"
                    : "Enable camera"}
              </button>
            </div>
          </div>
        )}

        {camError && permState === "granted" && (
          <div
            className="empty-note"
            style={{ position: "absolute", inset: "30% 20px auto", zIndex: 9 }}
          >
            {camError}
            <div style={{ marginTop: 16 }}>
              <button className="primary-btn" onClick={() => void startCam(mode)}>
                Retry
              </button>
            </div>
          </div>
        )}

        {/* Top-right cluster is exactly [flash][settings]; the grid toggle
            lives in Settings and the Chennai coverage chip is retired
            (pan-India expansion planned). */}
        <div className="cam-top">
          <span />
          <div className="cluster">
            <button
              className="cam-round"
              data-active={torch}
              onClick={() => void toggleTorch()}
              aria-label="Flash"
            >
              <Zap size={19} fill={torch ? "currentColor" : "none"} />
            </button>
            <button
              className="cam-round"
              onClick={() => navigate("/settings")}
              aria-label="Settings"
            >
              <Settings size={19} />
            </button>
          </div>
        </div>

        {iosHint && (
          <div className="ios-a2hs-hint">
            <span>
              Tired of re-granting permissions each visit? Add this app to
              your Home Screen (Share&nbsp;→&nbsp;Add to Home Screen) — the
              installed app remembers them.
            </span>
            <button
              aria-label="Dismiss"
              onClick={() => {
                localStorage.setItem("gpscam-ios-a2hs", "1");
                setIosHint(false);
              }}
            >
              ✕
            </button>
          </div>
        )}

        {zoomLabel && !toast && (
          <div
            className="cam-toast"
            style={
              (toastPos
                ? {
                    left: toastPos.left,
                    top: toastPos.top,
                    bottom: "auto",
                    transform: `translate(-50%, -50%) rotate(${uiRot}deg)`,
                  }
                : { bottom: "auto", top: "12%" }) as React.CSSProperties
            }
          >
            {zoomLabel}
          </div>
        )}
        {toast && (
          <div
            className="cam-toast"
            style={
              (toastPos
                ? {
                    left: toastPos.left,
                    top: toastPos.top,
                    bottom: "auto",
                    transform: `translate(-50%, -50%) rotate(${uiRot}deg)`,
                  }
                : { bottom: "auto", top: "12%" }) as React.CSSProperties
            }
          >
            {toast}
          </div>
        )}
        {recording && recPos && (
          <div
            className="rec-timer"
            style={
              {
                left: recPos.left,
                top: recPos.top,
                "--ui-rot": `${uiRot}deg`,
              } as React.CSSProperties
            }
          >
            {fmtRec(recSeconds)}
          </div>
        )}

      </div>

      <div key={flashFx} className={`flash-fx${flashFx ? " animate" : ""}`} />
      {flyImg && (
        <img
          key={flyImg.key}
          className="capture-fly"
          src={flyImg.src}
          alt=""
          onAnimationEnd={() => setFlyImg(null)}
        />
      )}
      {/* Samsung-style focus UI: compact square-ish ring, a tappable
          padlock above it (tap to lock/unlock — the icon closes when
          locked), and a thin exposure slider beside it. */}
      {focusPos && (
        <div
          className="focus-ui"
          style={
            {
              left: focusPos.x,
              top: focusPos.y,
              "--ui-rot": `${uiRot}deg`,
            } as React.CSSProperties
          }
        >
          <div
            key={focusPos.key}
            className={`focus-ring hold${afLocked ? " locked" : ""}`}
          />
          <button
            className={`focus-lock-btn${afLocked ? " on" : ""}`}
            aria-label={afLocked ? "Unlock focus" : "Lock focus"}
            onPointerDown={(e) => e.stopPropagation()}
            onPointerUp={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              keepFocusUi();
              if (afLocked) {
                setAfLocked(false);
                void camera.unlockFocus();
              } else {
                void camera.lockFocus().then((ok) => {
                  if (ok) {
                    setAfLocked(true);
                    flashAfChip();
                  }
                  else showToast("Couldn't hold focus — try again");
                });
              }
            }}
          >
            {afLocked ? <Lock size={12} /> : <LockOpen size={12} />}
          </button>
          {evInfo && (
            <div
              className="ev-slider"
              // 0 at the far left, 1 at the far right, 0.5 in the middle:
              // the sun grows and brightens as it travels right, so the
              // control shows what it does before you let go
              style={
                {
                  "--ev-t":
                    evInfo.max > evInfo.min
                      ? (evVal - evInfo.min) / (evInfo.max - evInfo.min)
                      : 0.5,
                } as React.CSSProperties
              }
              onPointerDown={(e) => {
                e.stopPropagation();
                (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
                evDragging.current = true;
                applyEvFromPointer(e.clientX, e.clientY, e.currentTarget);
              }}
              onPointerMove={(e) => {
                e.stopPropagation();
                if (evDragging.current)
                  applyEvFromPointer(e.clientX, e.clientY, e.currentTarget);
              }}
              onPointerUp={(e) => {
                e.stopPropagation();
                evDragging.current = false;
              }}
              onPointerCancel={() => {
                evDragging.current = false;
              }}
            >
              {/* The native range input is display-only here. Its value is
                  computed by the browser from the pointer's X in the
                  element's UNROTATED box, so once the focus cluster rotates
                  for landscape, dragging it became unusable. The pointer is
                  projected onto the slider's real (rotated) axis instead —
                  see applyEvFromPointer — and this input just renders the
                  track and the sun. */}
              <input
                type="range"
                min={evInfo.min}
                max={evInfo.max}
                step={evInfo.step}
                value={evVal}
                readOnly
                tabIndex={-1}
                style={{ pointerEvents: "none" }}
              />
            </div>
          )}

        </div>
      )}

      {afLocked && afChip && !focusPos && (
        <button
          className="af-chip"
          style={
            (toastPos
              ? {
                  left: toastPos.left,
                  top: toastPos.top,
                  transform: `translate(-50%, -50%) rotate(${uiRot}deg)`,
                }
              : {}) as React.CSSProperties
          }
          onClick={() => {
            setAfLocked(false);
            void camera.unlockFocus();
          }}
        >
          <Lock size={12} /> AF locked
        </button>
      )}

      {/* Opaque controls bar — below the viewfinder, never over it. */}
      <div className="cam-controls">
        {/* Lens stops live HERE, not over the picture: always visible,
            never covering the watermark, and small enough to leave the
            viewfinder clean. Pinching updates which one is highlighted. */}
        {zoomStops.length > 1 && (
          <div className="cam-zoomrow">
            {zoomStops.map((z) => (
              <button
                key={z}
                data-active={Math.abs(z - zoomNow) < 0.05}
                disabled={recording && false}
                onClick={() => {
                  void camera.setZoom(z).then((got) => {
                    setZoomNow(got);
                    if (Math.abs(got - z) > 0.05 && camera.lensUnavailable) {
                      showToast("This phone doesn't let apps use that lens directly");
                    }
                  });
                }}
              >
                {fmtZoom(z)}
              </button>
            ))}
          </div>
        )}
        <div className="cam-mode">
          <button
            data-active={mode === "photo"}
            disabled={recording}
            onClick={() => switchMode("photo")}
          >
            PHOTO
          </button>
          <button
            data-active={mode === "video"}
            disabled={recording}
            onClick={() => switchMode("video")}
          >
            VIDEO
          </button>
        </div>
        <div className="cam-actions">
          <button
            className={`thumb-btn${saving > 0 ? " saving" : ""}`}
            onClick={() => navigate("/gallery")}
            aria-label="Gallery"
          >
            {thumbUrl ? <img src={thumbUrl} alt="" /> : <Images size={20} />}
          </button>
          <button
            className={`shutter${mode === "video" ? (recording ? " recording" : " video") : ""}`}
            onClick={onShutter}
            aria-label={mode === "photo" ? "Take photo" : "Record"}
          />
          <button
            className="thumb-btn"
            onClick={() => void flipCamera()}
            aria-label="Switch camera"
          >
            <SwitchCamera size={20} />
          </button>
        </div>
      </div>
    </div>
  );
}
