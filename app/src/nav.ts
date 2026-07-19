/**
 * Tiny hash router. Hash-based so the SPA needs no server rewrites and
 * the Android back button walks real history entries in standalone mode.
 */
import { useSyncExternalStore } from "react";

export interface Route {
  name:
    | "camera"
    | "gallery"
    | "group"
    | "media"
    | "edit"
    | "video-edit"
    | "settings"
    | "watermark"
    | "about"
    | "report";
  id?: string;
}

function parse(hash: string): Route {
  const parts = hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  switch (parts[0]) {
    case "gallery":
      // folder-in-folder: a video's grabbed frames live in a sub-view
      if (parts[1] === "group" && parts[2])
        return { name: "group", id: parts[2] };
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
    case "report":
      return { name: "report" };
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

export function navigate(path: string, opts?: { replace?: boolean }): void {
  const hash = path.startsWith("#") ? path : `#${path.startsWith("/") ? "" : "/"}${path}`;
  if (opts?.replace) {
    // swap the current history entry instead of pushing a new one — used
    // when swiping between gallery items so Back returns to the gallery
    // in one step rather than replaying the swipe history
    history.replaceState(null, "", hash);
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  } else {
    window.location.hash = path;
  }
}

export function goBack(): void {
  if (window.history.length > 1) window.history.back();
  else navigate("/");
}
