import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "city.reclaimchennai.cam",
  appName: "Chennai GPS Camera",
  webDir: "dist",
  server: {
    // https scheme keeps the WebView a secure context (camera + GPS)
    androidScheme: "https",
  },
  android: {
    // on-device test builds only (GPSCAM_DEBUG_WEB=1): lets the test
    // scripts drive and time the WebView over Chrome DevTools. Releases
    // are built without it.
    webContentsDebuggingEnabled: process.env.GPSCAM_DEBUG_WEB === "1",
  },
};

export default config;
