/**
 * Profile + social-handles form, embedded inline wherever needed
 * (expands under the "Social handles" toggle in the watermark editor).
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Plus, X, ChevronDown, Globe } from "lucide-react";

/** Brand glyphs (lucide dropped its brand icons) — classic outline paths
 *  drawn in the same 24×24 stroke style so they sit next to lucide. */
function Brand({ size = 15, children }: { size?: number; children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {children}
    </svg>
  );
}

const Instagram = ({ size = 15 }: { size?: number }) => (
  <Brand size={size}>
    <rect width="20" height="20" x="2" y="2" rx="5" ry="5" />
    <path d="M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37z" />
    <line x1="17.5" x2="17.51" y1="6.5" y2="6.5" />
  </Brand>
);

const Facebook = ({ size = 15 }: { size?: number }) => (
  <Brand size={size}>
    <path d="M18 2h-3a5 5 0 0 0-5 5v3H7v4h3v8h4v-8h3l1-4h-4V7a1 1 0 0 1 1-1h3z" />
  </Brand>
);

const Youtube = ({ size = 15 }: { size?: number }) => (
  <Brand size={size}>
    <path d="M2.5 17a24.12 24.12 0 0 1 0-10 2 2 0 0 1 1.4-1.4 49.56 49.56 0 0 1 16.2 0A2 2 0 0 1 21.5 7a24.12 24.12 0 0 1 0 10 2 2 0 0 1-1.4 1.4 49.55 49.55 0 0 1-16.2 0A2 2 0 0 1 2.5 17" />
    <path d="m10 15 5-3-5-3z" />
  </Brand>
);

const Linkedin = ({ size = 15 }: { size?: number }) => (
  <Brand size={size}>
    <path d="M16 8a6 6 0 0 1 6 6v7h-4v-7a2 2 0 0 0-2-2 2 2 0 0 0-2 2v7h-4V8h4v2a6 6 0 0 1 2-2z" />
    <rect width="4" height="12" x="2" y="9" />
    <circle cx="4" cy="4" r="2" />
  </Brand>
);

const Reddit = ({ size = 15 }: { size?: number }) => (
  <Brand size={size}>
    <circle cx="12" cy="13" r="9" />
    <circle cx="8.5" cy="13" r="1.2" fill="currentColor" stroke="none" />
    <circle cx="15.5" cy="13" r="1.2" fill="currentColor" stroke="none" />
    <path d="M9 16.5c.9.6 2 .9 3 .9s2.1-.3 3-.9" />
    <circle cx="18.5" cy="8" r="1.6" />
    <path d="M15.5 5.2 17 3l1.5 1.4" />
    <path d="M12 4V3" />
  </Brand>
);
import { Toggle } from "./ui";
import { useSettingsStore } from "../store";
import { circleCrop } from "../lib/img";
import { getBlob, putBlob, deleteBlob, newId } from "../lib/db";
import type { SocialHandle } from "../types";

/** Bold X glyph for the platform formerly known as Twitter. */
function XIcon({ size = 15 }: { size?: number }) {
  return (
    <span
      style={{
        fontSize: size - 1,
        fontWeight: 800,
        lineHeight: 1,
        width: size,
        display: "inline-grid",
        placeItems: "center",
      }}
    >
      𝕏
    </span>
  );
}

const PLATFORMS: { name: string; icon: ReactNode }[] = [
  { name: "Instagram", icon: <Instagram size={16} /> },
  { name: "X", icon: <XIcon size={16} /> },
  { name: "Facebook", icon: <Facebook size={16} /> },
  { name: "YouTube", icon: <Youtube size={16} /> },
  { name: "LinkedIn", icon: <Linkedin size={16} /> },
  { name: "Reddit", icon: <Reddit size={16} /> },
  { name: "Other", icon: <Globe size={16} /> },
];

/** Platform picker. The options open as a fixed bottom-sheet rather than
 *  an absolutely-positioned menu, because the menu used to be clipped by
 *  the scrollable editor card — users could only ever see the first few
 *  platforms. A sheet escapes every ancestor's overflow and scrolls. */
