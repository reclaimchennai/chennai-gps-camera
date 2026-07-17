import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  define: {
    // build stamp — shown in About so users can confirm auto-update landed
    __BUILD_TS__: JSON.stringify(new Date().toISOString()),
  },
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["icons/*.png"],
      manifest: {
        name: "Chennai GPS Camera",
        short_name: "GPS Cam",
        description:
          "Location-stamped camera for Chennai — ward, zone and police jurisdiction on every photo, resolved offline.",
        start_url: "/",
        display: "standalone",
        theme_color: "#0b0f14",
        background_color: "#0b0f14",
        icons: [
          { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
          {
            src: "/icons/icon-maskable-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
        ],
      },
      workbox: {
        // Core app shell + the Chennai pilot pack are precached (fully
        // offline from first visit there); other region packs fetch on
        // demand and live in IndexedDB. Face-detection wasm/models cache
        // on first use.
        globPatterns: [
          "**/*.{js,css,html,png,svg,woff2}",
          "data/packs/chennai.json",
        ],
        // download/ holds the Android APK — served, never precached
        globIgnores: ["mediapipe/**", "models/**", "download/**"],
        maximumFileSizeToCacheInBytes: 6 * 1024 * 1024,
        navigateFallback: "index.html",
        runtimeCaching: [
          {
            // pack index stays fresh (it drives OTA data updates)
            urlPattern: /\/data\/packs\/index\.json/,
            handler: "NetworkFirst",
            options: { cacheName: "geodata", networkTimeoutSeconds: 4 },
          },
          {
            // versioned pack fetches (?v=hash)
            urlPattern: /\/data\/packs\/.*\.json/,
            handler: "StaleWhileRevalidate",
            options: { cacheName: "geodata" },
          },
          {
            urlPattern: /\/(mediapipe|models)\//,
            handler: "CacheFirst",
            options: {
              cacheName: "detect-models",
              expiration: { maxEntries: 12 },
            },
          },
        ],
      },
    }),
  ],
});
