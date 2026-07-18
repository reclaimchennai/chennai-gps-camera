import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  Info,
  Share2,
  PencilLine,
  Download,
  Trash2,
  Tag,
  X,
  Play,
  Pause,
  Volume2,
  VolumeX,
  Maximize,
} from "lucide-react";
import { getMedia, getBlob, deleteMedia, putMedia, listMedia } from "../lib/db";
import type { MediaRecord } from "../types";
import { navigate, goBack } from "../nav";
import { shareBlob, downloadBlob, suggestedName } from "../lib/share";
import { isNativeApp } from "../lib/native";
import { fmtCoordsLine, fmtDateLine, fmtWard, fmtZone } from "../lib/geo/format";

export default function MediaDetailView({ id }: { id: string }) {
  // The currently-shown item is tracked internally so swiping between
  // gallery items never remounts this whole view (that caused the janky
  // slide, the polluted Back history, and taps being dropped right after
  // a swipe). `id` only seeds it; real route changes re-seed via effect.
  const [curId, setCurId] = useState(id);
  useEffect(() => setCurId(id), [id]);
  const [rec, setRec] = useState<MediaRecord | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [poster, setPoster] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [info, setInfo] = useState(false);
  const [tagDraft, setTagDraft] = useState<string | null>(null);
  // gallery order for swipe navigation
  const [neighbours, setNeighbours] = useState<{
    prev?: MediaRecord;
    next?: MediaRecord;
    prevUrl?: string;
    nextUrl?: string;
  }>({});
  // blob-URL cache keyed `${id}:${variant}`. It persists across swipes so
  // the image that slid in keeps the exact URL its pane was already
  // showing — the browser repaints from its decoded cache instead of
  // re-fetching the blob (that refetch was the post-swipe stutter).
  // Entries are evicted once an id leaves the prev/cur/next window and
  // everything is revoked on unmount.
  const urlCacheRef = useRef(new Map<string, string>());
  // set by commit() when it pre-seeds the incoming pane's URL, so the
  // load effect skips its blank-out for that id
  const preSeededRef = useRef<string | null>(null);
  // bumped when a backfill rewrites blobs for an on-screen id
  const [refresh, setRefresh] = useState(0);
  const videoRef = useRef<HTMLVideoElement>(null);
  // finger-following carousel track
  const trackRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{
    x0: number;
    y0: number;
    dir: "h" | "v" | null;
    dx: number;
  } | null>(null);
  const animatingRef = useRef(false);
  // immersive chrome (header + action bar) — hidden by default so the
  // watermark is never covered; a tap raises it
  const [chrome, setChrome] = useState(false);
  // custom video transport state (native controls are replaced by a
  // floating bar so they never sit over the burned-in watermark)
  const [vp, setVp] = useState({ playing: false, cur: 0, dur: 0, muted: false });

  // ---- photo pinch-zoom / pan / double-tap ---------------------------
  const stageRef = useRef<HTMLDivElement>(null);
  const zoomRef = useRef({ scale: 1, x: 0, y: 0 });
  const imgRef = useRef<HTMLImageElement>(null);
  const gesturePointers = useRef(new Map<number, { x: number; y: number }>());
  const gestureBase = useRef<{
    dist: number;
    scale: number;
    mid: { x: number; y: number };
    origin: { x: number; y: number };
  } | null>(null);
  const panBase = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);
  const lastTap = useRef(0);

  const applyZoom = useCallback(() => {
    const img = imgRef.current;
    if (!img) return;
    const z = zoomRef.current;
    img.style.transform = `translate(${z.x}px, ${z.y}px) scale(${z.scale})`;
  }, []);

  const clampZoom = useCallback(() => {
    const z = zoomRef.current;
    const stage = stageRef.current;
    if (!stage) return;
    z.scale = Math.min(6, Math.max(1, z.scale));
    // keep the photo covering the viewport when zoomed
    const maxX = (stage.clientWidth * (z.scale - 1)) / 2;
    const maxY = (stage.clientHeight * (z.scale - 1)) / 2;
    z.x = Math.min(maxX, Math.max(-maxX, z.x));
    z.y = Math.min(maxY, Math.max(-maxY, z.y));
    if (z.scale === 1) {
      z.x = 0;
      z.y = 0;
    }
  }, []);

  useEffect(() => {
    const cache = urlCacheRef.current;
    // blob URL through the cache: a hit returns the very same string the
    // neighbour pane was already rendering, so assigning it to the current
    // pane costs nothing
    const urlFor = async (
      mediaId: string,
      variant: "final" | "source" | "thumb",
    ) => {
      const key = `${mediaId}:${variant}`;
      const hit = cache.get(key);
      if (hit) return hit;
      const b = await getBlob(mediaId, variant);
      if (!b) return undefined;
      const u = URL.createObjectURL(b);
      cache.set(key, u);
      return u;
    };
    // reset zoom (clearing any leftover inline transform — the img element
    // survives a swipe now) and recentre the carousel track. Only blank the
    // visible blob when commit() has NOT pre-seeded the incoming URL; that
    // unconditional blank-out was the post-swipe stutter.
    zoomRef.current = { scale: 1, x: 0, y: 0 };
    applyZoom();
    if (preSeededRef.current !== curId) {
      setUrl(null);
      setPoster(null);
    }
    preSeededRef.current = null;
    if (trackRef.current) {
      trackRef.current.style.transition = "none";
      trackRef.current.style.transform = "translate3d(0,0,0)";
    }
    // a neighbour's display image (photo → final, video → thumbnail)
    const neighbourUrl = (m?: MediaRecord) =>
      m
        ? urlFor(m.id, m.kind === "photo" ? "final" : "thumb")
        : Promise.resolve(undefined);
    void (async () => {
      const r = await getMedia(curId);
      if (!r) {
        goBack();
        return;
      }
      setRec(r);
      const all = await listMedia();
      const idx = all.findIndex((m) => m.id === curId);
      const prev = idx > 0 ? all[idx - 1] : undefined;
      const next = idx >= 0 && idx < all.length - 1 ? all[idx + 1] : undefined;
      setNeighbours({
        prev,
        next,
        prevUrl: await neighbourUrl(prev),
        nextUrl: await neighbourUrl(next),
      });
      // Videos get their stored thumbnail as a poster so the detail view
      // shows a real frame, not the browser's gray play-button splash.
      if (r.kind === "video") {
        const t = await urlFor(curId, "thumb");
        if (t) setPoster(t);
      }
      const u =
        (r.kind === "video" && (await urlFor(curId, "final"))) ||
        (await urlFor(curId, r.kind === "photo" ? "final" : "source"));
      if (u) setUrl(u);
      // evict cached URLs whose id left the prev/cur/next window
      const keep = new Set(
        [curId, prev?.id, next?.id].filter(Boolean) as string[],
      );
      for (const [key, cached] of cache) {
        if (!keep.has(key.slice(0, key.lastIndexOf(":")))) {
          URL.revokeObjectURL(cached);
          cache.delete(key);
        }
      }
    })();
  }, [curId, refresh, applyZoom]);

  // revoke every cached URL when the viewer unmounts
  useEffect(() => {
    const cache = urlCacheRef.current;
    return () => {
      for (const u of cache.values()) URL.revokeObjectURL(u);
      cache.clear();
    };
  }, []);

  // a backfill rewrote this media's blobs (better watermark data): drop
  // the stale cached URLs, and reload the panes if it is on-screen
  useEffect(() => {
    const onUpdated = (e: Event) => {
      const mid = (e as CustomEvent<{ id?: string }>).detail?.id;
      if (!mid) return;
      const cache = urlCacheRef.current;
      let had = false;
      for (const [key, cached] of cache) {
        if (key.slice(0, key.lastIndexOf(":")) === mid) {
          URL.revokeObjectURL(cached);
          cache.delete(key);
          had = true;
        }
      }
      if (
        had &&
        (mid === curId ||
          mid === neighbours.prev?.id ||
          mid === neighbours.next?.id)
      ) {
        setRefresh((n) => n + 1);
      }
    };
    window.addEventListener("gpscam:media-updated", onUpdated);
    return () => window.removeEventListener("gpscam:media-updated", onUpdated);
  }, [curId, neighbours]);

  // Videos start playing on open (native-gallery feel). If the browser
  // refuses unmuted autoplay, fall back to muted so playback still
  // starts — tapping toggles pause.
  useEffect(() => {
    if (!url || rec?.kind !== "video") return;
    const v = videoRef.current;
    if (!v) return;
    v.play().catch(() => {
      v.muted = true;
      v.play().catch(() => {
        // truly blocked — poster + controls remain
      });
    });
  }, [url, rec?.kind]);

  // wire the floating transport bar to the <video> element
  useEffect(() => {
    if (rec?.kind !== "video") return;
    const v = videoRef.current;
    if (!v) return;
    const sync = () =>
      setVp({
        playing: !v.paused,
        cur: v.currentTime,
        dur: v.duration || 0,
        muted: v.muted,
      });
    v.addEventListener("timeupdate", sync);
    v.addEventListener("play", sync);
    v.addEventListener("pause", sync);
    v.addEventListener("loadedmetadata", sync);
    v.addEventListener("volumechange", sync);
    sync();
    return () => {
      v.removeEventListener("timeupdate", sync);
      v.removeEventListener("play", sync);
      v.removeEventListener("pause", sync);
      v.removeEventListener("loadedmetadata", sync);
      v.removeEventListener("volumechange", sync);
    };
  }, [url, rec?.kind]);

  const togglePlay = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) void v.play().catch(() => {});
    else v.pause();
  }, []);

  const toggleFullscreen = useCallback(() => {
    const v = videoRef.current as (HTMLVideoElement & {
      webkitEnterFullscreen?: () => void;
    }) | null;
    if (!v) return;
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => {});
    } else if (v.requestFullscreen) {
      void v.requestFullscreen().catch(() => {});
    } else if (v.webkitEnterFullscreen) {
      // iOS Safari only fullscreens the video element itself
      v.webkitEnterFullscreen();
    }
  }, []);

  const fmtT = (s: number) => {
    if (!Number.isFinite(s)) return "0:00";
    const m = Math.floor(s / 60);
    return `${m}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
  };

  const setTrack = (px: number, animate: boolean) => {
    const t = trackRef.current;
    if (!t) return;
    t.style.transition = animate
      ? "transform 0.32s cubic-bezier(0.22, 0.61, 0.36, 1)"
      : "none";
    t.style.transform = `translate3d(${px}px, 0, 0)`;
  };

  // commit to a neighbour after the slide finishes: swap the record and
  // recentre the track without a visible jump. The incoming pane is
  // pre-seeded synchronously from the URL cache — same blob URL the
  // neighbour pane was showing — so the swap is paint-identical (no
  // blank frame, no re-decode).
  const commit = useCallback((target: MediaRecord) => {
    const cache = urlCacheRef.current;
    preSeededRef.current = target.id;
    setRec(target);
    if (target.kind === "photo") {
      setUrl(cache.get(`${target.id}:final`) ?? null);
      setPoster(null);
    } else {
      // the video element loads fresh; its cached thumbnail poster
      // covers the gap so there is still no black flash
      setUrl(null);
      setPoster(cache.get(`${target.id}:thumb`) ?? null);
    }
    setCurId(target.id);
    history.replaceState(null, "", `#/media/${target.id}`);
  }, []);

  // ---- stage gestures: pinch-zoom photos, carousel swipe -------------
  const onStagePointerDown = useCallback((e: React.PointerEvent) => {
    if (animatingRef.current) return;
    gesturePointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const pts = [...gesturePointers.current.values()];
    if (pts.length === 2) {
      dragRef.current = null;
      panBase.current = null;
      gestureBase.current = {
        dist: Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y),
        scale: zoomRef.current.scale,
        mid: { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 },
        origin: { x: zoomRef.current.x, y: zoomRef.current.y },
      };
    } else if (pts.length === 1) {
      if (zoomRef.current.scale > 1) {
        panBase.current = {
          x: e.clientX,
          y: e.clientY,
          ox: zoomRef.current.x,
          oy: zoomRef.current.y,
        };
      } else {
        dragRef.current = { x0: e.clientX, y0: e.clientY, dir: null, dx: 0 };
      }
    }
  }, []);

  const onStagePointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!gesturePointers.current.has(e.pointerId)) return;
      gesturePointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const pts = [...gesturePointers.current.values()];
      if (pts.length === 2 && gestureBase.current && rec?.kind === "photo") {
        const b = gestureBase.current;
        const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
        const mid = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
        const ns = b.scale * (dist / b.dist);
        const z = zoomRef.current;
        z.scale = ns;
        z.x = b.origin.x + (mid.x - b.mid.x) - (b.mid.x - window.innerWidth / 2) * (ns / b.scale - 1);
        z.y = b.origin.y + (mid.y - b.mid.y) - (b.mid.y - window.innerHeight / 2) * (ns / b.scale - 1);
        clampZoom();
        applyZoom();
      } else if (pts.length === 1 && panBase.current && rec?.kind === "photo") {
        const z = zoomRef.current;
        z.x = panBase.current.ox + (e.clientX - panBase.current.x);
        z.y = panBase.current.oy + (e.clientY - panBase.current.y);
        clampZoom();
        applyZoom();
      } else if (pts.length === 1 && dragRef.current) {
        // carousel drag: follow the finger (GPU transform, no re-render)
        const d = dragRef.current;
        let dx = e.clientX - d.x0;
        const dy = e.clientY - d.y0;
        if (d.dir === null && Math.hypot(dx, dy) > 8) {
          d.dir = Math.abs(dx) > Math.abs(dy) ? "h" : "v";
        }
        if (d.dir !== "h") return;
        // resist at the ends so it feels bounded, not broken
        if ((dx > 0 && !neighbours.prev) || (dx < 0 && !neighbours.next)) dx *= 0.3;
        d.dx = dx;
        setTrack(dx, false);
      }
    },
    [rec?.kind, clampZoom, applyZoom, neighbours]
  );

  const onStagePointerUp = useCallback(
    (e: React.PointerEvent) => {
      gesturePointers.current.delete(e.pointerId);
      if (gesturePointers.current.size < 2) gestureBase.current = null;
      if (gesturePointers.current.size !== 0) return;
      panBase.current = null;
      const drag = dragRef.current;
      dragRef.current = null;

      if (drag && drag.dir === "h") {
        const w = stageRef.current?.clientWidth ?? window.innerWidth;
        const threshold = Math.min(90, w * 0.22);
        if (drag.dx < -threshold && neighbours.next) {
          animatingRef.current = true;
          setTrack(-w, true);
          const target = neighbours.next;
          window.setTimeout(() => {
            commit(target);
            animatingRef.current = false;
          }, 320);
        } else if (drag.dx > threshold && neighbours.prev) {
          animatingRef.current = true;
          setTrack(w, true);
          const target = neighbours.prev;
          window.setTimeout(() => {
            commit(target);
            animatingRef.current = false;
          }, 320);
        } else {
          setTrack(0, true); // snap back
        }
        return;
      }

      // a tap (no directional drag)
      const dx = e.clientX - (drag?.x0 ?? e.clientX);
      const dy = e.clientY - (drag?.y0 ?? e.clientY);
      if (zoomRef.current.scale === 1 && Math.hypot(dx, dy) < 8) {
        const now = Date.now();
        if (rec?.kind === "photo" && now - lastTap.current < 300) {
          const z = zoomRef.current;
          z.scale = z.scale > 1 ? 1 : 2.5;
          clampZoom();
          const img = imgRef.current;
          if (img) {
            img.style.transition = "transform 0.25s ease";
            window.setTimeout(() => {
              if (img) img.style.transition = "";
            }, 260);
          }
          applyZoom();
          lastTap.current = 0;
        } else {
          lastTap.current = now;
          setChrome((c) => !c);
        }
      }
    },
    [neighbours, rec?.kind, commit, clampZoom, applyZoom]
  );

  if (!rec) return null;

  const onShare = async () => {
    const blob =
      (rec.kind === "video" && (await getBlob(curId, "final"))) ||
      (await getBlob(curId, rec.kind === "photo" ? "final" : "source"));
    if (!blob) return;
    // Location context rides along with the file (§ share: ward, zone,
    // address, and a Google Maps link for the exact coordinates).
    const d = rec.data;
    const jd = d.jurisdiction;
    const lines: string[] = [];
    if (d.locality) lines.push(d.locality);
    if (d.address) lines.push(d.address);
    if (d.digipin) lines.push(`DIGIPIN: ${d.digipin}`);
    if (jd && jd.scope !== "out") {
      const pending = jd.wardPending || jd.scope === "avadi";
      const parts = [jd.corporation];
      if (pending) parts.push("Ward: not yet available");
      else if (jd.ward)
        parts.push(
          `Ward ${fmtWard(jd.ward)}${jd.wardName ? ` (${jd.wardName})` : ""}`
        );
      if (jd.zone && !pending) parts.push(fmtZone(jd.zone));
      lines.push(parts.filter(Boolean).join(" · "));
      if (jd.loStation) lines.push(`Police (L&O): ${jd.loStation}`);
      if (jd.trafficStation) lines.push(`Traffic: ${jd.trafficStation}`);
    }
    if (d.fix) {
      lines.push(
        `https://maps.google.com/?q=${d.fix.lat.toFixed(6)},${d.fix.lng.toFixed(6)}`
      );
    }
    await shareBlob(
      blob,
      suggestedName(rec.kind, rec.createdAt, blob.type),
      lines.join("\n")
    );
  };

  const onDownload = async () => {
    const blob =
      (rec.kind === "video" && (await getBlob(curId, "final"))) ||
      (await getBlob(curId, rec.kind === "photo" ? "final" : "source"));
    if (blob)
      downloadBlob(blob, suggestedName(rec.kind, rec.createdAt, blob.type));
  };

  const onDelete = async () => {
    await deleteMedia(curId);
    navigate("/gallery");
  };

  const saveTags = async (tags: string[]) => {
    const updated = { ...rec, tags };
    setRec(updated);
    await putMedia(updated);
  };

  const addTag = async () => {
    const t = tagDraft?.trim().toLowerCase();
    setTagDraft(null);
    if (!t) return;
    const tags = rec.tags ?? [];
    if (!tags.includes(t)) await saveTags([...tags, t]);
  };

  const j = rec.data.jurisdiction;

  const isVideo = rec.kind === "video";

  return (
    <div className="viewer">
      {/* full-bleed media area (leaves a strip at the bottom for a video's
          floating controls so the burned watermark is never covered) */}
      <div
        ref={stageRef}
        className={`viewer-media${isVideo ? " has-bar" : ""}`}
        onPointerDown={onStagePointerDown}
        onPointerMove={onStagePointerMove}
        onPointerUp={onStagePointerUp}
        onPointerCancel={onStagePointerUp}
      >
        {/* 3-pane carousel: [prev][current][next]. The track follows the
            finger during a swipe (GPU transform, no React churn) and
            spring-snaps on release; only the current pane holds the
            zoomable image or the playing video. */}
        <div ref={trackRef} className="viewer-track">
          <div className="viewer-pane">
            {neighbours.prevUrl && (
              <img className="pane-img" src={neighbours.prevUrl} alt="" draggable={false} />
            )}
          </div>
          <div className="viewer-pane">
            {url && rec.kind === "photo" && (
              <img ref={imgRef} className="media-photo pane-img" src={url} alt="" draggable={false} />
            )}
            {url && isVideo && (
              <video
                ref={videoRef}
                src={url}
                playsInline
                autoPlay
                preload="auto"
                poster={poster ?? undefined}
              />
            )}
          </div>
          <div className="viewer-pane">
            {neighbours.nextUrl && (
              <img className="pane-img" src={neighbours.nextUrl} alt="" draggable={false} />
            )}
          </div>
        </div>
      </div>

      {/* floating transport bar — always visible for video, so the native
          control strip never sits on top of the watermark. Rises above
          the action pill when the chrome is up. */}
      {isVideo && (
        <div
          className={`viewer-transport${chrome ? " raised" : ""}`}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <button className="vt-btn" onClick={togglePlay} aria-label={vp.playing ? "Pause" : "Play"}>
            {vp.playing ? <Pause size={20} /> : <Play size={20} />}
          </button>
          <span className="vt-time">{fmtT(vp.cur)}</span>
          <input
            className="vt-seek"
            type="range"
            min={0}
            max={vp.dur || 0}
            step={0.05}
            value={Math.min(vp.cur, vp.dur || 0)}
            onChange={(e) => {
              const v = videoRef.current;
              if (v) v.currentTime = Number(e.target.value);
            }}
          />
          <span className="vt-time">{fmtT(vp.dur)}</span>
          <button
            className="vt-btn"
            onClick={() => {
              const v = videoRef.current;
              if (v) v.muted = !v.muted;
            }}
            aria-label={vp.muted ? "Unmute" : "Mute"}
          >
            {vp.muted ? <VolumeX size={19} /> : <Volume2 size={19} />}
          </button>
          <button className="vt-btn" onClick={toggleFullscreen} aria-label="Fullscreen">
            <Maximize size={18} />
          </button>
        </div>
      )}

      {/* immersive chrome: slides in on tap */}
      <header className={`viewer-top${chrome ? " show" : ""}`}>
        <button className="icon-btn" onClick={goBack} aria-label="Back">
          <ArrowLeft size={20} />
        </button>
        <h1>
          {new Date(rec.createdAt).toLocaleString("en-IN", {
            dateStyle: "medium",
            timeStyle: "short",
          })}
        </h1>
        <button className="icon-btn" onClick={() => setInfo(true)} aria-label="Info">
          <Info size={20} />
        </button>
      </header>

      {/* slim floating action pill + a compact tags row, raised on tap */}
      <div className={`viewer-bottom${chrome ? " show" : ""}`}>
        <div className="viewer-tags">
          {(rec.tags ?? []).map((t) => (
            <span key={t} className="tag-chip">
              {t}
              <button
                aria-label={`Remove tag ${t}`}
                onClick={() => void saveTags((rec.tags ?? []).filter((x) => x !== t))}
              >
                <X size={12} />
              </button>
            </span>
          ))}
          {tagDraft !== null ? (
            <input
              className="tag-input"
              autoFocus
              placeholder="tag name"
              value={tagDraft}
              onChange={(e) => setTagDraft(e.target.value)}
              onBlur={() => void addTag()}
              onKeyDown={(e) => {
                if (e.key === "Enter") void addTag();
                if (e.key === "Escape") setTagDraft(null);
              }}
            />
          ) : (
            <button className="tag-add chip-btn" onClick={() => setTagDraft("")}>
              <Tag size={12} /> Tag
            </button>
          )}
        </div>

        <div className="action-pill">
          <button className="pill-action" onClick={() => void onShare()}>
            <Share2 size={19} />
            <span>Share</span>
          </button>
          <button
            className="pill-action"
            onClick={() =>
              navigate(rec.kind === "photo" ? `/edit/${curId}` : `/video-edit/${curId}`)
            }
          >
            <PencilLine size={19} />
            <span>{rec.kind === "photo" ? "Annotate" : "Edit"}</span>
          </button>
          {!isNativeApp() && (
            <button className="pill-action" onClick={() => void onDownload()}>
              <Download size={19} />
              <span>Save</span>
            </button>
          )}
          <button className="pill-action danger" onClick={() => setConfirmDelete(true)}>
            <Trash2 size={19} />
            <span>Delete</span>
          </button>
        </div>
      </div>

      {confirmDelete && (
        <div className="modal-scrim" onClick={() => setConfirmDelete(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>Delete this {rec.kind}?</h2>
            <p>It will be removed permanently from this device.</p>
            <div style={{ display: "flex", gap: 10, marginTop: 14 }}>
              <button className="ghost-btn" style={{ flex: 1 }} onClick={() => setConfirmDelete(false)}>
                Cancel
              </button>
              <button
                className="primary-btn"
                style={{ flex: 1, background: "var(--danger)", color: "#fff" }}
                onClick={() => void onDelete()}
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}

      {info && (
        <div className="modal-scrim" onClick={() => setInfo(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>Details</h2>
            <p style={{ userSelect: "text" }}>
              {rec.data.fix
                ? fmtCoordsLine(rec.data.fix.lat, rec.data.fix.lng)
                : "No GPS fix at capture"}
              <br />
              {fmtDateLine(rec.data.timestamp, rec.data.tzOffsetMinutes)}
              {rec.data.address && (
                <>
                  <br />
                  {rec.data.address}
                </>
              )}
              {j && j.scope !== "out" && (
                <>
                  <br />
                  {j.corporation}
                  {j.wardPending || j.scope === "avadi"
                    ? " · Ward: not yet available"
                    : j.ward
                      ? ` · Ward ${fmtWard(j.ward)}${j.wardName ? ` (${j.wardName})` : ""}${j.zone ? ` · ${fmtZone(j.zone)}` : ""}`
                      : ""}
                  {j.loStation && (
                    <>
                      <br />
                      L&amp;O: {j.loStation}
                      {j.loMeta ? ` (${j.loMeta})` : ""}
                    </>
                  )}
                  {j.trafficStation && (
                    <>
                      <br />
                      Traffic: {j.trafficStation}
                      {j.trafficMeta ? ` (${j.trafficMeta})` : ""}
                    </>
                  )}
                </>
              )}
              {rec.kind === "photo" && rec.backfill === "pending" && (
                <>
                  <br />
                  <em>Street address will be added when online.</em>
                </>
              )}
            </p>
            <button className="primary-btn" style={{ width: "100%" }} onClick={() => setInfo(false)}>
              Close
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
