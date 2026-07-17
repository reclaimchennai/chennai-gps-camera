import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "city.reclaimchennai.cam",
  appName: "Chennai GPS Camera",
  webDir: "dist",
  server: {
    // https scheme keeps the WebView a secure context (camera + GPS)
    androidScheme: "https",
  },
};

export default config;
