/**
 * Profile + social-handles form, embedded inline wherever needed
 * (expands under the "Social handles" toggle in the watermark editor).
 */
import { useEffect, useRef, useState } from "react";
import { Plus, X } from "lucide-react";
import { Toggle } from "./ui";
import { useSettingsStore } from "../store";
import { circleCrop } from "../lib/img";
import { getBlob, putBlob, deleteBlob, newId } from "../lib/db";
import type { SocialHandle } from "../types";

const PLATFORMS = ["Instagram", "X", "Facebook", "YouTube", "LinkedIn", "Other"];

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
          <select
            style={{ width: 105 }}
            value={h.platform}
            onChange={(e) => setHandle(h.id, { platform: e.target.value })}
          >
            {PLATFORMS.map((p) => (
              <option key={p}>{p}</option>
            ))}
          </select>
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
