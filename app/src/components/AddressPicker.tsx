/**
 * "Address here" — the photographer chooses the card's address for this
 * spot (Settings → Advanced → Choose the address by hand).
 *
 * Coordinates cannot tell two tenants of one building apart, and neither
 * can any geocoder. So: the named places within 50 m from every source
 * the settings allow (geo/nearbyPlaces.ts), a search for one that did not
 * show up, and typing as the last resort — with whatever was chosen still
 * editable before it is kept. The choice is remembered for the spot
 * (geo/addressPins.ts) and the card says it was chosen.
 */
import { useEffect, useRef, useState } from "react";
import { MapPin, Search, X } from "lucide-react";
import { useLiveStore, useSettingsStore } from "../store";
import {
  PIN_RADIUS_M,
  pinNear,
  removeAddressPin,
  saveAddressPin,
  type AddressPin,
} from "../lib/geo/addressPins";
import {
  listLines,
  lookupsEnabled,
  nearbyCandidates,
  searchCandidates,
  SEARCH_USABLE_M,
  type PlaceCandidate,
} from "../lib/geo/nearbyPlaces";

const SOURCE_LABEL: Record<PlaceCandidate["source"], string> = {
  phone: "phone",
  osm: "OpenStreetMap",
  google: "Google",
};

type Choice =
  | { kind: "auto" }
  /** the choice already in effect here, open for editing */
  | { kind: "current" }
  | { kind: "place"; place: PlaceCandidate; from: "nearby" | "search" }
  | { kind: "typed" };

