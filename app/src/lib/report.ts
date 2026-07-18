/**
 * Issue reporting → Telegram bot.
 *
 * The token + destination chat are injected at build time from a
 * gitignored .env.local (see VITE_TG_* there), so they are not committed
 * to the public repo. They ARE present in the built bundle that ships to
 * the site and the APK — a static, server-less app cannot keep a
 * client-side credential secret; this is a low-stakes feedback bot by
 * design. If the env vars are absent (e.g. a fork's build), reporting is
 * simply disabled.
 */
const TOKEN = import.meta.env.VITE_TG_TOKEN as string | undefined;
const CHAT = import.meta.env.VITE_TG_CHAT as string | undefined;

export function reportingEnabled(): boolean {
  return Boolean(TOKEN && CHAT);
}

/** Device / build context appended to every report. */
function contextLine(): string {
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  const native =
    (window as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor
      ?.isNativePlatform?.() ?? false;
  return [
    `App: ${native ? "Android" : "Web"}`,
    `Build: ${__BUILD_TS__.slice(0, 16)}`,
    `UA: ${nav.userAgent}`,
    `Screen: ${window.screen.width}×${window.screen.height}`,
  ].join("\n");
}

export async function sendReport(
  text: string,
  screenshot: Blob | null
): Promise<boolean> {
  if (!reportingEnabled()) return false;
  const caption =
    `🐞 Issue report\n\n${text.trim() || "(no description)"}\n\n${contextLine()}`;
  try {
    if (screenshot) {
      const form = new FormData();
      form.append("chat_id", CHAT!);
      // Telegram photo captions cap at 1024 chars
      form.append("caption", caption.slice(0, 1024));
      form.append("photo", screenshot, "screenshot.jpg");
      const r = await fetch(
        `https://api.telegram.org/bot${TOKEN}/sendPhoto`,
        { method: "POST", body: form }
      );
      const j = (await r.json()) as { ok: boolean };
      // if the caption was truncated, follow up with the full text
      if (j.ok && caption.length > 1024) {
        await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: CHAT, text: caption }),
        });
      }
      return j.ok;
    }
    const r = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: CHAT, text: caption }),
    });
    return ((await r.json()) as { ok: boolean }).ok;
  } catch {
    return false;
  }
}
