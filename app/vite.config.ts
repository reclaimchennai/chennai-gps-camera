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
        // Core app shell + the offline jurisdiction bundle are precached;
        // the heavyweight face-detection wasm/model cache on first use.
        globPatterns: ["**/*.{js,css,html,png,svg,woff2,geojson}"],
        globIgnores: ["mediapipe/**", "models/**"],
        maximumFileSizeToCacheInBytes: 6 * 1024 * 1024,
        navigateFallback: "index.html",
        runtimeCaching: [
          {
            // versioned geodata refetches (?v=hash) — stale-while-revalidate,
            // same pattern as the police-locator sw.js
            urlPattern: /\/data\/.*\.geojson/,
            handler: "StaleWhileRevalidate",
            options: { cacheName: "geodata" },
          },
          {
            urlPattern: /\/data\/version\.json/,
            handler: "NetworkFirst",
            options: { cacheName: "geodata", networkTimeoutSeconds: 4 },
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
