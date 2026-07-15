import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "city.reclaimchennai.cam",
  appName: "Chennai GPS Camera",
  webDir: "dist",
  android: {
    // The PWA codebase runs as-is in the WebView. Native plugins planned
    // for the Android pass (§7/§8 of the build brief): full-res camera,
    // android.location.Geocoder reverse geocoding (free, no API key),
    // Maps SDK MapView snapshots, androidx.exifinterface EXIF writing,
    // Media3 Transformer video export, volume-key shutter.
    allowMixedContent: false,
  },
};

export default config;
