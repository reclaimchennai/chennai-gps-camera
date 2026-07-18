import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { camera } from "../lib/camera";
import { startMeter, stopMeter } from "../lib/audio/meter";
import { scheduleBackfill } from "../lib/backfill";
import { capturePhoto, collectWatermarkData, getProfilePhoto } from "../lib/capture";
import { renderWatermark, type WatermarkAssets } from "../lib/watermark/render";
import { renderMiniMap } from "../lib/watermark/minimap";
import { playShutter } from "../lib/sound";
import { useLiveStore, useSettingsStore } from "../store";
import { isNativeApp } from "../lib/native";
import { navigate } from "../nav";
import { listMedia, getBlob, newId, putBlob, putMedia } from "../lib/db";
import { makeThumbnail } from "../lib/img";
import { detectFaces, type DetectedBox } from "../lib/detect/faces";
import { pickRecordingMime, finalizeVideoBlob } from "../lib/video/postprocess";
import { downloadBlob, suggestedName } from "../lib/share";
import type { VideoRecord } from "../types";
import { Zap, SwitchCamera, Settings, Images } from "lucide-react";

type Mode = "photo" | "video";

// 1×1 black PNG — used as the viewfinder <video> poster so the
// pre-stream gap renders dark instead of the UA play-button overlay.
const BLACK_POSTER =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC";

