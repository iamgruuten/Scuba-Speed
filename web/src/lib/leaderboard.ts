import type { LeaderboardEntry } from "../types";

const STORAGE_KEY = "scuba-leaderboard-v1";
const MAX_ENTRIES = 25;

function isEntry(value: unknown): value is LeaderboardEntry {
  if (typeof value !== "object" || value === null) return false;
  const e = value as Record<string, unknown>;
  return (
    typeof e.id === "string" &&
    typeof e.displayName === "string" &&
    typeof e.bestScore === "number" &&
    Number.isFinite(e.bestScore) &&
    typeof e.bestDurationMs === "number" &&
    Number.isFinite(e.bestDurationMs)
  );
}

function normalize(value: LeaderboardEntry): LeaderboardEntry {
  return {
    id: value.id,
    displayName: value.displayName,
    bestScore: value.bestScore,
    bestDurationMs: value.bestDurationMs,
    bestQualityAvg: typeof value.bestQualityAvg === "number" && Number.isFinite(value.bestQualityAvg) ? value.bestQualityAvg : 0,
    updatedAt: typeof value.updatedAt === "number" && Number.isFinite(value.updatedAt) ? value.updatedAt : 0
  };
}

function safeParse(raw: string | null): LeaderboardEntry[] {
  if (!raw) return [];
  try {
    const data = JSON.parse(raw);
    if (!Array.isArray(data)) return [];
    return data.filter(isEntry).map(normalize);
  } catch {
    return [];
  }
}

function sortEntries(entries: LeaderboardEntry[]): LeaderboardEntry[] {
  return [...entries].sort((a, b) => b.bestScore - a.bestScore || a.bestDurationMs - b.bestDurationMs);
}

function persist(entries: LeaderboardEntry[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // Storage may be unavailable (private mode / quota). Fail silently; the
    // in-memory leaderboard still updates for this session.
  }
}

function makeId(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
  } catch {
    // fall through to the timestamp-based id
  }
  return `id-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function loadLeaderboard(): LeaderboardEntry[] {
  if (typeof localStorage === "undefined") return [];
  return sortEntries(safeParse(localStorage.getItem(STORAGE_KEY))).slice(0, MAX_ENTRIES);
}

export type SaveResult = { entries: LeaderboardEntry[]; isNewBest: boolean };

/**
 * Saves a run as the player's best score (keyed by case-insensitive name).
 * A higher score wins; on a tie, the shorter duration wins.
 */
export function saveScore(args: {
  displayName: string;
  score: number;
  durationMs: number;
  qualityAvg: number;
}): SaveResult {
  const name = args.displayName.trim() || "Diver";
  const score = Number.isFinite(args.score) ? Math.max(0, Math.round(args.score)) : 0;
  const durationMs = Number.isFinite(args.durationMs) ? Math.max(0, Math.round(args.durationMs)) : 0;
  const qualityAvg = Number.isFinite(args.qualityAvg) ? args.qualityAvg : 0;

  const entries = loadLeaderboard();
  const existingIdx = entries.findIndex((e) => e.displayName.toLowerCase() === name.toLowerCase());
  const now = Date.now();
  let isNewBest = true;

  if (existingIdx >= 0) {
    const prev = entries[existingIdx];
    const better = score > prev.bestScore || (score === prev.bestScore && durationMs < prev.bestDurationMs);
    if (better) {
      entries[existingIdx] = { ...prev, bestScore: score, bestDurationMs: durationMs, bestQualityAvg: qualityAvg, updatedAt: now };
    } else {
      isNewBest = false;
    }
  } else {
    entries.push({ id: makeId(), displayName: name, bestScore: score, bestDurationMs: durationMs, bestQualityAvg: qualityAvg, updatedAt: now });
  }

  const sorted = sortEntries(entries).slice(0, MAX_ENTRIES);
  persist(sorted);
  return { entries: sorted, isNewBest };
}

export function clearLeaderboard(): LeaderboardEntry[] {
  persist([]);
  return [];
}
