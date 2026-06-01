import type { CompactPoseSample, CounterSnapshot, ScubaMetrics } from "../types";

const REQUIRED_POINTS = 8;
const STRIDE = 3;
const HIGH_THRESHOLD = 0.16; // hands above/near shoulder line
const LOW_THRESHOLD = 0.72; // hands near hips after the pull
const MIN_PULL_MS = 170;
const MIN_REP_GAP_MS = 240;
const MAX_MISSING_MS = 650;

type Point = { x: number; y: number; v: number };

function point(sample: CompactPoseSample, index: number): Point {
  const base = index * STRIDE;
  return {
    x: sample.p[base],
    y: sample.p[base + 1],
    v: sample.p[base + 2]
  };
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
    const coordSlot = index % STRIDE;
    if (coordSlot === 2) return clamp01(value);
    return value;
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
  const le = point(sample, 2);
  const re = point(sample, 3);
  const lw = point(sample, 4);
  const rw = point(sample, 5);
  const lh = point(sample, 6);
  const rh = point(sample, 7);

  const minVisibility = Math.min(ls.v, rs.v, le.v, re.v, lw.v, rw.v, lh.v, rh.v);
  const shoulderY = (ls.y + rs.y) / 2;
  const hipY = (lh.y + rh.y) / 2;
  const torso = hipY - shoulderY;
  const shoulderWidth = Math.abs(ls.x - rs.x);

  if (minVisibility < 0.42) {
    return { valid: false, quality: minVisibility, phase: "hidden", strokeValue: 0, torso, symmetry: 1, reason: "low-visibility" };
  }

  if (torso < 0.13 || torso > 0.75 || shoulderWidth < 0.06) {
    return { valid: false, quality: 0.2, phase: "hidden", strokeValue: 0, torso, symmetry: 1, reason: "bad-framing" };
  }

  const avgWristY = (lw.y + rw.y) / 2;
  const strokeValue = (avgWristY - shoulderY) / torso;
  const symmetry = Math.abs(lw.y - rw.y) / Math.max(0.001, torso);
  const elbowSanity = Math.abs(le.y - re.y) / Math.max(0.001, torso);

  const symmetryScore = clamp01(1 - symmetry / 0.62);
  const elbowScore = clamp01(1 - elbowSanity / 0.9);
  const frameScore = clamp01((torso - 0.13) / 0.22);
  const quality = clamp01(0.45 * minVisibility + 0.3 * symmetryScore + 0.15 * elbowScore + 0.1 * frameScore);

  let phase: ScubaMetrics["phase"] = "pull";
  if (strokeValue < HIGH_THRESHOLD) phase = "raise";
  if (quality < 0.48 || symmetry > 0.8) phase = "hidden";

  return {
    valid: quality >= 0.48,
    quality,
    phase,
    strokeValue,
    torso,
    symmetry,
    reason: quality >= 0.48 ? undefined : "low-quality"
  };
}

export class ScubaCounterEngine {
  private count = 0;
  private readyToPull = false;
  private raisedAtMs: number | null = null;
  private lastCountAtMs: number | null = null;
  private lastValidAtMs: number | null = null;
  private lastSnapshot: CounterSnapshot = {
    count: 0,
    phase: "hidden",
    quality: 0,
    strokeValue: 0,
    lastRepMs: null,
    statusText: "Show your shoulders, hips, and hands"
  };

  reset(): void {
    this.count = 0;
    this.readyToPull = false;
    this.raisedAtMs = null;
    this.lastCountAtMs = null;
    this.lastValidAtMs = null;
    this.lastSnapshot = {
      count: 0,
      phase: "hidden",
      quality: 0,
      strokeValue: 0,
      lastRepMs: null,
      statusText: "Raise both hands to arm the counter"
    };
  }

  update(sample: CompactPoseSample): CounterSnapshot {
    const metrics = computeScubaMetrics(sample);

    if (!metrics.valid) {
      const recentlyValid = this.lastValidAtMs != null && sample.t - this.lastValidAtMs < MAX_MISSING_MS;
      this.lastSnapshot = {
        count: this.count,
        phase: recentlyValid ? this.lastSnapshot.phase : "hidden",
        quality: metrics.quality,
        strokeValue: metrics.strokeValue,
        lastRepMs: this.lastCountAtMs,
        statusText: recentlyValid ? "Keep moving" : "Step back: full upper body in frame"
      };
      return this.lastSnapshot;
    }

    this.lastValidAtMs = sample.t;

    if (metrics.strokeValue < HIGH_THRESHOLD) {
      this.readyToPull = true;
      this.raisedAtMs = sample.t;
    }

    const enoughPullTime = this.raisedAtMs == null ? false : sample.t - this.raisedAtMs >= MIN_PULL_MS;
    const enoughGap = this.lastCountAtMs == null || sample.t - this.lastCountAtMs >= MIN_REP_GAP_MS;

    if (this.readyToPull && metrics.strokeValue > LOW_THRESHOLD && enoughPullTime && enoughGap && metrics.quality > 0.56) {
      this.count += 1;
      this.lastCountAtMs = sample.t;
      this.readyToPull = false;
    }

    const statusText = this.readyToPull
      ? "Pull down like a scuba stroke"
      : "Raise both hands above shoulders";

    this.lastSnapshot = {
      count: this.count,
      phase: metrics.phase,
      quality: metrics.quality,
      strokeValue: metrics.strokeValue,
      lastRepMs: this.lastCountAtMs,
      statusText
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
