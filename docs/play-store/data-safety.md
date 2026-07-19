# Data safety form — answers

How to fill Play Console → App content → **Data safety**. These answers are
drawn from an audit of the code (`lib/geocode.ts`, `lib/report.ts`,
`lib/camera.ts`, `lib/db.ts`). Keep them truthful — Play cross-checks against
runtime behaviour and the manifest.

## Overview answers

- **Does your app collect or share any of the required user data types?**
  → **Yes** (because reverse geocoding sends location off-device, and bug
  reports can send a photo/message). Be precise below — most of it is
  *ephemeral* or *user-initiated*, not "collected" into a backend.
- **Is all user data encrypted in transit?** → **Yes** (all outbound calls are
  HTTPS: Nominatim, Google, Mappls, Telegram).
- **Do you provide a way for users to request data deletion?** → The app stores
  data only on-device; there is no server data to delete. Users delete
  in-app/gallery items or clear app storage. (Answer: we don't collect data on
  a server; provide the privacy-policy explanation.)

## Data types

### Location — Approximate & Precise location
- **Collected?** No backend of ours stores it. It **is sent off-device** for
  reverse geocoding (coords → address) and, if enabled, a static map.
- **Shared?** **Yes** — shared with a geocoding/map provider (OpenStreetMap
  Nominatim by default; Google or Mappls if the user adds a key).
- **Purpose:** App functionality (address on the watermark).
- **Ephemeral / not stored:** processing is real-time; the coordinates are not
  retained by us.
- **Required or optional:** Optional — the app works offline without it.

> In the Console: mark Precise + Approximate location as **collected =
> ephemeral** (or "not collected" if you treat reverse-geocoding as processing
> only) and **shared = Yes** for App functionality. The honest, safest
> selection is: **Location → Shared → App functionality → not processed
> ephemerally is false (it IS ephemeral)**.

### Photos and videos
- **Collected/Shared by us?** **No.** Captures are saved on-device only.
- Exception: **Photos** may be **shared** *only if the user attaches a
  screenshot to a bug report* (user-initiated, to Telegram). Declare **Photos →
  Shared → App functionality (support), optional, user-initiated.**

### Audio (microphone)
- Used on-device for video audio + the dB meter. **Not collected, not shared.**
  (Recorded audio lives inside the user's saved video on their device.)

### Messages / support content
- The **free-text bug report** a user types is sent to the developer via
  Telegram. Declare under **App activity / "Other user-generated content" →
  Shared → App functionality (support), optional, user-initiated.**

### Personal identifiers, contacts, financial info, health, etc.
- **None collected.** No accounts, no advertising ID, no analytics SDK.

## Security practices
- **Encrypted in transit:** Yes (HTTPS everywhere).
- **Users can request deletion:** Data is local; nothing held server-side.
- **Committed to Play Families policy:** N/A (not a Families/children app).
- **Independent security review:** No.

## Data NOT collected (state plainly)
No personal info, no financial info, no health/fitness, no messages stored by
us, no contacts, no calendar, no app activity analytics, no web history, no
device identifiers for tracking, no advertising ID.