export default function CameraView({ active }: { active: boolean }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
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
      box.style.setProperty("--vph", `${vp.clientHeight}px`);
      box.style.setProperty("--vpw", `${vp.clientWidth}px`);
    };
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(vp);
    return () => ro.disconnect();
  }, []);
  const [mode, setMode] = useState<Mode>("photo");
  const [ready, setReady] = useState(false);
  const [camError, setCamError] = useState<string | null>(null);
  const [torch, setTorch] = useState(false);
  const [zoomLabel, setZoomLabel] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [zoomStops, setZoomStops] = useState<number[]>([]);
  const [thumbUrl, setThumbUrl] = useState<string | null>(null);
  const [flashFx, setFlashFx] = useState(0);
  const [focusPos, setFocusPos] = useState<{ x: number; y: number; key: number } | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [recSeconds, setRecSeconds] = useState(0);
  const [busy, setBusy] = useState(false);
  // capture-in-flight UX: a preview that flies into the gallery button
  // and a pulse on the button while the real file finishes saving
  const [flyImg, setFlyImg] = useState<{ src: string; key: number } | null>(null);
  const [saving, setSaving] = useState(0);

  const settings = useSettingsStore((s) => s.settings);

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
  const startCam = useCallback(async (_m?: Mode) => {
    setReady(false);
    setCamError(null);
    try {
      await camera.start();
      if (videoRef.current) camera.attach(videoRef.current);
      setReady(true);
      setTorch(false);
      setZoom(1);
      // some devices populate track capabilities a beat after start
      window.setTimeout(() => setZoomStops(camera.zoomStops()), 300);
    } catch {
      setCamError(
        "Camera unavailable. Check that permission is granted and no other app is using it."
      );
    }
  }, []);

  useEffect(() => {
    void startCam(modeRef.current);
    const onVis = () => {
      if (document.hidden) {
        recorderRef.current?.stop();
        camera.stop();
        stopMeter();
      } else {
        void startCam(modeRef.current);
      }
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      camera.stop();
    };
  }, [startCam]);

  // ---- live sound meter (watermark "Sound level" field) ---------------
  const soundOn = useSettingsStore((s) => s.watermark.fields.soundLevel);
  useEffect(() => {
    if (!active || !ready || !soundOn) {
      stopMeter();
      return;
    }
    // the shared camera stream always carries the (unprocessed) mic
    // track — one meter attach, stable across photo/video switches
    startMeter(camera.stream);
    return () => stopMeter();
  }, [active, ready, soundOn]);

  const switchMode = useCallback(
    (m: Mode) => {
      if (m === modeRef.current || recording) return;
      // no camera restart: the shared stream keeps running, so the
      // switch is instant and torch/zoom/meter state all survive
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
      const canvas = overlayRef.current;
      const video = videoRef.current;
      if (!canvas || !video || video.videoWidth === 0) return;
      const rect = video.getBoundingClientRect();
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

      renderWatermark(ctx, w, h, data, watermark, profile, assetsRef.current);
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
      const scale = 384 / Math.max(video.videoWidth, video.videoHeight);
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
      if (!fix || !watermark.fields.miniMap) return;
      void renderMiniMap(fix.lat, fix.lng, lookupResult).then((m) => {
        if (m) assetsRef.current.miniMap = m;
      });
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
    const unsubSettings = useSettingsStore.subscribe(() => {
      void getProfilePhoto().then((p) => {
        assetsRef.current.profilePhoto = p;
        draw();
      });
    });
    return () => {
      stop = true;
      window.clearInterval(interval);
      unsubLive();
      unsubSettings();
    };
  }, [active]);

  // ---- capture ----------------------------------------------------------
  const doCapture = useCallback(async () => {
    if (busy || !ready) return;
    setBusy(true);
    setFlashFx((k) => k + 1);
    if (useSettingsStore.getState().settings.shutterSound) playShutter();
    setSaving((n) => n + 1);
    let framed = false;
    try {
      const { record, thumb } = await capturePhoto({
        onFramed: (preview) => {
          // Shutter is free again the moment the frame is composited —
          // the encode + save continue in the background.
          framed = true;
          setBusy(false);
          if (preview) setFlyImg({ src: preview, key: Date.now() });
        },
      });
      updateThumb(record.id, thumb);
    } catch {
      showToast("Capture failed — try again");
    } finally {
      if (!framed) setBusy(false);
      setSaving((n) => Math.max(0, n - 1));
    }
  }, [busy, ready, showToast, updateThumb]);

  // ---- video record -------------------------------------------------------
  const stopRecording = useCallback(() => {
    recorderRef.current?.stop();
  }, []);

  const startRecording = useCallback(() => {
    const stream = camera.stream;
    if (!stream) return;
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
        burnW = Math.floor(liveVideo.videoWidth / 2) * 2;
        burnH = Math.floor(liveVideo.videoHeight / 2) * 2;
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
        const renderWm = () => {
          wmCtx.clearRect(0, 0, burnW, burnH);
          renderWatermark(
            wmCtx,
            burnW,
            burnH,
            collectWatermarkData(),
            watermark,
            profile,
            assetsRef.current
          );
        };
        renderWm();

        let rafId = 0;
        let compositeDone = false;
        const paint = () => {
          if (compositeDone) return;
          // match digital zoom by cropping the centre of the frame
          const dz = camera.captureZoom;
          if (dz > 1) {
            const sw = liveVideo.videoWidth / dz;
            const sh = liveVideo.videoHeight / dz;
            cctx.drawImage(
              liveVideo,
              (liveVideo.videoWidth - sw) / 2,
              (liveVideo.videoHeight - sh) / 2,
              sw, sh, 0, 0, burnW, burnH
            );
          } else {
            cctx.drawImage(liveVideo, 0, 0, burnW, burnH);
          }
          if (liveBlurOn) {
            for (const b of liveBoxesRef.current) {
              const cells = 9;
              tiny.width = cells;
              tiny.height = cells;
              tctx.drawImage(liveVideo, b.x, b.y, b.width, b.height, 0, 0, cells, cells);
              cctx.imageSmoothingEnabled = false;
              cctx.drawImage(tiny, 0, 0, cells, cells, b.x, b.y, b.width, b.height);
              cctx.imageSmoothingEnabled = true;
            }
          }
          const wmTick = Math.floor(Date.now() / 500);
          if (wmTick !== lastWmTick) {
            lastWmTick = wmTick;
            renderWm();
          }
          cctx.drawImage(wmCanvas, 0, 0);
          schedule();
        };
        const rvfc = (liveVideo as HTMLVideoElement & {
          requestVideoFrameCallback?: (cb: () => void) => number;
        }).requestVideoFrameCallback?.bind(liveVideo);
        const schedule = () => {
          rafId = rvfc ? rvfc(paint) : requestAnimationFrame(paint);
        };
        paint();
        const tracks = [
          ...cc.captureStream(30).getVideoTracks(),
          ...stream.getAudioTracks(),
        ];
        recStream = new MediaStream(tracks);
        stopComposite = () => {
          compositeDone = true;
          if (!rvfc) cancelAnimationFrame(rafId);
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
    const recOpts = watermarked ? { videoBitsPerSecond: 8_000_000 } : {};
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
        showToast(
          burned
            ? "Video saved — watermark and blurred faces baked in"
            : "Video saved with the watermark baked in"
        );
      })();
    };
    recStartRef.current = Date.now();
    rec.start(1000);
    recorderRef.current = rec;
    setRecording(true);
    setRecSeconds(0);
  }, [showToast, updateThumb]);

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
    else startRecording();
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
  }, []);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 2 && pinchBase.current) {
      const [a, b] = [...pointers.current.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const target = pinchBase.current.zoom * (dist / pinchBase.current.dist);
      void camera.setZoom(target).then((z) => {
        setZoom(z);
        setZoomLabel(`${z.toFixed(1)}×`);
      });
    }
  }, []);

  const onPointerUp = useCallback(
    (e: React.PointerEvent) => {
      const start = pointers.current.get(e.pointerId);
      pointers.current.delete(e.pointerId);
      if (pointers.current.size < 2) pinchBase.current = null;
      if (pointers.current.size === 0 && start) {
        const dx = e.clientX - start.x;
        const dy = e.clientY - start.y;
        if (Math.hypot(dx, dy) < 8) {
          setFocusPos({ x: e.clientX, y: e.clientY, key: Date.now() });
          void camera.focusAt();
        }
      }
      window.setTimeout(() => setZoomLabel(null), 1200);
    },
    []
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
      style={{ visibility: active ? "visible" : "hidden" }}
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
        <div ref={boxRef} className={`cam-video-box${mirrored ? " mirrored" : ""}`}>
          {/* Black poster: a paused WebView <video> shows the play-button
              overlay only when it has NO poster. With one, the pre-stream
              gap and every mode switch render as a black frame instead. */}
          <video
            ref={videoRef}
            playsInline
            muted
            autoPlay
            poster={BLACK_POSTER}
          />
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
        </div>

        {camError && (
          <div className="empty-note" style={{ position: "absolute", inset: "30% 20px auto" }}>
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

        {zoomLabel && (
          <div className="cam-toast" style={{ bottom: "auto", top: "20%" }}>
            {zoomLabel}
          </div>
        )}
        {toast && <div className="cam-toast">{toast}</div>}
        {recording && <div className="rec-timer">{fmtRec(recSeconds)}</div>}

        {/* zoom pills — transparent like the watermark, above the shutter;
            based on the camera's real zoom range (native or digital) */}
        {zoomStops.length > 1 && (
          <div className="cam-zoombar">
            {zoomStops.map((z) => {
              const active = Math.abs(zoom - z) < 0.08;
              const label =
                z === 1 ? "1×" : Number.isInteger(z) ? String(z) : z.toFixed(1);
              return (
                <button
                  key={z}
                  className="zoom-pill"
                  data-active={active}
                  onClick={() =>
                    void camera.setZoom(z).then((v) => {
                      setZoom(v);
                      setZoomLabel(`${v.toFixed(1)}×`);
                      window.setTimeout(() => setZoomLabel(null), 900);
                    })
                  }
                >
                  {label}
                </button>
              );
            })}
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
      {focusPos && (
        <div
          key={focusPos.key}
          className="focus-ring"
          style={{ left: focusPos.x, top: focusPos.y }}
        />
      )}

      {/* Opaque controls bar — below the viewfinder, never over it. */}
      <div className="cam-controls">
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