export default function AddressPicker({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  // the spot is where the photographer stood when they opened this — a
  // fix that drifts while they read the list must not move the choice
  const at = useRef(useLiveStore.getState().fix).current;
  const live = useLiveStore.getState();
  const lang = useSettingsStore((s) => s.watermark.language) ?? "en";
  const existing = useRef<AddressPin | null>(pinNear(at)).current;
  const canLook = lookupsEnabled();

  const [nearby, setNearby] = useState<PlaceCandidate[] | null>(canLook && at ? null : []);
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [found, setFound] = useState<PlaceCandidate[] | null>(null);
  const [choice, setChoice] = useState<Choice>(existing ? { kind: "current" } : { kind: "auto" });
  const [title, setTitle] = useState(existing?.title ?? "");
  const [address, setAddress] = useState(existing?.address ?? live.address ?? "");
  const [busy, setBusy] = useState(false);
  /**
   * Whether the current press began on the backdrop. The tap that opens
   * this sheet ends, on a touchscreen, in a click synthesized wherever the
   * finger was — which is now the backdrop, drawn under it a moment
   * earlier. Closing on any backdrop click shut the sheet the instant it
   * opened, on every phone. Only a press that starts on the backdrop
   * closes it.
   */
  const pressedBackdrop = useRef(false);

  useEffect(() => {
    if (!canLook || !at) return;
    let gone = false;
    void nearbyCandidates(at, lang).then((list) => {
      if (!gone) setNearby(list);
    });
    return () => {
      gone = true;
    };
  }, [at, canLook, lang]);

  const pick = (place: PlaceCandidate, from: "nearby" | "search") => {
    setChoice({ kind: "place", place, from });
    setTitle(place.title ?? "");
    // a name with no address of its own keeps the street address we have
    setAddress(place.address || live.address || "");
  };

  const runSearch = async () => {
    if (!at || !query.trim()) return;
    setSearching(true);
    try {
      setFound(await searchCandidates(query, at, lang));
    } finally {
      setSearching(false);
    }
  };

  const save = async () => {
    if (!at || busy) return;
    setBusy(true);
    try {
      if (choice.kind === "auto") {
        if (existing) {
          await removeAddressPin(existing.id);
          onSaved("Back to the automatic address here");
        }
      } else {
        // One choice per spot: whatever replaces the choice in effect here
        // replaces it outright, rather than leaving two a few metres apart
        // to win by turns as the fix wanders. An edit keeps its spot.
        if (existing) await removeAddressPin(existing.id);
        const spot = choice.kind === "current" && existing ? existing : at;
        await saveAddressPin({
          lat: spot.lat,
          lng: spot.lng,
          title: title,
          address: address,
          source:
            choice.kind === "place"
              ? choice.from
              : choice.kind === "current" && existing
                ? existing.source
                : "typed",
        });
        onSaved(`Address set for photos within ${PIN_RADIUS_M} m of here`);
      }
      onClose();
    } finally {
      setBusy(false);
    }
  };

  const editing = choice.kind !== "auto";
  const canSave =
    !!at && !busy && (choice.kind === "auto" ? !!existing : !!(title.trim() || address.trim()));
  const coarse = at?.accuracy != null && at.accuracy > PIN_RADIUS_M;

  const row = (c: PlaceCandidate, from: "nearby" | "search") => {
    const far = from === "search" && c.distance != null && c.distance > SEARCH_USABLE_M;
    const active = choice.kind === "place" && choice.place.key === c.key;
    const { name, line } = listLines(c);
    return (
      <button
        key={c.key}
        className="sheet-option addr-option"
        data-active={active}
        aria-pressed={active}
        disabled={far}
        onClick={() => pick(c, from)}
      >
        <span className="addr-main">
          <span className="addr-name">{name}</span>
          {line && <span className="addr-line">{line}</span>}
          {far && (
            <span className="addr-line addr-far">
              {formatDistance(c.distance)} away — too far to label a photo taken here
            </span>
          )}
        </span>
        <span className="addr-meta">
          {!far && c.distance != null && <span>{formatDistance(c.distance)}</span>}
          <span className="addr-src">{SOURCE_LABEL[c.source]}</span>
        </span>
      </button>
    );
  };

  return (
    <div
      className="sheet-scrim"
      onPointerDown={(e) => {
        pressedBackdrop.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        if (pressedBackdrop.current && e.target === e.currentTarget) onClose();
        pressedBackdrop.current = false;
      }}
    >
      <div
        className="sheet addr-sheet"
        role="dialog"
        aria-modal="true"
        aria-label="Address here"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sheet-handle" />
        <div className="addr-head">
          <div className="sheet-title">Address here</div>
          <button className="icon-btn" aria-label="Close" onClick={onClose}>
            <X size={18} />
          </button>
        </div>

        {!at ? (
          <p className="hint addr-note">Waiting for your location — a choice belongs to a spot.</p>
        ) : (
          coarse && (
            <p className="hint addr-note">
              Your location is only accurate to ±{Math.round(at.accuracy ?? 0)} m right now, so a choice
              may land on the wrong spot. Waiting for a better fix helps.
            </p>
          )
        )}

        {existing && (
          <button
            className="sheet-option addr-option"
            data-active={choice.kind === "current"}
            aria-pressed={choice.kind === "current"}
            onClick={() => {
              setChoice({ kind: "current" });
              setTitle(existing.title ?? "");
              setAddress(existing.address);
            }}
          >
            <span className="addr-main">
              <span className="addr-name">Your choice here</span>
              <span className="addr-line">
                {[existing.title, existing.address].filter(Boolean).join(" — ")}
              </span>
            </span>
          </button>
        )}

        <button
          className="sheet-option addr-option"
          data-active={choice.kind === "auto"}
          aria-pressed={choice.kind === "auto"}
          onClick={() => setChoice({ kind: "auto" })}
        >
          <span className="addr-main">
            <span className="addr-name">Automatic</span>
            <span className="addr-line">{live.address ?? "Looked up from your location"}</span>
          </span>
        </button>

        <div className="sheet-title addr-section">Within {PIN_RADIUS_M} m</div>
        {!canLook ? (
          <p className="hint addr-note">
            Address lookups are off in Settings, so nothing is looked up — search is off too. You
            can still type the address.
          </p>
        ) : nearby === null ? (
          <p className="hint addr-note" aria-live="polite">Looking around…</p>
        ) : nearby.length === 0 ? (
          <p className="hint addr-note">Nothing named nearby. Search for it, or type it below.</p>
        ) : (
          nearby.map((c) => row(c, "nearby"))
        )}

        {canLook && at && (
          <form
            className="addr-search"
            onSubmit={(e) => {
              e.preventDefault();
              void runSearch();
            }}
          >
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search a building or shop"
              aria-label="Search a building, office or shop near you"
            />
            <button className="ghost-btn" type="submit" disabled={searching || !query.trim()}>
              <Search size={16} /> {searching ? "…" : "Search"}
            </button>
          </form>
        )}
        {found &&
          (found.length ? (
            found.map((c) => row(c, "search"))
          ) : (
            <p className="hint addr-note">No match near you.</p>
          ))}

        <button
          className="sheet-option addr-option"
          data-active={choice.kind === "typed"}
          aria-pressed={choice.kind === "typed"}
          onClick={() => {
            setChoice({ kind: "typed" });
            // start from what is on the card now, which is usually most of it
            if (!title && !address) setAddress(live.address ?? "");
          }}
        >
          <span className="addr-main">
            <span className="addr-name">Type it myself</span>
          </span>
        </button>

        {editing && (
          <div className="addr-edit">
            <label>
              <span className="hint">Name — building, office or shop (optional)</span>
              <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={80} />
            </label>
            <label>
              <span className="hint">Address</span>
              <textarea
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                rows={3}
                maxLength={240}
              />
            </label>
          </div>
        )}

        <p className="hint addr-note">
          <MapPin size={13} /> Used for every photo within {PIN_RADIUS_M} m of this spot. The card
          says the address was chosen by you; coordinates, ward and police station stay as measured.
        </p>
        <button className="primary-btn addr-save" disabled={!canSave} onClick={() => void save()}>
          {choice.kind === "auto"
            ? existing
              ? "Use the automatic address here"
              : "Automatic is already in use"
            : "Use for this spot"}
        </button>
      </div>
    </div>
  );
}

function formatDistance(m: number | undefined): string {
  if (m == null) return "";
  return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`;
}
