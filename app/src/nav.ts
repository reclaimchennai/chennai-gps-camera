/**
 * Tiny hash router. Hash-based so the SPA needs no server rewrites and
 * the Android back button walks real history entries in standalone mode.
 */
import { useSyncExternalStore } from "react";

export interface Route {
  name:
    | "camera"
    | "gallery"
    | "map"
    | "collage"
    | "poster"
    | "group"
    | "media"
    | "edit"
    | "video-edit"
    | "settings"
    | "watermark"
    | "backup"
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
      if (parts[1] === "map") return { name: "map" };
      if (parts[1] === "collage") return { name: "collage" };
      if (parts[1] === "poster") return { name: "poster" };
      return { name: "gallery" };
    case "media":
      return { name: "media", id: parts[1] };
    case "edit":
      return { name: "edit", id: parts[1] };
    case "video-edit":
      return { name: "video-edit", id: parts[1] };
    case "settings":
      if (parts[1] === "watermark") return { name: "watermark" };
      if (parts[1] === "backup") return { name: "backup" };
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

import { isNativeApp, minimizeNativeApp } from "./lib/native";
import { viewerOrigin } from "./lib/viewer-order";

/**
 * Screens that need to swallow one Back before the router acts — the
 * gallery's selection mode is the first: Back there means "drop the
 * selection", not "leave for the camera". An intercept returns true when
 * it consumed the press. Registered last wins, so the innermost mode
 * (a modal inside a selection) gets first refusal.
 */
type BackIntercept = () => boolean;
const backIntercepts: BackIntercept[] = [];

export function registerBackIntercept(fn: BackIntercept): () => void {
  backIntercepts.push(fn);
  return () => {
    const i = backIntercepts.indexOf(fn);
    if (i >= 0) backIntercepts.splice(i, 1);
  };
}

function backIntercepted(): boolean {
  for (let i = backIntercepts.length - 1; i >= 0; i--) {
    if (backIntercepts[i]()) return true;
  }
  return false;
}

/**
 * What Back means — for the Android gesture AND every on-screen back
 * button. One function, deliberately: they used to disagree.
 *
 * The gesture was already deterministic here, but the buttons called
 * `goBack()` (raw `history.back()`), and the history stack is NOT a
 * truthful record of where the user has been. Several paths rewrite it:
 * the viewer replaces its own entry on every swipe, and returning from
 * the viewer replaces the media entry with `/gallery` — which leaves the
 * PREVIOUS entry also pointing at `/gallery`. `history.back()` then moved
 * from one `/gallery` entry to an identical one and the screen did not
 * change, so Back looked broken and took two or three presses. The
 * gesture never showed this because it never consulted history.
 *
 * So: screens whose parent is unambiguous jump straight there, and only
 * genuinely nested screens (settings → watermark) consult history.
 */
export function appBack(): void {
  // a screen-local mode (gallery selection) gets the press first
  if (backIntercepted()) return;
  const route = parse(location.hash);
  if (route.name === "camera") {
    // at the root the app hands the screen back to Android; on the web
    // there is nothing above us, so do nothing
    if (isNativeApp()) void minimizeNativeApp();
  } else if (route.name === "gallery") navigate("/", { replace: true });
  else if (route.name === "media")
    // the viewer rewrites its own history entry on every swipe, so
    // history.back() from here could land on a replaced entry and look
    // dead: go straight back to whatever opened it
    navigate(viewerOrigin(), { replace: true });
  else if (
    route.name === "group" ||
    route.name === "map" ||
    route.name === "collage" ||
    route.name === "poster"
  )
    navigate("/gallery", { replace: true });
  else goBack();
}

/** Android back (gesture or button), relayed by MainActivity. */
if (isNativeApp()) {
  window.addEventListener("gpscamBack", appBack);
}
