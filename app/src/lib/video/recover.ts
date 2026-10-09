/**
 * Rebuild recordings the app never got to finish.
 *
 * Runs once at launch. Every recording that was started and never saved
 * — the app killed mid-recording, or mid-save — still has its chunks in
 * storage (durableRecording.ts). Each is rebuilt up to its last complete
 * fragment and saved like any other recording, marked as recovered.
 *
 * Three strikes, never deletion: a recording that cannot be rebuilt after
 * three launches is handed to the device exactly as stored — an
 * unprocessed fragmented MP4 still plays in most players — rather than
 * retried forever or thrown away. It is evidence; losing it is the one
 * outcome this exists to prevent.
 */
import { kvSet } from "../db";
import { saveBlobToDevice, suggestedName } from "../share";
import {
  assembleStored,
  discardStored,
  unfinishedRecordings,
  type RecordingSession,
} from "./durableRecording";
import { saveRecording } from "./saveRecording";

const MAX_ATTEMPTS = 3;

export async function recoverInterruptedRecordings(): Promise<number> {
  let recovered = 0;
  let sessions: (RecordingSession & { attempts?: number })[] = [];
  try {
    sessions = await unfinishedRecordings();
  } catch {
    return 0;
  }
  for (const s of sessions) {
    const attempts = (s.attempts ?? 0) + 1;
    try {
      // count the attempt BEFORE trying, so a rebuild that takes the app
      // down with it still counts towards the limit
      await kvSet(`rec-session:${s.id}`, { ...s, attempts });
      const raw = await assembleStored(s.id, s.mimeType);
      if (raw.size < 1024) {
        await discardStored(s.id); // started and stopped before any data
        continue;
      }
      if (attempts > MAX_ATTEMPTS) {
        await saveBlobToDevice(raw, suggestedName("video", s.startedAt, raw.type));
        await discardStored(s.id);
        recovered++;
        continue;
      }
      await saveRecording({
        raw,
        durationMs: Math.max(1000, s.lastChunkAt - s.startedAt),
        createdAt: s.startedAt,
        data: s.data,
        config: s.config,
        width: s.width,
        height: s.height,
        liveBlur: s.liveBlur,
        blurBurned: s.blurBurned,
        watermarkBurned: s.watermarkBurned,
        recovered: true,
      });
      await discardStored(s.id);
      recovered++;
    } catch {
      // leave it stored; the next launch tries again
    }
  }
  if (recovered) {
    try {
      localStorage.setItem("gpscam-recovered", String(recovered));
    } catch {
      // no storage — the event below still reaches a mounted camera
    }
    window.dispatchEvent(new CustomEvent("gpscam:recovered", { detail: recovered }));
  }
  return recovered;
}
