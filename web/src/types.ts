export type RunStatus = "idle" | "loading-model" | "ready" | "countdown" | "running" | "submitting" | "finished" | "error";

export type CompactPoseSample = {
  /** elapsed milliseconds since the server-authorized run began */
  t: number;
  /** fixed order: leftShoulder, rightShoulder, leftElbow, rightElbow, leftWrist, rightWrist, leftHip, rightHip. Each point is x,y,visibility. */
  p: number[];
};

export type ScubaMetrics = {
  valid: boolean;
  quality: number;
  phase: "raise" | "pull" | "hidden";
  strokeValue: number;
  torso: number;
  symmetry: number;
  reason?: string;
};

export type CounterSnapshot = {
  count: number;
  phase: ScubaMetrics["phase"];
  quality: number;
  strokeValue: number;
  lastRepMs: number | null;
  statusText: string;
};

export type StartRunOutput = {
  runId: string;
  nonce: string;
  serverTimeMs: number;
  maxDurationMs: number;
  sampleIntervalMs: number;
};

export type SubmitRunOutput = {
  accepted: boolean;
  officialScore: number;
  verifiedDurationMs: number;
  rankHint?: number;
  message: string;
  flags: string[];
};

export type LeaderboardEntry = {
  uid: string;
  displayName: string;
  bestScore: number;
  bestDurationMs: number;
  updatedAt?: unknown;
  runId: string;
  verified: boolean;
};

export type SessionSummary = {
  localCount: number;
  qualityAvg: number;
  durationMs: number;
  samples: number;
};
