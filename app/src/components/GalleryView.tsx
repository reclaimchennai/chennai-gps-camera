import { useEffect, useMemo, useState } from "react";
import { Play, RefreshCw, Search, X, MapPin, Layers, Map as MapIcon, LayoutGrid } from "lucide-react";
import { Screen } from "./ui";
import { listMedia, getBlob } from "../lib/db";
import type { MediaRecord } from "../types";
import { navigate } from "../nav";
import { fmtWard } from "../lib/geo/format";
import { usePeek } from "./peek";

interface Cell {
  rec: MediaRecord;
  url: string | null;
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
  const [cells, setCells] = useState<Cell[] | null>(null);
  const [query, setQuery] = useState("");
  const [chip, setChip] = useState<Chip>("all");
  // ids the backfill queue just upgraded — briefly highlighted
  const [flashIds, setFlashIds] = useState<Set<string>>(new Set());
  const { bind: bindPeek, layer: peekLayer } = usePeek();

  useEffect(() => {
    let cancelled = false;
    const urls: string[] = [];
    const load = async () => {
      const items = await listMedia();
      const loaded = await Promise.all(
        items.map(async (rec) => {
          const t = await getBlob(rec.id, "thumb");
          const url = t ? URL.createObjectURL(t) : null;
          if (url) urls.push(url);
          return { rec, url };
        })
      );
      if (!cancelled) setCells(loaded);
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
      urls.forEach((u) => URL.revokeObjectURL(u));
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

  return (
    <Screen
      title="Gallery"
      actions={
        <span style={{ marginLeft: "auto", display: "flex", gap: 4 }}>
          <button
            className="icon-btn"
            onClick={() => navigate("/gallery/collage")}
            aria-label="Make a collage"
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
        {visible?.map(({ rec, url }) => {
          const loc = cellLocation(rec);
          return (
            <button
              key={rec.id}
              className={`gallery-cell${flashIds.has(rec.id) ? " updated" : ""}`}
              {...bindPeek(rec)}
              onClick={() =>
                navigate(
                  rec.kind === "video" && frameCounts.has(rec.id)
                    ? `/gallery/group/${rec.id}`
                    : `/media/${rec.id}`
                )
              }
            >
              {url ? (
                <img src={url} alt="" loading="lazy" />
              ) : (
                <Play size={22} style={{ margin: "auto" }} />
              )}
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
            </button>
          );
        })}
      </div>
      {peekLayer}
    </Screen>
  );
}
