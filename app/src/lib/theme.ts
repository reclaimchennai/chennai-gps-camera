/**
 * App theme: light / dark / follow-system. The resolved theme is stamped
 * on <html data-theme> (CSS variables switch on it) and mirrored into the
 * meta theme-color. Camera and editor screens stay dark by design — like
 * every camera/photo-editing UI — via scoped variable overrides.
 */
import { useSettingsStore } from "../store";

const media = window.matchMedia("(prefers-color-scheme: dark)");

function resolve(): "light" | "dark" {
  const pref = useSettingsStore.getState().settings.appTheme;
  if (pref === "light" || pref === "dark") return pref;
  return media.matches ? "dark" : "light";
}

export function applyTheme(): void {
  const theme = resolve();
  document.documentElement.dataset.theme = theme;
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", theme === "dark" ? "#0b0f14" : "#f2f4f7");
}

export function initTheme(): void {
  applyTheme();
  media.addEventListener("change", applyTheme);
  useSettingsStore.subscribe(applyTheme);
}
