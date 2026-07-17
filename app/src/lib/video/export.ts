/**
 * Single-pass video export (§5.7): trim + crop + markup/blur + burned-in
 * watermark, re-encoded once via canvas.captureStream + MediaRecorder.
 *
 * Real-time re-encode: a 30 s clip takes ~30 s — the UI shows a
 * determinate progress bar rather than pretending it's instant. Auto
 * face-blur re-detects every few frames and holds boxes in between
 * (§5.7: re-detection over tracking). WebCodecs-based faster-than-
 * realtime export is a possible upgrade; this path works everywhere
 * MediaRecorder does.
 */
import type { VideoRecord, WatermarkData } from "../../types";
import { renderWatermark } from "../watermark/render";
import { renderMiniMap } from "../watermark/minimap";
import { getProfilePhoto } from "../capture";
import { useSettingsStore } from "../../store";
import {
  makeMosaic,
  paintBlurRegions,
  blocksFor,
  type Shape,
} from "../editor/shapes";
import {
  detectFaces,
  detectFacesInFrame,
  type DetectedBox,
} from "../detect/faces";
import { makeThumbnail } from "../img";
import { dbFromAnalyser } from "../audio/meter";
import { pickRecordingMime, finalizeVideoBlob } from "./postprocess";

export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface VideoExportOptions {
  record: VideoRecord;
  source: Blob;
  trimStart: number;
  trimEnd: number;
  crop: CropRect | null;
  /** Manual shapes in source pixel coordinates (fixed for the clip). */
  shapes: Shape[];
  /** Pre-rendered transparent markup overlay at full source size. */
  markupCanvas: HTMLCanvasElement | null;
  autoBlurFaces: boolean;
  onProgress(fraction: number): void;
}

const DETECT_EVERY_N_FRAMES = 4;

