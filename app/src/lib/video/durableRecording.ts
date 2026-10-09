/**
 * A recording reaches storage while it is being made.
 *
 * Every MediaRecorder chunk used to be pushed onto an in-memory array and
 * written nowhere until Stop. A ten-minute recording is about a gigabyte,
 * so the phone held it all — and if the WebView was killed (memory,
 * thermal, the user switching apps, the OS reclaiming it) the whole
 * recording went with it. Motorola users reported exactly that: long
 * recordings ending with the app quitting or freezing and the video lost.
 * For an app whose purpose is evidence, losing the video is the worst
 * failure it has.
 *
 * Now each chunk is written to IndexedDB the moment it arrives — IDB
 * writes happen off the main thread, so this costs the compositor
 * nothing — and the in-memory list is gone. Stop assembles the file from
 * storage as a lazy composition of the stored chunks, which the browser
 * keeps on disk.
 *
 * And if Stop never comes, the chunks are still there. On the next
 * launch, every recording that was never finished is rebuilt from them
 * — up to its last complete fragment (see remux.ts) — and saved like any
 * other, marked as recovered.
 */
import { db, kvGet, kvSet } from "../db";
import type { WatermarkConfig, WatermarkData } from "../../types";

export interface RecordingSession {
  id: string;
  mimeType: string;
  startedAt: number;
  /** when the last chunk was durably written — the recovered duration */
  lastChunkAt: number;
  chunks: number;
  width: number;
  height: number;
  /** watermark data at the start: a recovered recording has no Stop */
  data: WatermarkData;
  config: WatermarkConfig;
  liveBlur?: boolean;
  blurBurned?: boolean;
  watermarkBurned?: boolean;
}

const SESSION = "rec-session:";
const prefix = (id: string) => `rec:${id}/`;
// zero-padded so key order IS chunk order
const chunkKey = (id: string, seq: number) => `${prefix(id)}${String(seq).padStart(7, "0")}`;
const range = (id: string) => IDBKeyRange.bound(prefix(id), `${prefix(id)}￿`);

/** Sessions recording right now in this page — recovery must never touch
 *  one, or it would rebuild and delete a recording still in progress. */
const active = new Set<string>();

export class DurableRecording {
  private seq = 0;
  private writes = new Set<Promise<void>>();
  private failed = false;
  readonly session: RecordingSession;

  private constructor(session: RecordingSession) {
    this.session = session;
  }

  static async begin(session: RecordingSession): Promise<DurableRecording> {
    active.add(session.id);
    await kvSet(SESSION + session.id, session);
    return new DurableRecording(session);
  }

  /** Durably store one MediaRecorder chunk. Never awaited by the caller:
   *  it must not hold up the next frame. */
  append(chunk: Blob): void {
    if (!chunk.size) return;
    const seq = this.seq++;
    const w = (async () => {
      const d = await db();
      await d.put("blobs", chunk, chunkKey(this.session.id, seq));
      // bookkeeping for recovery: how long the stored part runs
      this.session.lastChunkAt = Date.now();
      this.session.chunks = seq + 1;
      await kvSet(SESSION + this.session.id, this.session);
    })()
      .catch(() => {
        // storage full or unavailable. The recording continues; Stop will
        // tell the user the file may be incomplete rather than pretend.
        this.failed = true;
      })
      .finally(() => this.writes.delete(w));
    this.writes.add(w);
  }

  /** True if any chunk could not be stored. */
  get incomplete(): boolean {
    return this.failed;
  }

  /** Every stored chunk, as one lazily composed Blob. */
  async assemble(): Promise<Blob> {
    await Promise.allSettled(this.writes);
    return assembleStored(this.session.id, this.session.mimeType);
  }

  /** Remove the chunks and the session — only once the finished file is
   *  safely stored somewhere else. */
  async discard(): Promise<void> {
    active.delete(this.session.id);
    await discardStored(this.session.id);
  }

  /** Stop treating this as live without deleting anything: whatever
   *  happens next, recovery can still find it. */
  release(): void {
    active.delete(this.session.id);
  }
}

export async function assembleStored(id: string, mimeType: string): Promise<Blob> {
  const parts = (await (await db()).getAll("blobs", range(id))) as Blob[];
  return new Blob(parts, { type: mimeType.split(";")[0] });
}

export async function discardStored(id: string): Promise<void> {
  const d = await db();
  await d.delete("blobs", range(id));
  await d.delete("kv", SESSION + id);
}

/** Recordings that were started and never finished — none of them live. */
export async function unfinishedRecordings(): Promise<RecordingSession[]> {
  const keys = (await (await db()).getAllKeys("kv")) as string[];
  const out: RecordingSession[] = [];
  for (const k of keys) {
    if (typeof k !== "string" || !k.startsWith(SESSION)) continue;
    const s = await kvGet<RecordingSession>(k);
    if (s && !active.has(s.id)) out.push(s);
  }
  return out.sort((a, b) => a.startedAt - b.startedAt);
}
