import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { registerSW } from "virtual:pwa-register";
import "./index.css";
// Self-hosted open-source fonts for text annotations (offline-friendly;
// latin subsets only to keep the offline precache lean).
import "@fontsource/roboto/latin-400.css";
import "@fontsource/roboto/latin-500.css";
import "@fontsource/open-sans/latin-400.css";
import "@fontsource/montserrat/latin-400.css";
import "@fontsource/oswald/latin-400.css";
import "@fontsource/caveat/latin-400.css";
import App from "./App";
import { hydrateSettings } from "./store";
import { startLocation, startCompass } from "./lib/location";
import { startLiveAddress } from "./lib/liveAddress";
import { initBackfill } from "./lib/backfill";
import { initDownloadQueue } from "./lib/downloadQueue";
import { warmGeodata } from "./lib/geo/geodata";
import { initTheme, applyTheme } from "./lib/theme";
import { startOrientationWatch } from "./lib/orientation";

// Auto-update for installed PWAs: the service worker is registered in
// autoUpdate mode (new versions skipWaiting + claim + reload the page).
// Update checks run on launch, every 15 minutes, whenever the app comes
// back to the foreground, and when connectivity returns — installed users
// pick up deploys without any manual cache clearing.
console.info(`Chennai GPS Camera build ${__BUILD_TS__}`);
registerSW({
  immediate: true,
  onRegisteredSW(_url, registration) {
    if (!registration) return;
    const check = () => void registration.update().catch(() => {});
    check();
    window.setInterval(check, 15 * 60 * 1000);
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) check();
    });
    window.addEventListener("online", check);
  },
});

// Kick off everything the first shutter tap depends on, in parallel with
// the first render — camera pre-warm happens in CameraView's mount effect.
initTheme(); // system theme immediately; re-applied once settings hydrate
startOrientationWatch(); // in-place UI rotation for landscape shooting
void hydrateSettings().then(() => {
  applyTheme();
  // Native: geolocation NEVER starts before the location grant is
  // confirmed — an ungranted watchPosition fires the WebView geolocation
  // relay, whose grant callback was the first-run crash. FAIL-SAFE: an
  // unknown state (null) also waits rather than risking the relay.
  // Web: immediate as always (the browser prompt is fine there).
  void (async () => {
    const { isNativeApp, checkNativePermissions } = await import("./lib/native");
    if (!isNativeApp()) {
      startLocation();
      return;
    }
    // grant events from either the native ActivityCompat result or any
    // legacy path; startLocation() is idempotent so both may fire
    window.addEventListener("gpscamLocationGranted", () => startLocation());
    window.addEventListener("gpscam:perms-granted", () => startLocation());
    const s = await checkNativePermissions();
    if (s?.location) startLocation();
  })();
  startCompass();
  startLiveAddress();
  initBackfill();
  initDownloadQueue();
});
warmGeodata();

// Ask the browser to never evict this origin's storage — the in-app
// gallery lives in IndexedDB and must survive storage pressure.
void navigator.storage?.persist?.().catch(() => {});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
