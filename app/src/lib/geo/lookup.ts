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
import type { Feature, FeatureCollection } from "geojson";
import type { Jurisdiction, Scope } from "../../types";
import type { GeoBundle } from "./geodata";

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

const CORP_LABEL: Record<Exclude<Scope, "out">, string> = {
  gcc: "Greater Chennai Corporation",
  tambaram: "Tambaram Corporation",
  avadi: "Avadi Corporation",
};

export function lookup(
  bundle: GeoBundle,
  lat: number,
  lng: number
): LookupResult {
  const pt = turfPoint([lng, lat]);

  const ulbF = findContainingFeature(bundle.ulb.features as Feature[], pt);
  const loF = lookupPolygon(bundle.lo.features as Feature[], pt);
  const trF = lookupPolygon(bundle.traffic.features as Feature[], pt);

  // ---- Scope decision (§3 honesty rules) --------------------------
  const up = (ulbF?.properties ?? {}) as Record<string, string>;
  const lp = (loF?.properties ?? {}) as Record<string, string | boolean>;
  let scope: Scope = "out";
  if (up.ulbType === "Corporation" && up.ulb === "Chennai") scope = "gcc";
  else if (up.ulbType === "Corporation" && up.ulb === "Tambaram")
    scope = "tambaram";
  // Avadi Corporation has no ward polygons in the source data (§3): the
  // only geometry covering it is the L&O layer's Avadi-locality
  // commissionerate polygons. Only claim Avadi when no other local body
  // polygon matched, so neighbouring municipalities don't get mislabelled.
  else if (!ulbF && lp.avadi === true) scope = "avadi";

  const jurisdiction: Jurisdiction = { scope };

  if (scope !== "out") {
    jurisdiction.corporation = CORP_LABEL[scope];
    if (scope === "gcc" || scope === "tambaram") {
      jurisdiction.ward = up.ward;
      jurisdiction.zone = up.zone;
    }
    if (loF) {
      const p = lp as Record<string, string>;
      jurisdiction.loStation = p.station;
      const zoneShort = (p.zone ?? "").replace(/^chennai\s+/i, "");
      jurisdiction.loMeta = [p.ac, p.dc, zoneShort]
        .filter(Boolean)
        .join(" · ");
      jurisdiction.loPhone = p.phone;
    }
    if (trF) {
      const p = trF.properties as Record<string, string>;
      jurisdiction.trafficStation = p.station;
      jurisdiction.trafficMeta = [p.subDivision, p.district]
        .filter(Boolean)
        .join(" · ");
    }
  }

  // Nearest station point — cheap, and useful context inside scope.
  let nearest: NearestStation | null = null;
  if (scope !== "out") {
    let bestKm = Infinity;
    let bestName = "";
    for (const f of bundle.stations.features) {
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
