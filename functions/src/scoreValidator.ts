import { HttpsError } from "firebase-functions/v2/https";
import type { CompactPoseSample, SessionSummary, ValidationResult } from "./types";
import { MAX_DURATION_MS, SAMPLE_INTERVAL_MS } from "./security";

const REQUIRED_POINTS = 8;
const STRIDE = 3;
const HIGH_THRESHOLD = 0.16;
const LOW_THRESHOLD = 0.72;
const MIN_PULL_MS = 170;
const MIN_REP_GAP_MS = 240;
const MAX_TELEMETRY_SAMPLES = 1300;
const MIN_TELEMETRY_SAMPLES = 24;
const MAX_CADENCE_PER_SECOND = 3.85;

type Point = { x: number; y: number; v: number };
type Metrics = {
  valid: boolean;
  quality: number;
  strokeValue: number;
  torso: number;
  symmetry: number;
  reason?: string;
};

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function point(sample: CompactPoseSample, index: number): Point {
  const base = index * STRIDE;
  return {
    x: sample.p[base],
    y: sample.p[base + 1],
    v: sample.p[base + 2]
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function parseSummary(raw: unknown): SessionSummary {
  if (!isPlainObject(raw)) {
    return { localCount: 0, qualityAvg: 0, durationMs: 0, samples: 0 };
  }

  return {
    localCount: finiteNumber(raw.localCount),
    qualityAvg: finiteNumber(raw.qualityAvg),
    durationMs: finiteNumber(raw.durationMs),
    samples: finiteNumber(raw.samples)
  };
}

export function parseTelemetry(raw: unknown): CompactPoseSample[] {
  if (!Array.isArray(raw)) {
    throw new HttpsError("invalid-argument", "Telemetry must be an array.");
  }
  if (raw.length > MAX_TELEMETRY_SAMPLES) {
    throw new HttpsError("invalid-argument", "Telemetry payload is too large.");
  }
  if (raw.length < MIN_TELEMETRY_SAMPLES) {
    throw new HttpsError("invalid-argument", "Telemetry payload is too small.");
  }

  const samples: CompactPoseSample[] = [];
  let lastT = -1;

  for (const item of raw) {
    if (!isPlainObject(item) || typeof item.t !== "number" || !Number.isFinite(item.t) || !Array.isArray(item.p)) {
      throw new HttpsError("invalid-argument", "Telemetry contains invalid samples.");
    }

    const t = Math.round(item.t);
    if (t < 0 || t <= lastT || t > MAX_DURATION_MS + 2500) {
      throw new HttpsError("invalid-argument", "Telemetry timestamps are invalid.");
    }
    lastT = t;

    const p = item.p.map((value, index) => {
      if (!Number.isFinite(value)) {
        throw new HttpsError("invalid-argument", "Telemetry contains non-finite coordinates.");
      }
      const n = Number(value);
      const coordSlot = index % STRIDE;
      if (coordSlot === 2) return clamp01(n);
      if (n < -0.35 || n > 1.35) {
        throw new HttpsError("invalid-argument", "Telemetry coordinates are outside plausible bounds.");
      }
      return Math.round(n * 10000) / 10000;
    });

    if (p.length !== REQUIRED_POINTS * STRIDE) {
      throw new HttpsError("invalid-argument", "Telemetry has the wrong point count.");
    }

    samples.push({ t, p });
  }

  return samples;
}

function computeMetrics(sample: CompactPoseSample): Metrics {
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
    return { valid: false, quality: minVisibility, strokeValue: 0, torso, symmetry: 1, reason: "low-visibility" };
  }

  if (torso < 0.13 || torso > 0.75 || shoulderWidth < 0.06) {
    return { valid: false, quality: 0.2, strokeValue: 0, torso, symmetry: 1, reason: "bad-framing" };
  }

  const avgWristY = (lw.y + rw.y) / 2;
  const strokeValue = (avgWristY - shoulderY) / torso;
  const symmetry = Math.abs(lw.y - rw.y) / Math.max(0.001, torso);
  const elbowSanity = Math.abs(le.y - re.y) / Math.max(0.001, torso);

  const symmetryScore = clamp01(1 - symmetry / 0.62);
  const elbowScore = clamp01(1 - elbowSanity / 0.9);
  const frameScore = clamp01((torso - 0.13) / 0.22);
  const quality = clamp01(0.45 * minVisibility + 0.3 * symmetryScore + 0.15 * elbowScore + 0.1 * frameScore);

  return {
    valid: quality >= 0.48 && symmetry <= 0.8,
    quality,
    strokeValue,
    torso,
    symmetry,
    reason: quality >= 0.48 ? undefined : "low-quality"
  };
}

class ServerScubaCounter {
  count = 0;
  readyToPull = false;
  raisedAtMs: number | null = null;
  lastCountAtMs: number | null = null;

  update(sample: CompactPoseSample): Metrics {
    const metrics = computeMetrics(sample);
    if (!metrics.valid) return metrics;

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

    return metrics;
  }
}

function consecutiveDuplicateRatio(samples: CompactPoseSample[]): number {
  if (samples.length < 2) return 0;
  let duplicates = 0;
  for (let i = 1; i < samples.length; i += 1) {
    let same = true;
    for (let j = 0; j < samples[i].p.length; j += 1) {
      if (Math.abs(samples[i].p[j] - samples[i - 1].p[j]) > 0.0001) {
        same = false;
        break;
      }
    }
    if (same) duplicates += 1;
  }
  return duplicates / (samples.length - 1);
}

function strokeRange(samples: CompactPoseSample[]): number {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const sample of samples) {
    const metrics = computeMetrics(sample);
    if (!metrics.valid) continue;
    min = Math.min(min, metrics.strokeValue);
    max = Math.max(max, metrics.strokeValue);
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return 0;
  return max - min;
}

export function validateTelemetry(samples: CompactPoseSample[], summary: SessionSummary): ValidationResult {
  const flags: string[] = [];
  const durationMs = samples[samples.length - 1].t - samples[0].t;

  if (durationMs < 4_000) flags.push("duration-too-short");
  if (durationMs > MAX_DURATION_MS + 1500) flags.push("duration-too-long");

  const sampleRate = samples.length / Math.max(0.001, durationMs / 1000);
  if (sampleRate < 5) flags.push("sample-rate-too-low");
  if (sampleRate > Math.ceil(1000 / SAMPLE_INTERVAL_MS) + 8) flags.push("sample-rate-too-high");

  const duplicateRatio = consecutiveDuplicateRatio(samples);
  if (duplicateRatio > 0.32) flags.push("too-many-duplicate-frames");

  const counter = new ServerScubaCounter();
  let qualityTotal = 0;
  let validFrames = 0;

  for (const sample of samples) {
    const metrics = counter.update(sample);
    qualityTotal += metrics.quality;
    if (metrics.valid) validFrames += 1;
  }

  const qualityAvg = qualityTotal / samples.length;
  const validRatio = validFrames / samples.length;
  const officialScore = counter.count;
  const cadence = officialScore / Math.max(0.001, durationMs / 1000);
  const range = strokeRange(samples);

  if (qualityAvg < 0.5) flags.push("quality-too-low");
  if (validRatio < 0.55) flags.push("too-few-valid-frames");
  if (officialScore > 0 && range < 0.58) flags.push("motion-range-too-small");
  if (cadence > MAX_CADENCE_PER_SECOND) flags.push("cadence-too-fast");
  if (Math.abs(summary.localCount - officialScore) > 2) flags.push("client-score-mismatch");
  if (Math.abs(summary.samples - samples.length) > 2) flags.push("client-sample-mismatch");

  const severe = new Set([
    "duration-too-short",
    "duration-too-long",
    "sample-rate-too-low",
    "sample-rate-too-high",
    "too-many-duplicate-frames",
    "quality-too-low",
    "too-few-valid-frames",
    "motion-range-too-small",
    "cadence-too-fast"
  ]);

  const accepted = officialScore > 0 && !flags.some((flag) => severe.has(flag));

  return {
    accepted,
    officialScore,
    verifiedDurationMs: Math.round(durationMs),
    qualityAvg: Math.round(qualityAvg * 1000) / 1000,
    samples: samples.length,
    flags,
    cadence: Math.round(cadence * 1000) / 1000
  };
}
