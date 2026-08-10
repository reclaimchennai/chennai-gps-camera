import { useEffect, useMemo, useRef, useState } from "react";
import {
  Play,
  RefreshCw,
  Search,
  X,
  MapPin,
  Layers,
  Map as MapIcon,
  LayoutGrid,
  Trash2,
  Tag as TagIcon,
  Check,
} from "lucide-react";
import { Screen, blurOnEnter } from "./ui";
import { listMedia, getBlob, deleteMedia, putMedia } from "../lib/db";
import {
  getThumbUrl,
  setThumbUrl,
  onThumbEvicted,
  pruneThumbs,
  rememberCells,
  recallCells,
  rememberScroll,
  recallScroll,
} from "../lib/thumbcache";
import { clearViewerOrder, setViewerOrigin } from "../lib/viewer-order";
import type { MediaRecord } from "../types";
import { navigate, registerBackIntercept } from "../nav";
import { fmtWard } from "../lib/geo/format";
import { useLongPress } from "./longpress";
import { hapticTap } from "../lib/haptics";

interface Cell {
  rec: MediaRecord;
  url: string | null;
}

/**
 * One tile's thumbnail, fetched only once the tile nears the viewport.
 *
 * The grid used to build an object URL for EVERY record the moment the
 * gallery mounted. Past the cache's ceiling that evicted — and revoked —
 * the URLs it had just made, and because `listMedia()` is newest-first the
 * casualties were the newest photos: the top of the grid came back as
 * broken-image icons on any library big enough. Fetching per tile means a
 * 2,000-photo gallery does the same work as a 20-photo one, and an
 * eviction now resets the tile to its shimmer instead of stranding it.
 */
function CellThumb({ rec }: { rec: MediaRecord }) {
  const [url, setUrl] = useState<string | null>(() => getThumbUrl(rec.id));
  const holder = useRef<HTMLSpanElement | null>(null);

  useEffect(() => onThumbEvicted((id) => {
    if (id === rec.id) setUrl(null);
  }), [rec.id]);

  useEffect(() => {
    if (url) return;
    const el = holder.current;
    if (!el) return;
    let cancelled = false;
    const io = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        io.disconnect();
        void (async () => {
          let u = getThumbUrl(rec.id);
          if (!u) {
            const blob = await getBlob(rec.id, "thumb");
            if (!blob || cancelled) return;
            u = URL.createObjectURL(blob);
            // registers with the LRU, which may evict some other tile
            setThumbUrl(rec.id, u);
          }
          if (!cancelled) setUrl(u);
        })();
      },
      // start a screen early, so scrolling lands on decoded images
      { rootMargin: "400px 0px" }
    );
    io.observe(el);
    return () => {
      cancelled = true;
      io.disconnect();
    };
  }, [rec.id, url]);

  if (url) return <img src={url} alt="" decoding="async" />;
  // the shimmer is also the observer's target: it is inset:0, so it has a
  // box to intersect with, which display:contents would not
  return (
    <span ref={holder} className="cell-skel" aria-hidden="true">
      {rec.kind === "video" && (
        <Play size={22} style={{ position: "absolute", inset: 0, margin: "auto" }} />
      )}
    </span>
  );
}

/** Short location label for a grid cell: suburb, else ward, else nothing. */
function cellLocation(rec: MediaRecord): string {
  const d = rec.data;
  if (d.locality) return d.locality.split(",")[0].trim();
  const j = d.jurisdiction;
  if (j && j.scope !== "out" && j.ward) return `Ward ${fmtWard(j.ward)}`;
  if (j && j.scope === "avadi") return "Avadi";
  return "";
}

function cellWhen(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const day = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const diffDays = Math.round((today.getTime() - day.getTime()) / 86_400_000);
  if (diffDays === 0)
    return d.toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" });
  if (diffDays === 1) return "Yesterday";
  return d.toLocaleDateString("en-IN", { day: "numeric", month: "short" });
}

