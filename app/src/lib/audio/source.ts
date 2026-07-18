/**
 * Pick the best microphone for recording + the dB meter.
 *
 * Problem this solves: when a headset/headphones is connected, Android's
 * default audio-input routing often lands on a dead path — a wired
 * headphone with no mic (TRS, not TRRS) or a Bluetooth device whose SCO
 * mic never activates — and getUserMedia({audio:true}) then captures pure
 * silence. The recording has no sound and the meter floors at its FLOOR dB.
 *
 * Fix: enumerate the real audio inputs and choose explicitly.
 *  - Prefer an EXTERNAL input that actually has a microphone. Such a device
 *    only appears in the audioinput list because it can capture, so
 *    preferring it honours "use the connected mic when there is one".
 *  - Otherwise pin the BUILT-IN mic by deviceId, which forces capture off
 *    the phone's own mic even when the OS was about to route to a mic-less
 *    accessory — so plugging in plain headphones never mutes the audio.
 *
 * Device labels are only populated after mic permission has been granted,
 * so on the very first open we return the base constraints unchanged and
 * let the OS choose; every open after that gets the explicit pick.
 */

type AudioConstraints = MediaTrackConstraints;

const EXTERNAL = /bluetooth|headset|headphone|\bwired\b|\busb\b|external|\bbt\b/i;
const BUILTIN = /built.?in|internal|\bphone\b|handset|device default|default - /i;

export async function preferredAudioConstraints(
  base: AudioConstraints
): Promise<AudioConstraints> {
  try {
    if (!navigator.mediaDevices?.enumerateDevices) return base;
    const devices = await navigator.mediaDevices.enumerateDevices();
    const inputs = devices.filter(
      (d) =>
        d.kind === "audioinput" &&
        d.deviceId &&
        // "default"/"communications" are aliases that resolve back to the
        // OS routing we are trying to override — skip them, pick a real one
        d.deviceId !== "default" &&
        d.deviceId !== "communications"
    );
    // No labels yet (permission not granted) or nothing enumerable —
    // nothing to reason about, let the platform pick.
    if (!inputs.length || inputs.every((d) => !d.label)) return base;

    const external = inputs.find((d) => EXTERNAL.test(d.label));
    const chosen =
      external ?? inputs.find((d) => BUILTIN.test(d.label)) ?? inputs[0];
    // `exact` is deliberate: a mic-less headset must not silently fall
    // through to the OS default. If the device vanished between enumerate
    // and capture the getUserMedia call rejects and the caller retries with
    // these base constraints.
    return { ...base, deviceId: { exact: chosen.deviceId } };
  } catch {
    return base;
  }
}
