/**
 * EXIF writing for the web build via piexifjs (§2: the true GPS /
 * address / jurisdiction data is always written to metadata, whatever
 * the visible watermark shows).
 */
import piexif from "piexifjs";
import type { WatermarkData } from "../types";
import { APP_NAME } from "./watermark/presets";

function toDms(value: number): [number, number][] {
  const abs = Math.abs(value);
  const deg = Math.floor(abs);
  const minFloat = (abs - deg) * 60;
  const min = Math.floor(minFloat);
  const sec = Math.round((minFloat - min) * 60 * 10000);
  return [
    [deg, 1],
    [min, 1],
    [sec, 10000],
  ];
}

function exifDate(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}:${pad(d.getMonth() + 1)}:${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

async function blobToBinaryString(blob: Blob): Promise<string> {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let s = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < buf.length; i += CHUNK) {
    s += String.fromCharCode.apply(
      null,
      buf.subarray(i, i + CHUNK) as unknown as number[]
    );
  }
  return s;
}

function binaryStringToBlob(s: string, type: string): Blob {
  const buf = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) buf[i] = s.charCodeAt(i) & 0xff;
  return new Blob([buf], { type });
}

/** Insert GPS + descriptive EXIF into a JPEG blob. */
export async function writeExif(
  jpeg: Blob,
  data: WatermarkData
): Promise<Blob> {
  try {
    const zeroth: Record<number, unknown> = {
      [piexif.ImageIFD.Software]: APP_NAME,
    };
    const exif: Record<number, unknown> = {
      [piexif.ExifIFD.DateTimeOriginal]: exifDate(data.timestamp),
      [piexif.ExifIFD.DateTimeDigitized]: exifDate(data.timestamp),
    };
    const gps: Record<number, unknown> = {};

    const j = data.jurisdiction;
    const descParts: string[] = [];
    if (data.address) descParts.push(data.address);
    if (data.digipin) descParts.push(`DIGIPIN: ${data.digipin}`);
    if (j && j.scope !== "out") {
      if (j.corporation) descParts.push(j.corporation);
      if (j.ward) descParts.push(`Ward ${j.ward}`);
      if (j.zone) descParts.push(j.zone);
      if (j.loStation) descParts.push(`L&O: ${j.loStation}`);
      if (j.trafficStation) descParts.push(`Traffic: ${j.trafficStation}`);
    }
    if (descParts.length) {
      zeroth[piexif.ImageIFD.ImageDescription] = descParts.join(" | ");
    }

    if (data.fix) {
      const { lat, lng, altitude } = data.fix;
      gps[piexif.GPSIFD.GPSLatitudeRef] = lat >= 0 ? "N" : "S";
      gps[piexif.GPSIFD.GPSLatitude] = toDms(lat);
      gps[piexif.GPSIFD.GPSLongitudeRef] = lng >= 0 ? "E" : "W";
      gps[piexif.GPSIFD.GPSLongitude] = toDms(lng);
      if (altitude != null) {
        gps[piexif.GPSIFD.GPSAltitudeRef] = altitude >= 0 ? 0 : 1;
        gps[piexif.GPSIFD.GPSAltitude] = [
          Math.round(Math.abs(altitude) * 100),
          100,
        ];
      }
      const utc = new Date(data.timestamp);
      gps[piexif.GPSIFD.GPSTimeStamp] = [
        [utc.getUTCHours(), 1],
        [utc.getUTCMinutes(), 1],
        [utc.getUTCSeconds(), 1],
      ];
      const pad = (n: number) => String(n).padStart(2, "0");
      gps[piexif.GPSIFD.GPSDateStamp] =
        `${utc.getUTCFullYear()}:${pad(utc.getUTCMonth() + 1)}:${pad(utc.getUTCDate())}`;
    }

    const exifBytes = piexif.dump({
      "0th": zeroth,
      Exif: exif,
      GPS: gps,
    });
    const asString = await blobToBinaryString(jpeg);
    const withExif = piexif.insert(exifBytes, asString);
    return binaryStringToBlob(withExif, "image/jpeg");
  } catch {
    // Never lose a photo over metadata — return the plain JPEG.
    return jpeg;
  }
}

// ---- reading (used to rebuild a library from the saved JPEGs) --------

export interface ReadExif {
  /** capture time from DateTimeOriginal, ms since epoch (local clock) */
  timestamp?: number;
  lat?: number;
  lng?: number;
  altitude?: number;
  /** our own ImageDescription line: address | DIGIPIN | ward | stations */
  description?: string;
  /** true when Software says this file came from this app */
  ours?: boolean;
}

function fromDms(dms: [number, number][], ref: string): number | undefined {
  if (!Array.isArray(dms) || dms.length < 3) return undefined;
  const val = dms.map(([n, d]) => (d ? n / d : 0));
  const deg = val[0] + val[1] / 60 + val[2] / 3600;
  if (!Number.isFinite(deg)) return undefined;
  return ref === "S" || ref === "W" ? -deg : deg;
}

/** "2026:08:10 05:43:11" → ms. Parsed as LOCAL time, as EXIF defines it. */
function parseExifDate(s: unknown): number | undefined {
  if (typeof s !== "string") return undefined;
  const m = s.match(/^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (!m) return undefined;
  const [, y, mo, d, h, mi, sec] = m.map(Number) as unknown as number[];
  const t = new Date(y, mo - 1, d, h, mi, sec).getTime();
  return Number.isFinite(t) ? t : undefined;
}

/**
 * Pull back what we wrote. Every field is optional: this runs over files
 * the user selected, which may be any JPEG at all.
 */
export async function readExif(jpeg: Blob): Promise<ReadExif> {
  try {
    const data = piexif.load(await blobToBinaryString(jpeg));
    const zeroth = (data["0th"] ?? {}) as Record<number, unknown>;
    const exif = (data.Exif ?? {}) as Record<number, unknown>;
    const gps = (data.GPS ?? {}) as Record<number, unknown>;

    const out: ReadExif = {};
    out.timestamp =
      parseExifDate(exif[piexif.ExifIFD.DateTimeOriginal]) ??
      parseExifDate(zeroth[piexif.ImageIFD.DateTime]);

    const latRef = gps[piexif.GPSIFD.GPSLatitudeRef];
    const lngRef = gps[piexif.GPSIFD.GPSLongitudeRef];
    if (latRef && lngRef) {
      out.lat = fromDms(
        gps[piexif.GPSIFD.GPSLatitude] as [number, number][],
        String(latRef)
      );
      out.lng = fromDms(
        gps[piexif.GPSIFD.GPSLongitude] as [number, number][],
        String(lngRef)
      );
    }
    const alt = gps[piexif.GPSIFD.GPSAltitude] as [number, number] | undefined;
    if (Array.isArray(alt) && alt[1]) {
      const a = alt[0] / alt[1];
      out.altitude = gps[piexif.GPSIFD.GPSAltitudeRef] === 1 ? -a : a;
    }

    const desc = zeroth[piexif.ImageIFD.ImageDescription];
    if (typeof desc === "string" && desc) out.description = desc;
    const soft = zeroth[piexif.ImageIFD.Software];
    out.ours = typeof soft === "string" && soft.includes(APP_NAME);
    return out;
  } catch {
    // unreadable or EXIF-less — the importer falls back to the file's date
    return {};
  }
}
