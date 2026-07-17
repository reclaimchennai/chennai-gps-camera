/**
 * Offline point-in-polygon jurisdiction lookup.
 *
 * Direct port of the proven police-locator algorithm: per-feature bbox
 * prefilter (bboxes are precomputed into the bundle at build time),
 * exact turf.booleanPointInPolygon match, and a nearest-polygon fallback
 * (polygonToLine + pointToLineDistance, 400 m tolerance) for points that
 * miss every polygon because independent boundary simplification opened
 * a hairline gap.
 */
import booleanPointInPolygon from "@turf/boolean-point-in-polygon";
import polygonToLine from "@turf/polygon-to-line";
import pointToLineDistance from "@turf/point-to-line-distance";
import distance from "@turf/distance";
import { point as turfPoint } from "@turf/helpers";
import type { Feature } from "geojson";
import type { FeatureCollection } from "geojson";
import type { Jurisdiction } from "../../types";
import type { GeoPack } from "./geodata";

type Pt = ReturnType<typeof turfPoint>;

function pointInBbox(
  [x, y]: number[],
  [minX, minY, maxX, maxY]: number[],
  pad = 0
): boolean {
  return (
    x >= minX - pad && x <= maxX + pad && y >= minY - pad && y <= maxY + pad
  );
}

function findContainingFeature(
  features: Feature[],
  pt: Pt
): Feature | null {
  const c = pt.geometry.coordinates;
  for (const f of features) {
    if (f.bbox && !pointInBbox(c, f.bbox)) continue;
    try {
      if (booleanPointInPolygon(pt, f as never)) return f;
    } catch {
      // ignore invalid geometry
    }
  }
  return null;
}

/**
 * Fallback for points that just barely miss every polygon. Picks the
 * polygon whose edge is closest, within `maxKm` of the point.
 */
function nearestPolygon(
  features: Feature[],
  pt: Pt,
  maxKm = 0.4
): Feature | null {
  const c = pt.geometry.coordinates;
  const pad = maxKm / 100; // ~degrees; ~0.004 for 400 m
  let best: Feature | null = null;
  let bestKm = Infinity;
  for (const f of features) {
    if (f.bbox && !pointInBbox(c, f.bbox, pad)) continue;
    try {
      const line = polygonToLine(f as never) as
        | Feature
        | FeatureCollection;
      const lines =
        line.type === "FeatureCollection" ? line.features : [line];
      for (const ln of lines) {
        const d = pointToLineDistance(pt, ln as never, {
          units: "kilometers",
        });
        if (d < bestKm) {
          bestKm = d;
          best = f;
        }
      }
    } catch {
      // ignore
    }
  }
  return bestKm <= maxKm ? best : null;
}

function lookupPolygon(features: Feature[], pt: Pt): Feature | null {
  return findContainingFeature(features, pt) ?? nearestPolygon(features, pt);
}

export interface NearestStation {
  name: string;
  km: number;
}

export interface LookupResult {
  jurisdiction: Jurisdiction;
  /** Matched ward feature — the offline mini-map draws its outline. */
  wardFeature: Feature | null;
  loFeature: Feature | null;
  nearestStation: NearestStation | null;
}

export function lookup(
  pack: GeoPack,
  lat: number,
  lng: number
): LookupResult {
  const pt = turfPoint([lng, lat]);

  const ulbF = findContainingFeature(pack.layers.ulb.features as Feature[], pt);
  const loF = lookupPolygon(pack.layers.lo.features as Feature[], pt);
  const trF = lookupPolygon(pack.layers.traffic.features as Feature[], pt);

  const jurisdiction: Jurisdiction = { scope: "out" };
  const up = (ulbF?.properties ?? {}) as Record<string, string>;
  const lp = (loF?.properties ?? {}) as Record<string, string | boolean>;

  if (ulbF) {
    jurisdiction.scope = "in";
    jurisdiction.corporation = up.corp;
    jurisdiction.city = up.city;
    jurisdiction.ward = up.ward;
    jurisdiction.wardName = up.wardName;
    jurisdiction.zone = up.zone;
  } else if (lp.avadi === true) {
    // Avadi Corporation has no published ward polygons — the only
    // geometry covering it is the L&O commissionerate layer. Claim it
    // only when no local-body polygon matched, so neighbouring
    // municipalities aren't mislabelled.
    jurisdiction.scope = "in";
    jurisdiction.corporation = "Avadi Corporation";
    jurisdiction.city = "Avadi";
    jurisdiction.wardPending = true;
  }

  // Police jurisdictions render whenever their polygons match — the
  // data is honest about itself (no polygon → no claim).
  if (loF) {
    jurisdiction.scope = "in";
    const p = lp as Record<string, string>;
    jurisdiction.loStation = p.station;
    const zoneShort = (p.zone ?? "").replace(/^chennai\s+/i, "");
    jurisdiction.loMeta = [p.ac, p.dc, zoneShort].filter(Boolean).join(" · ");
    jurisdiction.loPhone = p.phone;
  }
  if (trF) {
    jurisdiction.scope = "in";
    const p = trF.properties as Record<string, string>;
    jurisdiction.trafficStation = p.station;
    jurisdiction.trafficMeta = [p.subDivision, p.district]
      .filter(Boolean)
      .join(" · ");
  }

  // Nearest station point — where the pack ships station points.
  let nearest: NearestStation | null = null;
  if (jurisdiction.scope === "in" && pack.layers.stations.features.length) {
    let bestKm = Infinity;
    let bestName = "";
    for (const f of pack.layers.stations.features) {
      const d = distance(pt, f as never, { units: "kilometers" });
      if (d < bestKm) {
        bestKm = d;
        bestName =
          (f.properties as Record<string, string>).label ??
          (f.properties as Record<string, string>).name ??
          "";
      }
    }
    if (bestName) nearest = { name: bestName, km: bestKm };
  }

  return {
    jurisdiction,
    wardFeature: ulbF,
    loFeature: loF,
    nearestStation: nearest,
  };
}
