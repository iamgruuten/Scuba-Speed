export type RunStatus = "idle" | "loading-model" | "ready" | "countdown" | "running" | "submitting" | "finished" | "error";

export type CompactPoseSample = {
  /** elapsed milliseconds since the run began */
  t: number;
  /** fixed order: leftShoulder, rightShoulder, leftElbow, rightElbow, leftWrist, rightWrist. Each point is x,y,visibility. */
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

/** Result of a finished run, scored entirely on-device. */
export type RunResult = {
  accepted: boolean;
  officialScore: number;
  durationMs: number;
  qualityAvg: number;
  isNewBest: boolean;
  message: string;
};

/** A single entry in the on-device (localStorage) leaderboard. */
export type LeaderboardEntry = {
  id: string;
  displayName: string;
  bestScore: number;
  bestDurationMs: number;
  bestQualityAvg: number;
  updatedAt: number;
};

export type SessionSummary = {
  localCount: number;
  qualityAvg: number;
  durationMs: number;
  samples: number;
};
