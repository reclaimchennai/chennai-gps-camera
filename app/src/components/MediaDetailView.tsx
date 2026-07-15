import { useEffect, useState } from "react";
import {
  ArrowLeft,
  Info,
  Share2,
  PencilLine,
  Download,
  Trash2,
  Tag,
  X,
} from "lucide-react";
import { getMedia, getBlob, deleteMedia, putMedia } from "../lib/db";
import type { MediaRecord } from "../types";
import { navigate, goBack } from "../nav";
import { shareBlob, downloadBlob, suggestedName } from "../lib/share";
import { fmtCoordsLine, fmtDateLine, fmtWard, fmtZone } from "../lib/geo/format";

export default function MediaDetailView({ id }: { id: string }) {
  const [rec, setRec] = useState<MediaRecord | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [info, setInfo] = useState(false);
  const [tagDraft, setTagDraft] = useState<string | null>(null);

  useEffect(() => {
    let objectUrl: string | null = null;
    void (async () => {
      const r = await getMedia(id);
      if (!r) {
        goBack();
        return;
      }
      setRec(r);
      const variant = r.kind === "photo" ? "final" : "source";
      // exported videos store their burned copy as `final`
      const blob =
        (r.kind === "video" && (await getBlob(id, "final"))) ||
        (await getBlob(id, variant));
      if (blob) {
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      }
    })();
    return () => {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [id]);

  if (!rec) return null;

  const onShare = async () => {
    const blob =
      (rec.kind === "video" && (await getBlob(id, "final"))) ||
      (await getBlob(id, rec.kind === "photo" ? "final" : "source"));
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
      const parts = [jd.corporation];
      if (jd.scope === "avadi") parts.push("Ward: not yet available");
      else if (jd.ward) parts.push(`Ward ${fmtWard(jd.ward)}`);
      if (jd.zone && jd.scope !== "avadi") parts.push(fmtZone(jd.zone));
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
      (rec.kind === "video" && (await getBlob(id, "final"))) ||
      (await getBlob(id, rec.kind === "photo" ? "final" : "source"));
    if (blob)
      downloadBlob(blob, suggestedName(rec.kind, rec.createdAt, blob.type));
  };

  const onDelete = async () => {
    await deleteMedia(id);
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

  return (
    <div className="screen" style={{ position: "fixed", inset: 0, zIndex: 10, background: "var(--bg)" }}>
      <header className="screen-header">
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

      <div className="media-stage">
        {url && rec.kind === "photo" && <img src={url} alt="" />}
        {url && rec.kind === "video" && (
          <video src={url} controls playsInline />
        )}
      </div>

      <div className="tag-strip">
        <Tag size={14} />
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
          <button className="tag-add" onClick={() => setTagDraft("")}>
            + Add tag
          </button>
        )}
      </div>

      <div className="media-actions">
        <button className="media-action" onClick={() => void onShare()}>
          <Share2 size={20} />
          <span>Share</span>
        </button>
        <button
          className="media-action"
          onClick={() =>
            navigate(rec.kind === "photo" ? `/edit/${id}` : `/video-edit/${id}`)
          }
        >
          <PencilLine size={20} />
          <span>{rec.kind === "photo" ? "Annotate" : "Edit"}</span>
        </button>
        <button className="media-action" onClick={() => void onDownload()}>
          <Download size={20} />
          <span>Save</span>
        </button>
        <button
          className="media-action danger"
          onClick={() => setConfirmDelete(true)}
        >
          <Trash2 size={20} />
          <span>Delete</span>
        </button>
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
                  {j.scope === "avadi"
                    ? " · Ward: not yet available"
                    : j.ward
                      ? ` · Ward ${fmtWard(j.ward)}${j.zone ? ` · ${fmtZone(j.zone)}` : ""}`
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
