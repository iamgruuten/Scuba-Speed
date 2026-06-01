export type CompactPoseSample = {
  t: number;
  p: number[];
};

export type SessionSummary = {
  localCount: number;
  qualityAvg: number;
  durationMs: number;
  samples: number;
};

export type StartRunInput = {
  displayName?: unknown;
};

export type SubmitRunInput = {
  runId?: unknown;
  nonce?: unknown;
  displayName?: unknown;
  telemetry?: unknown;
  summary?: unknown;
};

export type ValidationResult = {
  accepted: boolean;
  officialScore: number;
  verifiedDurationMs: number;
  qualityAvg: number;
  samples: number;
  flags: string[];
  cadence: number;
};
