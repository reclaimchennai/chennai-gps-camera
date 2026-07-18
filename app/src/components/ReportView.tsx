/**
 * Report an issue → Telegram. A description plus an optional screenshot.
 * Submitting is fire-and-forget: the send runs in the background so the
 * user isn't blocked, and they're returned to Settings immediately.
 */
import { useEffect, useRef, useState } from "react";
import { ImagePlus, Send, X } from "lucide-react";
import { Screen } from "./ui";
import { goBack } from "../nav";
import { sendReport, reportingEnabled } from "../lib/report";

export default function ReportView() {
  const [text, setText] = useState("");
  const [shot, setShot] = useState<Blob | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    return () => {
      if (preview) URL.revokeObjectURL(preview);
    };
  }, [preview]);

  const pick = (file: File) => {
    if (preview) URL.revokeObjectURL(preview);
    setShot(file);
    setPreview(URL.createObjectURL(file));
  };

  const clearShot = () => {
    if (preview) URL.revokeObjectURL(preview);
    setShot(null);
    setPreview(null);
  };

  const onSubmit = () => {
    if (!text.trim() && !shot) return;
    // fire-and-forget: the request keeps running while the app is open,
    // so the user never waits on the upload
    void sendReport(text, shot);
    setSent(true);
    window.setTimeout(() => goBack(), 900);
  };

  if (!reportingEnabled()) {
    return (
      <Screen title="Report an issue">
        <div className="empty-note">
          Issue reporting isn't configured in this build.
        </div>
      </Screen>
    );
  }

  return (
    <Screen title="Report an issue">
      <div className="card" style={{ padding: 14 }}>
        <div className="label" style={{ marginBottom: 6 }}>What went wrong?</div>
        <textarea
          className="report-text"
          rows={5}
          placeholder="Describe the issue: what you did, what you expected, what happened…"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />

        {preview ? (
          <div className="report-shot">
            <img src={preview} alt="screenshot" loading="lazy" />
            <button className="report-shot-x" aria-label="Remove screenshot" onClick={clearShot}>
              <X size={16} />
            </button>
          </div>
        ) : (
          <button
            className="ghost-btn"
            style={{ width: "100%", marginTop: 10 }}
            onClick={() => fileRef.current?.click()}
          >
            <ImagePlus size={16} style={{ verticalAlign: "-3px", marginRight: 6 }} />
            Attach a screenshot (optional)
          </button>
        )}

        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) pick(f);
            e.target.value = "";
          }}
        />

        <button
          className="primary-btn"
          style={{ width: "100%", marginTop: 14 }}
          disabled={sent || (!text.trim() && !shot)}
          onClick={onSubmit}
        >
          <Send size={16} style={{ verticalAlign: "-3px", marginRight: 6 }} />
          {sent ? "Thanks, sending…" : "Send report"}
        </button>

        <p className="hint" style={{ marginTop: 10, lineHeight: 1.5 }}>
          Your report goes to the project's issue channel on Telegram. It's
          sent in the background, so you can keep using the app. Device and
          build details are attached automatically; nothing from your
          gallery is included unless you attach it above.
        </p>
      </div>
    </Screen>
  );
}
