/**
 * Tiny hash router. Hash-based so the SPA needs no server rewrites and
 * the Android back button walks real history entries in standalone mode.
 */
import { useSyncExternalStore } from "react";

export interface Route {
  name:
    | "camera"
    | "gallery"
    | "media"
    | "edit"
    | "video-edit"
    | "settings"
    | "watermark"
    | "about";
  id?: string;
}

function parse(hash: string): Route {
  const parts = hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  switch (parts[0]) {
    case "gallery":
      return { name: "gallery" };
    case "media":
      return { name: "media", id: parts[1] };
    case "edit":
      return { name: "edit", id: parts[1] };
    case "video-edit":
      return { name: "video-edit", id: parts[1] };
    case "settings":
      if (parts[1] === "watermark") return { name: "watermark" };
      return { name: "settings" };
    case "about":
      return { name: "about" };
    default:
      return { name: "camera" };
  }
}

function subscribe(cb: () => void): () => void {
  window.addEventListener("hashchange", cb);
  return () => window.removeEventListener("hashchange", cb);
}

export function useRoute(): Route {
  const hash = useSyncExternalStore(
    subscribe,
    () => window.location.hash,
    () => ""
  );
  return parse(hash);
}

export function navigate(path: string): void {
  window.location.hash = path;
}

export function goBack(): void {
  if (window.history.length > 1) window.history.back();
  else navigate("/");
}