export async function exportVideo(opts: VideoExportOptions): Promise<{
  blob: Blob;
  thumb: Blob | null;
  width: number;
  height: number;
  duration: number;
}> {
  const { record, source, trimStart, trimEnd, crop, shapes, markupCanvas } =
    opts;

  const video = document.createElement("video");
  video.playsInline = true;
  video.preload = "auto";
  const srcUrl = URL.createObjectURL(source);
  video.src = srcUrl;
  await new Promise<void>((res, rej) => {
    video.onloadedmetadata = () => res();
    video.onerror = () => rej(new Error("video decode failed"));
  });

  const srcW = video.videoWidth;
  const srcH = video.videoHeight;
  const out: CropRect = crop ?? { x: 0, y: 0, width: srcW, height: srcH };
  // even dimensions keep encoders happy
  const outW = Math.max(2, Math.floor(out.width / 2) * 2);
  const outH = Math.max(2, Math.floor(out.height / 2) * 2);

  const canvas = document.createElement("canvas");
  canvas.width = outW;
  canvas.height = outH;
  const ctx = canvas.getContext("2d")!;

  // ---- watermark overlay, re-rendered as the clock ticks -------------
  // Recordings made by the live camera already have the card burned into
  // every frame; stamping it again here would double it. Only editor
  // work (trim/crop/markup/blur) is applied to those.
  const alreadyWatermarked = Boolean(record.watermarkBurned);
  const { watermark: cfgDefault, profile } = useSettingsStore.getState();
  const config = record.config ?? cfgDefault;
  const data: WatermarkData = record.data;
  const wmCanvas = document.createElement("canvas");
  wmCanvas.width = outW;
  wmCanvas.height = outH;
  const wmCtx = wmCanvas.getContext("2d")!;
  const assets: {
    miniMap?: CanvasImageSource | null;
    profilePhoto?: CanvasImageSource | null;
  } = {};
  if (!alreadyWatermarked && config.fields.miniMap && data.fix) {
    assets.miniMap = await renderMiniMap(data.fix.lat, data.fix.lng, null);
  }
  if (!alreadyWatermarked && config.fields.profilePhoto) {
    assets.profilePhoto = await getProfilePhoto();
  }
  // Source time 0 is the moment recording started, so the burned clock
  // ticks in step with the original wall-clock time (§ item: live
  // seconds in video watermarks).
  const renderWatermarkAt = (srcTimeS: number, db: number | null) => {
    if (alreadyWatermarked) return;
    wmCtx.clearRect(0, 0, outW, outH);
    renderWatermark(
      wmCtx,
      outW,
      outH,
      {
        ...data,
        timestamp: data.timestamp + srcTimeS * 1000,
        db: db ?? data.db,
      },
      config,
      profile,
      assets
    );
  };
  renderWatermarkAt(trimStart, null);

  const blurShapes = shapes.filter((s) => s.type.startsWith("blur"));

  // ---- audio: element source routed to a silent destination ----------
  const streamTracks: MediaStreamTrack[] = [];
  const fps = 30;
  const canvasStream = canvas.captureStream(fps);
  streamTracks.push(...canvasStream.getVideoTracks());
  let audioCtx: AudioContext | null = null;
  let exportAnalyser: AnalyserNode | null = null;
  try {
    audioCtx = new AudioContext();
    const src = audioCtx.createMediaElementSource(video);
    const dest = audioCtx.createMediaStreamDestination();
    src.connect(dest); // NOT connected to speakers — silent export
    if (config.fields.soundLevel && !alreadyWatermarked) {
      // tap the clip's own audio so the burned dB figure stays live
      exportAnalyser = audioCtx.createAnalyser();
      exportAnalyser.fftSize = 2048;
      src.connect(exportAnalyser);
    }
    if (dest.stream.getAudioTracks().length) {
      streamTracks.push(...dest.stream.getAudioTracks());
    }
  } catch {
    // no audio in source, or WebAudio unavailable — export video-only
  }

  let mimeType = pickRecordingMime();
  let recorder: MediaRecorder;
  try {
    recorder = new MediaRecorder(new MediaStream(streamTracks), {
      mimeType: mimeType || undefined,
      videoBitsPerSecond: 8_000_000,
    });
  } catch {
    mimeType = "video/webm";
    recorder = new MediaRecorder(new MediaStream(streamTracks), {
      mimeType,
      videoBitsPerSecond: 8_000_000,
    });
  }
  const chunks: Blob[] = [];
  recorder.ondataavailable = (e) => {
    if (e.data.size) chunks.push(e.data);
  };

  // ---- per-frame render loop -------------------------------------------
  let faceBoxes: DetectedBox[] = [];
  let frameCount = 0;
  let detecting = false;
  let stopped = false;
  let lastWmTick = -1;

  // Detection must see the CLEAN video frame. Detecting on the composited
  // canvas is self-defeating: once a face is mosaicked the detector loses
  // it on the next pass, the box drops, the face reappears un-blurred —
  // the flicker users reported as "auto blur doesn't export".
  const detectCanvas = document.createElement("canvas");
  detectCanvas.width = outW;
  detectCanvas.height = outH;
  const detectCtx = detectCanvas.getContext("2d")!;

  const renderFrame = () => {
    ctx.drawImage(
      video,
      out.x, out.y, out.width, out.height,
      0, 0, outW, outH
    );

    // Auto blur: kick off re-detection on a clean copy of this frame
    // every Nth frame, hold boxes in between (§5.7 — re-detect over
    // tracking). Runs before compositing so the copy is pixel-fresh.
    if (opts.autoBlurFaces && !detecting && frameCount % DETECT_EVERY_N_FRAMES === 0) {
      detecting = true;
      detectCtx.drawImage(canvas, 0, 0);
      void detectFacesInFrame(detectCanvas)
        .then((boxes) => {
          faceBoxes = boxes;
        })
        .finally(() => {
          detecting = false;
        });
    }

    if (blurShapes.length || (opts.autoBlurFaces && faceBoxes.length)) {
      // fresh mosaics each frame, one per distinct intensity in use
      const frameMosaics = new Map<number, HTMLCanvasElement>();
      const getMosaic = (blocks: number) => {
        let m = frameMosaics.get(blocks);
        if (!m) {
          m = makeMosaic(canvas, outW, outH, blocks);
          frameMosaics.set(blocks, m);
        }
        return m;
      };
      if (blurShapes.length) {
        paintBlurRegions(ctx, getMosaic, blurShapes, out.x, out.y);
      }
      const faceMosaic = getMosaic(blocksFor(undefined));
      for (const b of faceBoxes) {
        const padX = b.width * 0.15;
        const padY = b.height * 0.2;
        const bx = Math.max(0, b.x - padX);
        const by = Math.max(0, b.y - padY);
        const bw = Math.min(outW - bx, b.width + padX * 2);
        const bh = Math.min(outH - by, b.height + padY * 2);
        ctx.drawImage(faceMosaic, bx, by, bw, bh, bx, by, bw, bh);
      }
    }

    if (markupCanvas) {
      ctx.drawImage(
        markupCanvas,
        out.x, out.y, out.width, out.height,
        0, 0, outW, outH
      );
    }
    // tick the burned watermark (seconds + live dB) twice per second
    const wmTick = Math.floor(video.currentTime * 2);
    if (wmTick !== lastWmTick) {
      lastWmTick = wmTick;
      renderWatermarkAt(
        video.currentTime,
        exportAnalyser ? dbFromAnalyser(exportAnalyser) : null
      );
    }
    if (!alreadyWatermarked) ctx.drawImage(wmCanvas, 0, 0);

    frameCount++;
    opts.onProgress(
      Math.min(
        1,
        (video.currentTime - trimStart) / Math.max(0.01, trimEnd - trimStart)
      )
    );
  };

  const useRVFC = "requestVideoFrameCallback" in video;
  const scheduleFrames = () => {
    if (useRVFC) {
      const cb = () => {
        if (stopped) return;
        renderFrame();
        (video as HTMLVideoElement & {
          requestVideoFrameCallback(cb: () => void): number;
        }).requestVideoFrameCallback(cb);
      };
      (video as HTMLVideoElement & {
        requestVideoFrameCallback(cb: () => void): number;
      }).requestVideoFrameCallback(cb);
    } else {
      const loop = () => {
        if (stopped) return;
        renderFrame();
        requestAnimationFrame(loop);
      };
      requestAnimationFrame(loop);
    }
  };

  // ---- run ------------------------------------------------------------------
  video.currentTime = trimStart;
  await new Promise<void>((res) => {
    video.onseeked = () => res();
  });

  // Warm up detection BEFORE playback starts: the first detector call
  // loads wasm + models (seconds on a phone). Without this the whole
  // clip can play through with zero face boxes — exports came out
  // un-blurred despite auto blur being on. A thorough first pass also
  // seeds boxes so frame 0 is already covered.
  if (opts.autoBlurFaces) {
    detectCtx.drawImage(
      video,
      out.x, out.y, out.width, out.height,
      0, 0, outW, outH
    );
    faceBoxes = (await detectFaces(detectCanvas, { thorough: true })) ?? [];
  }

  renderFrame(); // first frame before recording starts
  let thumb: Blob | null = null;
  try {
    thumb = await makeThumbnail(canvas, outW, outH);
  } catch {
    // no thumbnail — gallery shows a placeholder
  }

  const done = new Promise<Blob>((resolve) => {
    recorder.onstop = () =>
      resolve(new Blob(chunks, { type: mimeType || "video/webm" }));
  });

  recorder.start(1000);
  scheduleFrames();
  await video.play();

  await new Promise<void>((res) => {
    const check = window.setInterval(() => {
      if (video.currentTime >= trimEnd || video.ended) {
        window.clearInterval(check);
        res();
      }
    }, 60);
  });

  stopped = true;
  video.pause();
  recorder.stop();
  const rawOut = await done;

  URL.revokeObjectURL(srcUrl);
  if (audioCtx) void audioCtx.close();

  // container fixes: GPS atom (MP4) / duration header (webm)
  const durationS = trimEnd - trimStart;
  const blob = await finalizeVideoBlob(rawOut, durationS * 1000, data.fix);
  opts.onProgress(1);

  return {
    blob,
    thumb,
    width: outW,
    height: outH,
    duration: durationS,
  };
}