function PlatformSelect({
  value,
  onChange,
}: {
  value: string;
  onChange: (p: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const current = PLATFORMS.find((p) => p.name === value) ?? PLATFORMS[6];
  return (
    <div className="pf-select">
      <button
        className="pf-select-btn"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        {current.icon}
        <span className="pf-select-label">{current.name}</span>
        <ChevronDown size={14} />
      </button>
      {open && (
        <div className="sheet-scrim" onClick={() => setOpen(false)}>
          <div
            className="sheet"
            role="listbox"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="sheet-handle" />
            <div className="sheet-title">Platform</div>
            {PLATFORMS.map((p) => (
              <button
                key={p.name}
                className="sheet-option"
                role="option"
                aria-selected={p.name === value}
                data-active={p.name === value}
                onClick={() => {
                  onChange(p.name);
                  setOpen(false);
                }}
              >
                <span className="sheet-option-icon">{p.icon}</span>
                {p.name}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default function ProfileFields() {
  const profile = useSettingsStore((s) => s.profile);
  const setProfile = useSettingsStore((s) => s.setProfile);
  const [photoUrl, setPhotoUrl] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let url: string | null = null;
    if (profile.hasPhoto) {
      void getBlob("profile", "raw").then((b) => {
        if (b) {
          url = URL.createObjectURL(b);
          setPhotoUrl(url);
        }
      });
    } else {
      setPhotoUrl(null);
    }
    return () => {
      if (url) URL.revokeObjectURL(url);
    };
  }, [profile.hasPhoto]);

  const onPhotoPicked = async (file: File) => {
    const cropped = await circleCrop(file, 256);
    await putBlob("profile", "raw", cropped);
    setProfile({ ...profile, hasPhoto: true });
  };

  const removePhoto = async () => {
    await deleteBlob("profile", "raw");
    setProfile({ ...profile, hasPhoto: false });
  };

  const setHandle = (id: string, patch: Partial<SocialHandle>) => {
    setProfile({
      ...profile,
      handles: profile.handles.map((h) =>
        h.id === id ? { ...h, ...patch } : h
      ),
    });
  };

  return (
    <div className="profile-fields">
      <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
        <button
          className="avatar-lg"
          style={{ width: 60, height: 60 }}
          onClick={() => fileRef.current?.click()}
          aria-label="Profile photo"
        >
          {photoUrl ? <img src={photoUrl} alt="Profile" /> : <Plus size={22} />}
        </button>
        <div style={{ flex: 1 }}>
          <div className="hint">
            Photo shows in the strip when “Profile photo” is on.
          </div>
          {profile.hasPhoto && (
            <button
              className="danger"
              style={{ fontSize: 13, marginTop: 4 }}
              onClick={() => void removePhoto()}
            >
              Remove photo
            </button>
          )}
        </div>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void onPhotoPicked(f);
            e.target.value = "";
          }}
        />
      </div>

      {profile.handles.map((h) => (
        <div className="handle-row" key={h.id}>
          <PlatformSelect
            value={h.platform}
            onChange={(p) => setHandle(h.id, { platform: p })}
          />
          <input
            style={{ flex: 1 }}
            placeholder="handle"
            value={h.handle}
            onChange={(e) => setHandle(h.id, { handle: e.target.value })}
          />
          <Toggle on={h.show} onChange={(v) => setHandle(h.id, { show: v })} />
          <button
            className="danger"
            aria-label="Remove"
            onClick={() =>
              setProfile({
                ...profile,
                handles: profile.handles.filter((x) => x.id !== h.id),
              })
            }
          >
            <X size={17} />
          </button>
        </div>
      ))}

      <button
        className="ghost-btn"
        style={{ width: "100%" }}
        onClick={() =>
          setProfile({
            ...profile,
            handles: [
              ...profile.handles,
              { id: newId(), platform: "Instagram", handle: "", show: true },
            ],
          })
        }
      >
        <Plus size={15} style={{ verticalAlign: "-2px", marginRight: 6 }} />
        Add handle
      </button>
    </div>
  );
}
