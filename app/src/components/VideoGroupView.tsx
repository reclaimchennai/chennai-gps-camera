/**
 * Folder-in-folder gallery view: one recorded video together with every
 * frame photo grabbed from it (camera button in the player). The video
 * leads the grid; frames follow in capture order. Tapping any item opens
 * the normal media detail view.
 */
import { useEffect, useState } from "react";
import { Play, Camera, Car } from "lucide-react";
import { Screen } from "./ui";
import { listMedia, getBlob } from "../lib/db";
import type { MediaRecord } from "../types";
import { navigate } from "../nav";
import { queuePlateScan } from "../lib/detect/plateQueue";
import { usePeek } from "./peek";

interface Cell {
  rec: MediaRecord;
  url: string | null;
}

export default function VideoGroupView({ id }: { id: string }) {
  const [cells, setCells] = useState<Cell[] | null>(null);
  const { bind: bindPeek, layer: peekLayer } = usePeek();

  useEffect(() => {
    let cancelled = false;
    const urls: string[] = [];
    const load = async () => {
      const items = await listMedia();
      const video = items.find((m) => m.id === id && m.kind === "video");
      const frames = items
        .filter((m) => m.kind === "photo" && m.sourceVideoId === id)
        .sort((a, b) => a.createdAt - b.createdAt);
      // retry plate scans that never completed (in-memory queue — lost if
      // the app closed before a slow first scan finished)
      for (const f of frames) {
        if (f.kind === "photo" && f.plates === undefined) queuePlateScan(f.id);
      }
      const group = video ? [video, ...frames] : frames;
      const loaded = await Promise.all(
        group.map(async (rec) => {
          const t = await getBlob(rec.id, "thumb");
          const url = t ? URL.createObjectURL(t) : null;
          if (url) urls.push(url);
          return { rec, url };
        })
      );
      if (!cancelled) setCells(loaded);
    };
    void load();
    // frames gain plates (OCR) after the fact — refresh in place
    const onUpdated = () => void load();
    window.addEventListener("gpscam:media-updated", onUpdated);
    return () => {
      cancelled = true;
      window.removeEventListener("gpscam:media-updated", onUpdated);
      urls.forEach((u) => URL.revokeObjectURL(u));
    };
  }, [id]);

  const fmtDur = (s: number) =>
    `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;

  return (
    <Screen title="Video & frames">
      {cells && cells.length === 0 && (
        <div className="empty-note">This video is gone.</div>
      )}
      <div className="gallery-grid">
        {cells?.map(({ rec, url }) => (
          <button
            key={rec.id}
            className="gallery-cell"
            {...bindPeek(rec)}
            onClick={() => navigate(`/media/${rec.id}`)}
          >
            {url ? (
              <img src={url} alt="" loading="lazy" />
            ) : (
              <Play size={22} style={{ margin: "auto" }} />
            )}
            {rec.kind === "video" ? (
              <span className="badge">
                <Play size={9} /> {fmtDur(rec.duration)}
              </span>
            ) : (
              <span className="badge">
                <Camera size={9} />
                {(rec.plates?.length ?? 0) > 0 && (
                  <>
                    {" "}
                    <Car size={9} /> {rec.plates!.length}
                  </>
                )}
              </span>
            )}
          </button>
        ))}
      </div>
      <div className="hint" style={{ padding: "10px 4px" }}>
        Frames you grab with the camera button in the video player collect
        here alongside their video.
      </div>
      {peekLayer}
    </Screen>
  );
}
