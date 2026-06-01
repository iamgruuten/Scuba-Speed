import { createHash, randomBytes, randomUUID } from "crypto";
import { FieldValue, Firestore, Timestamp } from "firebase-admin/firestore";
import { HttpsError, type CallableRequest } from "firebase-functions/v2/https";

export const REGION = "asia-southeast1";
export const MAX_DURATION_MS = 60_000;
export const SAMPLE_INTERVAL_MS = 83; // ~12 Hz. Enough for validation, small payload.
export const SESSION_TTL_MS = 2 * 60_000;

const BAD_WORDS = [
  "admin",
  "firebase",
  "google",
  "moderator",
  "system",
  "owner"
];

export function newRunId(): string {
  return randomUUID();
}

export function newNonce(): string {
  return randomBytes(20).toString("hex");
}

export function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export function sanitizeDisplayName(value: unknown): string {
  const text = typeof value === "string" ? value : "";
  const cleaned = text
    .replace(/[^a-zA-Z0-9 _.-]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 18);

  const lower = cleaned.toLowerCase();
  if (!cleaned || BAD_WORDS.some((word) => lower.includes(word))) return "Diver";
  return cleaned;
}

export function requireAuthUid(request: CallableRequest): string {
  const uid = request.auth?.uid;
  if (!uid) {
    throw new HttpsError("unauthenticated", "Sign in is required.");
  }
  return uid;
}

export function clientIpHash(request: CallableRequest): string | null {
  const headers = request.rawRequest?.headers;
  const forwarded = headers?.["x-forwarded-for"];
  const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  const ip = raw?.split(",")[0]?.trim() || request.rawRequest?.ip;
  if (!ip) return null;
  return sha256(`ip:${ip}`).slice(0, 32);
}

export async function enforceRateLimit(
  db: Firestore,
  bucketId: string,
  maxEvents: number,
  windowMs: number
): Promise<void> {
  const safeBucket = sha256(bucketId).slice(0, 48);
  const ref = db.doc(`rateLimits/${safeBucket}`);
  const now = Date.now();

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const data = snap.exists ? snap.data() : undefined;
    const windowStartMs = typeof data?.windowStartMs === "number" ? data.windowStartMs : 0;
    const count = typeof data?.count === "number" ? data.count : 0;

    if (!snap.exists || now - windowStartMs > windowMs) {
      tx.set(ref, {
        windowStartMs: now,
        count: 1,
        updatedAt: FieldValue.serverTimestamp(),
        expireAt: Timestamp.fromMillis(now + windowMs * 3)
      });
      return;
    }

    if (count >= maxEvents) {
      throw new HttpsError("resource-exhausted", "Too many attempts. Try again later.");
    }

    tx.update(ref, {
      count: count + 1,
      updatedAt: FieldValue.serverTimestamp()
    });
  });
}

export function assertString(value: unknown, name: string, min = 1, max = 160): string {
  if (typeof value !== "string" || value.length < min || value.length > max) {
    throw new HttpsError("invalid-argument", `${name} is invalid.`);
  }
  return value;
}
