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
