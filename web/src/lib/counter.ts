import type { CompactPoseSample, CounterSnapshot, ScubaMetrics } from "../types";

// The viral "Scuba" dance: plug your nose with one hand and wave your OTHER hand
// back and forth to the beat (knees bouncing). We detect that from the upper body
// only — nose, shoulders, wrists — and count each side-to-side sweep of the free
// hand as one "wave". Lower body / knee bounce does not need to be in frame.
const REQUIRED_POINTS = 7;
const STRIDE = 3;
const MIN_VISIBILITY = 0.3;
const MIN_SHOULDER_WIDTH = 0.05;
const NOSE_NEAR = 1.0; // a hand counts as "on the nose" within this many shoulder widths
const WAVE_MIN_AMP = 0.5; // a sweep must travel at least this far to count (shoulder widths)
const WAVE_HYST = 0.12; // ignore jitter smaller than this near a turning point
const MIN_REP_GAP_MS = 130;
const MAX_MISSING_MS = 700;

type Point = { x: number; y: number; v: number };

function point(sample: CompactPoseSample, index: number): Point {
  const base = index * STRIDE;
  return { x: sample.p[base], y: sample.p[base + 1], v: sample.p[base + 2] };
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

export function sanitizeSample(sample: CompactPoseSample): CompactPoseSample | null {
  if (!Number.isFinite(sample.t) || sample.t < 0 || !Array.isArray(sample.p) || sample.p.length !== REQUIRED_POINTS * STRIDE) {
    return null;
  }
  const p = sample.p.map((value, index) => {
    if (!Number.isFinite(value)) return NaN;
    return index % STRIDE === 2 ? clamp01(value) : value;
  });
  if (p.some((value) => !Number.isFinite(value))) return null;
  return { t: Math.round(sample.t), p };
}

export function computeScubaMetrics(raw: CompactPoseSample): ScubaMetrics {
  const sample = sanitizeSample(raw);
  if (!sample) {
    return { valid: false, quality: 0, noseHeld: false, freeX: 0, reason: "bad-sample" };
  }

  const nose = point(sample, 0);
  const ls = point(sample, 1);
  const rs = point(sample, 2);
  const lw = point(sample, 5);
  const rw = point(sample, 6);

  const minVisibility = Math.min(nose.v, ls.v, rs.v, lw.v, rw.v);
  if (minVisibility < MIN_VISIBILITY) {
    return { valid: false, quality: minVisibility, noseHeld: false, freeX: 0, reason: "low-visibility" };
  }

  const shoulderWidth = Math.abs(ls.x - rs.x);
  if (shoulderWidth < MIN_SHOULDER_WIDTH) {
    return { valid: false, quality: 0.2, noseHeld: false, freeX: 0, reason: "turn-to-camera" };
  }

  const denom = Math.max(0.04, shoulderWidth);
  const centerX = (ls.x + rs.x) / 2;
  const dL = Math.hypot(lw.x - nose.x, lw.y - nose.y) / denom;
  const dR = Math.hypot(rw.x - nose.x, rw.y - nose.y) / denom;
  const leftIsNose = dL <= dR;
  const noseHeld = Math.min(dL, dR) < NOSE_NEAR;
  const freeWrist = leftIsNose ? rw : lw;
  const freeX = (freeWrist.x - centerX) / denom;
  const quality = clamp01(0.7 * minVisibility + (noseHeld ? 0.3 : 0.1));

  return { valid: true, quality, noseHeld, freeX, reason: noseHeld ? undefined : "hold-nose" };
}

export class ScubaCounterEngine {
  private count = 0;
  private lastValidAtMs: number | null = null;
  private lastCountAtMs: number | null = null;
  private dir = 0; // -1, 0, +1 — current sweep direction of the free hand
  private extremeX = 0; // furthest free-hand x reached in the current direction
  private pivotX: number | null = null; // turning point that started the current sweep
  private lastSnapshot: CounterSnapshot = {
    count: 0,
    quality: 0,
    noseHeld: false,
    statusText: "Plug your nose, then wave your free hand"
  };

  reset(): void {
    this.count = 0;
    this.lastValidAtMs = null;
    this.lastCountAtMs = null;
    this.resetWave();
    this.lastSnapshot = {
      count: 0,
      quality: 0,
      noseHeld: false,
      statusText: "Plug your nose, then wave your free hand"
    };
  }

  private resetWave(): void {
    this.dir = 0;
    this.pivotX = null;
    this.extremeX = 0;
  }

  private emit(quality: number, noseHeld: boolean, statusText: string): CounterSnapshot {
    this.lastSnapshot = { count: this.count, quality, noseHeld, statusText };
    return this.lastSnapshot;
  }

  private tryCount(amplitude: number, t: number): void {
    const enoughGap = this.lastCountAtMs == null || t - this.lastCountAtMs >= MIN_REP_GAP_MS;
    if (Math.abs(amplitude) >= WAVE_MIN_AMP && enoughGap) {
      this.count += 1;
      this.lastCountAtMs = t;
    }
  }

  update(sample: CompactPoseSample): CounterSnapshot {
    const m = computeScubaMetrics(sample);

    if (!m.valid) {
      this.resetWave();
      const recentlyValid = this.lastValidAtMs != null && sample.t - this.lastValidAtMs < MAX_MISSING_MS;
      const statusText =
        m.reason === "turn-to-camera"
          ? "Face the camera"
          : recentlyValid
            ? "Keep your head and hands in frame"
            : "Show your head, shoulders and hands";
      return this.emit(m.quality, false, statusText);
    }
    this.lastValidAtMs = sample.t;

    if (!m.noseHeld) {
      this.resetWave();
      return this.emit(m.quality, false, "Hold your nose with one hand");
    }

    const x = m.freeX;
    if (this.pivotX == null) {
      this.pivotX = x;
      this.extremeX = x;
      return this.emit(m.quality, true, "Now wave your free hand side to side");
    }

    const pivot = this.pivotX;
    if (this.dir === 0) {
      if (x > pivot + WAVE_HYST) {
        this.dir = 1;
        this.extremeX = x;
      } else if (x < pivot - WAVE_HYST) {
        this.dir = -1;
        this.extremeX = x;
      }
    } else if (this.dir === 1) {
      if (x > this.extremeX) {
        this.extremeX = x;
      } else if (x < this.extremeX - WAVE_HYST) {
        this.tryCount(this.extremeX - pivot, sample.t);
        this.pivotX = this.extremeX;
        this.dir = -1;
        this.extremeX = x;
      }
    } else {
      if (x < this.extremeX) {
        this.extremeX = x;
      } else if (x > this.extremeX + WAVE_HYST) {
        this.tryCount(pivot - this.extremeX, sample.t);
        this.pivotX = this.extremeX;
        this.dir = 1;
        this.extremeX = x;
      }
    }

    return this.emit(m.quality, true, "Keep waving — to the beat!");
  }

  snapshot(): CounterSnapshot {
    return this.lastSnapshot;
  }
}

export function summarizeQuality(samples: CompactPoseSample[]): number {
  if (samples.length === 0) return 0;
  const total = samples.reduce((sum, sample) => sum + computeScubaMetrics(sample).quality, 0);
  return total / samples.length;
}
