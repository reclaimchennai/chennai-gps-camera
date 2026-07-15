/**
 * IndexedDB persistence via `idb`.
 *
 * Stores:
 *  - media:   PhotoRecord / VideoRecord metadata (key: id)
 *  - blobs:   binary payloads, keyed `${id}/${variant}`
 *             variants: final (watermarked JPEG / exported video),
 *             raw (un-watermarked original kept until backfill),
 *             thumb (small JPEG preview), source (recorded raw video)
 *  - kv:      settings, watermark config, profile, geodata cache
 */
import { openDB, type IDBPDatabase, type DBSchema } from "idb";
import type { MediaRecord } from "../types";

interface CamDB extends DBSchema {
  media: {
    key: string;
    value: MediaRecord;
    indexes: { "by-created": number };
  };
  blobs: { key: string; value: Blob };
  kv: { key: string; value: unknown };
}

let dbPromise: Promise<IDBPDatabase<CamDB>> | null = null;

export function db(): Promise<IDBPDatabase<CamDB>> {
  if (!dbPromise) {
    dbPromise = openDB<CamDB>("chennai-gps-cam", 1, {
      upgrade(d) {
        const media = d.createObjectStore("media", { keyPath: "id" });
        media.createIndex("by-created", "createdAt");
        d.createObjectStore("blobs");
        d.createObjectStore("kv");
      },
    });
  }
  return dbPromise;
}

// ---- media ---------------------------------------------------------

export async function putMedia(rec: MediaRecord): Promise<void> {
  await (await db()).put("media", rec);
}

export async function getMedia(id: string): Promise<MediaRecord | undefined> {
  return (await db()).get("media", id);
}

export async function listMedia(): Promise<MediaRecord[]> {
  const all = await (await db()).getAllFromIndex("media", "by-created");
  return all.reverse(); // newest first
}

export async function deleteMedia(id: string): Promise<void> {
  const d = await db();
  await d.delete("media", id);
  const tx = d.transaction("blobs", "readwrite");
  for (const variant of ["final", "raw", "thumb", "source"]) {
    await tx.store.delete(`${id}/${variant}`);
  }
  await tx.done;
}

// ---- blobs ---------------------------------------------------------

export type BlobVariant = "final" | "raw" | "thumb" | "source";

export async function putBlob(
  id: string,
  variant: BlobVariant,
  blob: Blob
): Promise<void> {
  await (await db()).put("blobs", blob, `${id}/${variant}`);
}

export async function getBlob(
  id: string,
  variant: BlobVariant
): Promise<Blob | undefined> {
  return (await db()).get("blobs", `${id}/${variant}`);
}

export async function deleteBlob(
  id: string,
  variant: BlobVariant
): Promise<void> {
  await (await db()).delete("blobs", `${id}/${variant}`);
}

// ---- kv ---------------------------------------------------------------

export async function kvGet<T>(key: string): Promise<T | undefined> {
  return (await (await db()).get("kv", key)) as T | undefined;
}

export async function kvSet(key: string, value: unknown): Promise<void> {
  await (await db()).put("kv", value, key);
}

export function newId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
