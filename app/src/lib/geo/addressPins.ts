/**
 * Addresses the photographer chose by hand, remembered by place.
 *
 * Coordinates cannot tell two tenants of one building apart, and no
 * geocoder can either: it is guessing from the same coordinates. The
 * person standing there knows. So the card's address can be chosen —
 * from what is nearby, from a search, or typed — and the choice is kept
 * for the spot: every later photo within PIN_RADIUS_M of it uses it,
 * which is what someone reporting from the same building week after week
 * needs.
 *
 * A chosen address is a label a person picked, not a measurement, and a
 * photo used in a complaint must not pass one off as the other: the card
 * says so on its own line (render.ts), and the coordinates, ward and
 * police rows stay exactly as measured.
 *
 * Kept on this device only, in the app's database, and carried in
 * backups. Held in memory as well, because the live card asks on every
 * redraw.
 */
import { kvGet, kvSet, newId } from "../db";

export interface AddressPin {
  id: string;
  /** where the photographer stood when choosing */
  lat: number;
  lng: number;
  /** the place's own name — a building, office or shop — for the title */
  title?: string;
  address: string;
  /** where it came from, for the list in Settings */
  source: "nearby" | "search" | "typed";
  createdAt: number;
}

/** How far a choice carries: the user's own "50 metres". */
export const PIN_RADIUS_M = 50;
/**
 * A new choice replaces any made within this distance — the same spot
 * chosen again. Farther ones stay: the next building over keeps its own.
 */
const SAME_SPOT_M = 20;
const KEY = "address-pins";

let pins: AddressPin[] = [];
let version = 0;
const listeners = new Set<() => void>();

/** Bumped on every change — the live card's redraw check includes it. */
export function addressPinsVersion(): number {
  return version;
}

export function metresBetween(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number }
): number {
  const dLat = (a.lat - b.lat) * 111_320;
  const dLng = (a.lng - b.lng) * 111_320 * Math.cos((a.lat * Math.PI) / 180);
  return Math.hypot(dLat, dLng);
}

export async function loadAddressPins(): Promise<void> {
  try {
    const stored = await kvGet<AddressPin[]>(KEY);
    pins = Array.isArray(stored) ? stored.filter((p) => p && typeof p.address === "string") : [];
  } catch {
    pins = [];
  }
  notify();
}

/** The chosen address for a spot: the nearest pin within PIN_RADIUS_M. */
export function pinNear(at: { lat: number; lng: number } | null | undefined): AddressPin | null {
  if (!at) return null;
  let best: AddressPin | null = null;
  let bestD = Infinity;
  for (const p of pins) {
    const d = metresBetween(at, p);
    if (d <= PIN_RADIUS_M && d < bestD) {
      best = p;
      bestD = d;
    }
  }
  return best;
}

export function allAddressPins(): AddressPin[] {
  return [...pins].sort((a, b) => b.createdAt - a.createdAt);
}

export async function saveAddressPin(
  pin: Omit<AddressPin, "id" | "createdAt">
): Promise<AddressPin> {
  const saved: AddressPin = {
    ...pin,
    address: pin.address.trim(),
    title: pin.title?.trim() || undefined,
    id: newId(),
    createdAt: Date.now(),
  };
  pins = [...pins.filter((p) => metresBetween(p, saved) > SAME_SPOT_M), saved];
  await persist();
  return saved;
}

export async function removeAddressPin(id: string): Promise<void> {
  pins = pins.filter((p) => p.id !== id);
  await persist();
}

/** For a restore: replace the whole set. */
export async function replaceAddressPins(next: AddressPin[]): Promise<void> {
  pins = next.filter((p) => p && typeof p.address === "string");
  await persist();
}

/** Called whenever the set changes — the live card redraws on it. */
export function onAddressPinsChange(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

async function persist(): Promise<void> {
  notify();
  await kvSet(KEY, pins);
}

function notify(): void {
  version++;
  for (const cb of listeners) cb();
  window.dispatchEvent(new Event("gpscam:redraw-overlay"));
}