/** Everything searchable about a record, lowercased. */
function haystack(rec: MediaRecord): string {
  const d = rec.data;
  const j = d.jurisdiction;
  return [
    d.address,
    d.locality,
    j?.corporation,
    j?.ward && `ward ${fmtWard(j.ward)}`,
    j?.zone,
    j?.loStation,
    j?.trafficStation,
    ...(rec.tags ?? []),
    ...(rec.kind === "photo" ? (rec.plates ?? []) : []),
    new Date(rec.createdAt).toDateString(),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

type Chip = "all" | "photos" | "videos" | `tag:${string}`;

export default function GalleryView() {
  // Start from the grid we painted last time. Opening a photo unmounts this
  // view, so without this every return showed an empty grid for a frame and
  // then re-decoded every thumbnail — the flicker on each round trip.
  const [cells, setCells] = useState<Cell[] | null>(() =>
    recallCells<Cell[]>()
  );
  const [query, setQuery] = useState("");
  const [chip, setChip] = useState<Chip>("all");
  // ids the backfill queue just upgraded — briefly highlighted
  const [flashIds, setFlashIds] = useState<Set<string>>(new Set());
  // selection mode: null = off. Entered by holding a cell; the held photo
  // is already selected, so one gesture both arms the mode and picks.
  const [sel, setSel] = useState<Set<string> | null>(null);
  const selecting = sel !== null;
  const [tagDraft, setTagDraft] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);

  const exitSelection = () => {
    setSel(null);
    setTagDraft(null);
    setConfirmDelete(false);
  };

  const toggle = (id: string) =>
    setSel((s) => {
      const n = new Set(s ?? []);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      // deselecting the last one leaves selection mode, so the grid can
      // never strand the user in an empty selection with no way out
      return n.size ? n : null;
    });

  const bindHold = useLongPress((id) => {
    hapticTap(); // the hold registered — confirm by feel, before any repaint
    setSel(new Set([id]));
  }, !selecting);

  // Back (Android gesture/button) drops the selection rather than leaving
  // the gallery. Modals inside it get first refusal.
  useEffect(() => {
    return registerBackIntercept(() => {
      if (confirmDelete) {
        setConfirmDelete(false);
        return true;
      }
      if (tagDraft !== null) {
        setTagDraft(null);
        return true;
      }
      if (selecting) {
        exitSelection();
        return true;
      }
      return false;
    });
  }, [selecting, tagDraft, confirmDelete]);

  // Desktop/web equivalent of the same escape hatch
  useEffect(() => {
    if (!selecting) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (confirmDelete) setConfirmDelete(false);
      else if (tagDraft !== null) setTagDraft(null);
      else exitSelection();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selecting, tagDraft, confirmDelete]);

  // Opening a photo unmounts this screen; keep the scroll offset so coming
  // back lands exactly where the user was, not at the top of the grid.
  const restoredScroll = useRef(false);
  useEffect(() => {
    // the Screen body is the scroll container
    const body = document.querySelector<HTMLElement>(".screen-body");
    if (!body) return;
    const onScroll = () => rememberScroll(body.scrollTop);
    body.addEventListener("scroll", onScroll, { passive: true });
    return () => body.removeEventListener("scroll", onScroll);
  }, []);
  // restore only once the grid has real height — on a cold load the cells
  // arrive async and an early scrollTop write just clamps to 0
  useEffect(() => {
    if (restoredScroll.current || !cells?.length) return;
    const body = document.querySelector<HTMLElement>(".screen-body");
    if (!body) return;
    restoredScroll.current = true;
    body.scrollTop = recallScroll();
  }, [cells]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      // records only — each tile fetches its own thumbnail when it nears
      // the viewport (CellThumb). Building them all here is what broke a
      // big gallery: the cache evicted and revoked the URLs mid-flight.
      const items = await listMedia();
      if (cancelled) return;
      const loaded = items.map((rec) => ({ rec, url: null }));
      pruneThumbs(items.map((i) => i.id));
      setCells(loaded);
      rememberCells(loaded);
    };
    void load();

    // when a queued photo/video gains its address, refresh the grid and
    // pulse the updated cell so the change is visible
    const onUpdated = (e: Event) => {
      const id = (e as CustomEvent<{ id: string }>).detail?.id;
      void load();
      if (!id) return;
      setFlashIds((s) => new Set(s).add(id));
      window.setTimeout(() => {
        setFlashIds((s) => {
          const n = new Set(s);
          n.delete(id);
          return n;
        });
      }, 1600);
    };
    window.addEventListener("gpscam:media-updated", onUpdated);
    return () => {
      cancelled = true;
      window.removeEventListener("gpscam:media-updated", onUpdated);
      // deliberately NOT revoking here: these URLs are shared with the
      // photo view and reused on the way back (see lib/thumbcache)
    };
  }, []);

  const allTags = useMemo(() => {
    const tags = new Set<string>();
    for (const c of cells ?? []) for (const t of c.rec.tags ?? []) tags.add(t);
    return [...tags].sort();
  }, [cells]);

  // frame photos grabbed from a video group under it (folder-in-folder);
  // count per video drives the stack badge on its cell
  const frameCounts = useMemo(() => {
    const videoIds = new Set(
      (cells ?? []).filter((c) => c.rec.kind === "video").map((c) => c.rec.id)
    );
    const counts = new Map<string, number>();
    for (const { rec } of cells ?? []) {
      if (rec.kind === "photo" && rec.sourceVideoId && videoIds.has(rec.sourceVideoId)) {
        counts.set(rec.sourceVideoId, (counts.get(rec.sourceVideoId) ?? 0) + 1);
      }
    }
    return counts;
  }, [cells]);

  const visible = useMemo(() => {
    if (!cells) return null;
    const q = query.trim().toLowerCase();
    return cells.filter(({ rec }) => {
      // frames live inside their video's group, not the main grid — but a
      // search can still surface them directly (e.g. by plate number)
      if (
        !q &&
        rec.kind === "photo" &&
        rec.sourceVideoId &&
        frameCounts.has(rec.sourceVideoId)
      ) {
        return false;
      }
      if (chip === "photos" && rec.kind !== "photo") return false;
      if (chip === "videos" && rec.kind !== "video") return false;
      if (chip.startsWith("tag:") && !(rec.tags ?? []).includes(chip.slice(4)))
        return false;
      if (q && !haystack(rec).includes(q)) return false;
      return true;
    });
  }, [cells, query, chip, frameCounts]);

  const fmtDur = (s: number) =>
    `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;

  // ---- bulk actions on the selection ----------------------------------
  const reload = async () => {
    const items = await listMedia();
    const loaded = items.map((rec) => ({ rec, url: null }));
    pruneThumbs(items.map((i) => i.id));
    setCells(loaded);
    rememberCells(loaded);
  };

  /** Add one or more comma-separated tags to every selected item. */
  const applyTags = async () => {
    const parts = (tagDraft ?? "")
      .split(",")
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean);
    setTagDraft(null);
    if (!parts.length || !sel?.size || busy) return;
    setBusy(true);
    try {
      // tags MERGE — a bulk tag never drops what a photo already carries
      for (const { rec } of cells ?? []) {
        if (!sel.has(rec.id)) continue;
        const existing = rec.tags ?? [];
        const merged = [...existing];
        for (const p of parts) if (!merged.includes(p)) merged.push(p);
        if (merged.length !== existing.length) {
          await putMedia({ ...rec, tags: merged } as MediaRecord);
        }
      }
      await reload();
      exitSelection();
    } finally {
      setBusy(false);
    }
  };

  const deleteSelected = async () => {
    if (!sel?.size || busy) return;
    setBusy(true);
    try {
      for (const id of sel) await deleteMedia(id);
      await reload();
      exitSelection();
    } finally {
      setBusy(false);
    }
  };

  const selectAllVisible = () =>
    setSel(new Set((visible ?? []).map((c) => c.rec.id)));

  return (
    <Screen
      title={selecting ? `${sel.size} selected` : "Gallery"}
      onBack={selecting ? exitSelection : undefined}
      backLabel={selecting ? "Cancel selection" : undefined}
      backIcon={selecting ? <X size={20} /> : undefined}
      actions={
        <span style={{ marginLeft: "auto", display: "flex", gap: 4 }}>
          {selecting ? (
            <button
              className="icon-btn"
              onClick={selectAllVisible}
              aria-label="Select all"
            >
              <Check size={20} />
            </button>
          ) : (
            <>
              {/* the before/after poster now lives INSIDE the collage
                  screen — one "make something" door, two things to make */}
              <button
                className="icon-btn"
                onClick={() => navigate("/gallery/collage")}
                aria-label="Make a collage or poster"
              >
                <LayoutGrid size={20} />
              </button>
              <button
                className="icon-btn"
                onClick={() => navigate("/gallery/map")}
                aria-label="Photo map"
              >
                <MapIcon size={20} />
              </button>
            </>
          )}
        </span>
      }
    >
      <div className="gal-search">
        <Search size={17} />
        <input
          placeholder="Search photos, locations, tags…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {query && (
          <button onClick={() => setQuery("")} aria-label="Clear search">
            <X size={16} />
          </button>
        )}
      </div>

      <div className="gal-chips">
        {(
          [
            ["all", "All"],
            ["photos", "Photos"],
            ["videos", "Videos"],
          ] as [Chip, string][]
        ).map(([key, label]) => (
          <button
            key={key}
            className="gal-chip"
            data-active={chip === key}
            onClick={() => setChip(key)}
          >
            {label}
          </button>
        ))}
        {allTags.map((t) => (
          <button
            key={t}
            className="gal-chip"
            data-active={chip === `tag:${t}`}
            onClick={() => setChip(chip === `tag:${t}` ? "all" : `tag:${t}`)}
          >
            {t}
          </button>
        ))}
      </div>

      {/* first-load skeleton — shimmer placeholders until thumbs decode */}
      {cells === null && (
        <div className="gallery-grid">
          {Array.from({ length: 9 }).map((_, i) => (
            <div key={i} className="gallery-cell skeleton" />
          ))}
        </div>
      )}

      {visible && visible.length === 0 && (
        <div className="empty-note">
          {cells && cells.length === 0 ? (
            <>
              Photos and videos you take in this app appear here.
              <br />
              They stay on this device unless you share them.
            </>
          ) : (
            "Nothing matches this search."
          )}
        </div>
      )}

      <div className="gallery-grid">
        {visible?.map(({ rec }) => {
          const loc = cellLocation(rec);
          const picked = sel?.has(rec.id) ?? false;
          return (
            <button
              key={rec.id}
              // ONLY the selected cells jiggle — the unselected grid stays
              // dead still, so what is picked is obvious at a glance
              className={`gallery-cell${flashIds.has(rec.id) ? " updated" : ""}${
                picked ? " selected jiggle" : ""
              }`}
              aria-pressed={selecting ? picked : undefined}
              {...bindHold(rec.id)}
              onClick={() => {
                if (selecting) {
                  toggle(rec.id);
                  return;
                }
                // browsing from the grid swipes in gallery order, not in
                // whatever neighbourhood order the map may have set up
                clearViewerOrder();
                setViewerOrigin("/gallery");
                navigate(
                  rec.kind === "video" && frameCounts.has(rec.id)
                    ? `/gallery/group/${rec.id}`
                    : `/media/${rec.id}`
                );
              }}
            >
              {/* A tile whose thumbnail has not decoded yet carries its own
                  shimmer until its image arrives — the grid-level skeleton
                  only covers the very first paint. */}
              <CellThumb rec={rec} />
              <span className="cell-meta">
                {loc && (
                  <span className="cell-loc">
                    <MapPin size={10} /> {loc}
                  </span>
                )}
                <span className="cell-when">{cellWhen(rec.createdAt)}</span>
              </span>
              {rec.kind === "video" && (
                <span className="badge">
                  <Play size={9} /> {fmtDur(rec.duration)}
                  {frameCounts.has(rec.id) && (
                    <>
                      {" · "}
                      <Layers size={9} /> {(frameCounts.get(rec.id) ?? 0) + 1}
                    </>
                  )}
                </span>
              )}
              {rec.kind === "photo" && rec.backfill === "pending" && (
                <span className="badge" title="Address will be added when online">
                  <RefreshCw size={10} />
                </span>
              )}
              {selecting && (
                <span className="sel-tick" data-on={picked} aria-hidden>
                  {picked && <Check size={13} strokeWidth={3} />}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* bulk actions — only ever visible with something selected */}
      {selecting && (
        <div className="sel-bar">
          <span className="sel-count">
            {sel.size} selected
          </span>
          <button
            className="pill-action"
            disabled={busy}
            onClick={() => setTagDraft("")}
          >
            <TagIcon size={18} />
            <span>Tag</span>
          </button>
          <button
            className="pill-action danger"
            disabled={busy}
            onClick={() => setConfirmDelete(true)}
          >
            <Trash2 size={18} />
            <span>Delete</span>
          </button>
        </div>
      )}

      {tagDraft !== null && (
        <div className="modal-scrim" onClick={() => setTagDraft(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>Tag {sel?.size} item{sel?.size === 1 ? "" : "s"}</h2>
            <p>
              Separate several tags with commas. Existing tags are kept.
            </p>
            <input
              autoFocus
              placeholder="e.g. pothole, ward 173, urgent"
              value={tagDraft}
              onChange={(e) => setTagDraft(e.target.value)}
              onKeyDown={blurOnEnter}
              style={{ marginTop: 10 }}
            />
            <div style={{ display: "flex", gap: 10, marginTop: 14 }}>
              <button
                className="ghost-btn"
                style={{ flex: 1 }}
                onClick={() => setTagDraft(null)}
              >
                Cancel
              </button>
              <button
                className="primary-btn"
                style={{ flex: 1 }}
                disabled={busy || !tagDraft.trim()}
                onClick={() => void applyTags()}
              >
                Add tags
              </button>
            </div>
          </div>
        </div>
      )}

      {confirmDelete && (
        <div className="modal-scrim" onClick={() => setConfirmDelete(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>Delete {sel?.size} item{sel?.size === 1 ? "" : "s"}?</h2>
            <p>They will be removed permanently from this device.</p>
            <div style={{ display: "flex", gap: 10, marginTop: 14 }}>
              <button
                className="ghost-btn"
                style={{ flex: 1 }}
                onClick={() => setConfirmDelete(false)}
              >
                Cancel
              </button>
              <button
                className="primary-btn"
                style={{ flex: 1, background: "var(--danger)", color: "#fff" }}
                disabled={busy}
                onClick={() => void deleteSelected()}
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </Screen>
  );
}
