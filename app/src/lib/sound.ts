/** Synthesized shutter click — no audio asset needed. */

let ctx: AudioContext | null = null;

export function playShutter(): void {
  try {
    ctx ??= new AudioContext();
    if (ctx.state === "suspended") void ctx.resume();
    const t = ctx.currentTime;
    for (const [start, freq, dur] of [
      [0, 2600, 0.03],
      [0.05, 1800, 0.04],
    ] as const) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "square";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.12, t + start);
      gain.gain.exponentialRampToValueAtTime(0.001, t + start + dur);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t + start);
      osc.stop(t + start + dur);
    }
  } catch {
    // audio unavailable — silent shutter
  }
}
