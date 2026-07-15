import { useEffect, useMemo, useState } from "react";
import { Play, RefreshCw, Search, X, MapPin } from "lucide-react";
import { Screen } from "./ui";
import { listMedia, getBlob } from "../lib/db";
import type { MediaRecord } from "../types";
import { navigate } from "../nav";
import { fmtWard } from "../lib/geo/format";

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

  useEffect(() => {
    let cancelled = false;
    const urls: string[] = [];
    void (async () => {
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
    })();
    return () => {
      cancelled = true;
      urls.forEach((u) => URL.revokeObjectURL(u));
    };
  }, []);

  const allTags = useMemo(() => {
    const tags = new Set<string>();
    for (const c of cells ?? []) for (const t of c.rec.tags ?? []) tags.add(t);
    return [...tags].sort();
  }, [cells]);

  const visible = useMemo(() => {
    if (!cells) return null;
    const q = query.trim().toLowerCase();
    return cells.filter(({ rec }) => {
      if (chip === "photos" && rec.kind !== "photo") return false;
      if (chip === "videos" && rec.kind !== "video") return false;
      if (chip.startsWith("tag:") && !(rec.tags ?? []).includes(chip.slice(4)))
        return false;
      if (q && !haystack(rec).includes(q)) return false;
      return true;
    });
  }, [cells, query, chip]);

  const fmtDur = (s: number) =>
    `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;

  return (
    <Screen title="Gallery">
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
              className="gallery-cell"
              onClick={() => navigate(`/media/${rec.id}`)}
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
    </Screen>
  );
}
