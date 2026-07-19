/**
 * Photo map (§ gallery): every capture with a GPS fix plotted over OSM.
 *
 * Zoom story, iOS-Photos style:
 *  - zoomed OUT → a heatmap of where the user shoots
 *  - mid zoom   → photo clusters (thumbnail + count bubble)
 *  - max zoom   → individual mini photo pins at their exact spot
 * Tapping a pin opens that photo/video. Pinch is continuous (zoomSnap 0)
 * so zooming feels like a native map, not stepped.
 *
 * Lazy-loaded route: leaflet + plugins live in their own chunk and load
 * only when the map opens. Tiles need network; captures don't.
 */
import { useEffect, useRef } from "react";
import L from "leaflet";
import "leaflet.heat";
import "leaflet.markercluster";
import "leaflet/dist/leaflet.css";
import { Screen } from "./ui";
import { listMedia, getBlob } from "../lib/db";
import { navigate } from "../nav";

/** clusters take over from the heatmap above this zoom */
const HEAT_MAX_ZOOM = 12;
/** individual pins take over from clusters at this zoom */
const PIN_ZOOM = 17;

export default function PhotoMapView() {
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    let disposed = false;
    const urls: string[] = [];
    let map: L.Map | null = null;

    void (async () => {
      const items = (await listMedia()).filter((m) => m.data.fix);
      if (disposed) return;

      map = L.map(box, {
        zoomSnap: 0, // continuous pinch — buttery, not stepped
        zoomAnimation: true,
        attributionControl: true,
      });
      L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        attribution: "© OpenStreetMap contributors",
      }).addTo(map);

      const points = items.map(
        (m) => [m.data.fix!.lat, m.data.fix!.lng] as [number, number]
      );

      // ---- heat layer (far out) ------------------------------------
      const heat = (
        L as unknown as {
          heatLayer: (
            pts: [number, number][],
            opts: Record<string, unknown>
          ) => L.Layer;
        }
      ).heatLayer(points, { radius: 28, blur: 22, minOpacity: 0.35 });

      // ---- photo pins + clusters (near) ----------------------------
      const clusters = (
        L as unknown as {
          markerClusterGroup: (opts: Record<string, unknown>) => L.FeatureGroup;
        }
      ).markerClusterGroup({
        disableClusteringAtZoom: PIN_ZOOM,
        maxClusterRadius: 64,
        showCoverageOnHover: false,
        spiderfyOnMaxZoom: false,
        iconCreateFunction: (cluster: {
          getChildCount: () => number;
          getAllChildMarkers: () => { options: { thumbUrl?: string } }[];
        }) => {
          const n = cluster.getChildCount();
          const first = cluster.getAllChildMarkers()[0]?.options.thumbUrl;
          return L.divIcon({
            className: "pm-cluster-wrap",
            html: `<div class="pm-cluster">${
              first ? `<img src="${first}" alt="" />` : ""
            }<span class="pm-count">${n}</span></div>`,
            iconSize: [56, 56],
            iconAnchor: [28, 28],
          });
        },
      });

      for (const m of items) {
        const t = await getBlob(m.id, "thumb");
        if (disposed) return;
        const thumbUrl = t ? URL.createObjectURL(t) : "";
        if (thumbUrl) urls.push(thumbUrl);
        const icon = L.divIcon({
          className: "pm-pin-wrap",
          html: `<div class="pm-pin">${
            thumbUrl ? `<img src="${thumbUrl}" alt="" />` : ""
          }</div>`,
          iconSize: [46, 46],
          iconAnchor: [23, 40], // pin tip at the capture spot
        });
        const marker = L.marker([m.data.fix!.lat, m.data.fix!.lng], {
          icon,
          ...( { thumbUrl } as Record<string, unknown>),
        });
        marker.on("click", () => navigate(`/media/${m.id}`));
        clusters.addLayer(marker);
      }

      // ---- zoom-driven layer swap ----------------------------------
      const applyLayers = () => {
        if (!map) return;
        const z = map.getZoom();
        if (z <= HEAT_MAX_ZOOM) {
          if (!map.hasLayer(heat)) map.addLayer(heat);
          if (map.hasLayer(clusters)) map.removeLayer(clusters);
        } else {
          if (map.hasLayer(heat)) map.removeLayer(heat);
          if (!map.hasLayer(clusters)) map.addLayer(clusters);
        }
      };
      map.on("zoomend", applyLayers);

      if (points.length) {
        map.fitBounds(L.latLngBounds(points).pad(0.25), { maxZoom: 15 });
      } else {
        map.setView([13.0827, 80.2707], 11); // Chennai, until captures exist
      }
      applyLayers();
    })();

    return () => {
      disposed = true;
      map?.remove();
      urls.forEach((u) => URL.revokeObjectURL(u));
    };
  }, []);

  return (
    <Screen title="Photo map" noPad>
      <div ref={boxRef} className="photo-map" />
    </Screen>
  );
}
