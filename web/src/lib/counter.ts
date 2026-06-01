import type { CompactPoseSample, CounterSnapshot, ScubaMetrics } from "../types";

// Upper-body only: shoulders, elbows, wrists. No hips needed, so you only have
// to keep your head-to-chest area in frame. Wrist height is measured relative to
// the shoulder line and normalised by shoulder width, so it works at any distance.
const REQUIRED_POINTS = 6;
const STRIDE = 3;
const RAISE = -0.3; // wrists above the shoulder line -> "armed"
const DROP = 0.45; // wrists pulled down below the shoulders -> count a rep
const SYMMETRY_LIMIT = 2.6; // how unlevel the two wrists may be when raising (shoulder widths)
const MIN_VISIBILITY = 0.3;
const MIN_SHOULDER_WIDTH = 0.05;
const MIN_PULL_MS = 120;
const MIN_REP_GAP_MS = 220;
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
    return { valid: false, quality: 0, phase: "hidden", strokeValue: 0, torso: 0, symmetry: 1, reason: "bad-sample" };
  }

  const ls = point(sample, 0);
  const rs = point(sample, 1);
  const lw = point(sample, 4);
  const rw = point(sample, 5);

  const minVisibility = Math.min(ls.v, rs.v, lw.v, rw.v);
  if (minVisibility < MIN_VISIBILITY) {
    return { valid: false, quality: minVisibility, phase: "hidden", strokeValue: 0, torso: 0, symmetry: 1, reason: "low-visibility" };
  }

  const shoulderY = (ls.y + rs.y) / 2;
  const shoulderWidth = Math.abs(ls.x - rs.x);
  if (shoulderWidth < MIN_SHOULDER_WIDTH) {
    return { valid: false, quality: 0.2, phase: "hidden", strokeValue: 0, torso: 0, symmetry: 1, reason: "turn-to-camera" };
  }

  const denom = Math.max(0.04, shoulderWidth);
  const wristY = (lw.y + rw.y) / 2;
  const strokeValue = (wristY - shoulderY) / denom;
  const symmetry = Math.abs(lw.y - rw.y) / denom;
  const symmetryScore = clamp01(1 - symmetry / 3);
  const quality = clamp01(0.7 * minVisibility + 0.3 * symmetryScore);

  return {
    valid: true,
    quality,
    phase: strokeValue < RAISE ? "raise" : "pull",
    strokeValue,
    torso: 0,
    symmetry,
    reason: undefined
  };
}

export class ScubaCounterEngine {
  private count = 0;
  private armed = false;
  private raisedAtMs: number | null = null;
  private lastCountAtMs: number | null = null;
  private lastValidAtMs: number | null = null;
  private lastSnapshot: CounterSnapshot = {
    count: 0,
    phase: "hidden",
    quality: 0,
    strokeValue: 0,
    lastRepMs: null,
    statusText: "Show your shoulders and hands"
  };

  reset(): void {
    this.count = 0;
    this.armed = false;
    this.raisedAtMs = null;
    this.lastCountAtMs = null;
    this.lastValidAtMs = null;
    this.lastSnapshot = {
      count: 0,
      phase: "hidden",
      quality: 0,
      strokeValue: 0,
      lastRepMs: null,
      statusText: "Raise both hands to start"
    };
  }

  update(sample: CompactPoseSample): CounterSnapshot {
    const metrics = computeScubaMetrics(sample);

    if (!metrics.valid) {
      const recentlyValid = this.lastValidAtMs != null && sample.t - this.lastValidAtMs < MAX_MISSING_MS;
      const statusText =
        metrics.reason === "turn-to-camera"
          ? "Face the camera"
          : recentlyValid
            ? "Keep going"
            : "Show your shoulders and hands";
      this.lastSnapshot = {
        count: this.count,
        phase: recentlyValid ? this.lastSnapshot.phase : "hidden",
        quality: metrics.quality,
        strokeValue: metrics.strokeValue,
        lastRepMs: this.lastCountAtMs,
        statusText
      };
      return this.lastSnapshot;
    }

    this.lastValidAtMs = sample.t;

    if (metrics.strokeValue < RAISE && metrics.symmetry < SYMMETRY_LIMIT) {
      this.armed = true;
      this.raisedAtMs = sample.t;
    }

    const enoughPull = this.raisedAtMs == null ? false : sample.t - this.raisedAtMs >= MIN_PULL_MS;
    const enoughGap = this.lastCountAtMs == null || sample.t - this.lastCountAtMs >= MIN_REP_GAP_MS;

    if (this.armed && metrics.strokeValue > DROP && enoughPull && enoughGap) {
      this.count += 1;
      this.lastCountAtMs = sample.t;
      this.armed = false;
    }

    this.lastSnapshot = {
      count: this.count,
      phase: metrics.phase,
      quality: metrics.quality,
      strokeValue: metrics.strokeValue,
      lastRepMs: this.lastCountAtMs,
      statusText: this.armed ? "Pull your hands down" : "Raise both hands overhead"
    };
    return this.lastSnapshot;
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
