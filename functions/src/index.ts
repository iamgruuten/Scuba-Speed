import { initializeApp } from "firebase-admin/app";
import { FieldValue, Timestamp, getFirestore } from "firebase-admin/firestore";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import {
  REGION,
  MAX_DURATION_MS,
  SAMPLE_INTERVAL_MS,
  SESSION_TTL_MS,
  assertString,
  clientIpHash,
  enforceRateLimit,
  newNonce,
  newRunId,
  requireAuthUid,
  sanitizeDisplayName,
  sha256
} from "./security";
import { parseSummary, parseTelemetry, validateTelemetry } from "./scoreValidator";
import type { StartRunInput, SubmitRunInput, ValidationResult } from "./types";

initializeApp();
const db = getFirestore();

const callableOptions = {
  region: REGION,
  enforceAppCheck: true,
  consumeAppCheckToken: true,
  timeoutSeconds: 30,
  memory: "512MiB" as const,
  maxInstances: 40
};

export const startRun = onCall(callableOptions, async (request) => {
  const uid = requireAuthUid(request);
  const data = (request.data ?? {}) as StartRunInput;
  const displayName = sanitizeDisplayName(data.displayName);
  const ipHash = clientIpHash(request);

  await enforceRateLimit(db, `uid:${uid}:start`, 8, 60_000);
  if (ipHash) await enforceRateLimit(db, `ip:${ipHash}:start`, 60, 60_000);

  const runId = newRunId();
  const nonce = newNonce();
  const now = Date.now();
  const nonceHash = sha256(`${uid}:${runId}:${nonce}`);

  await db.doc(`runs/${runId}`).set({
    uid,
    displayName,
    status: "started",
    nonceHash,
    appId: request.app?.appId ?? null,
    ipHash,
    issuedAt: FieldValue.serverTimestamp(),
    expireAt: Timestamp.fromMillis(now + SESSION_TTL_MS),
    maxDurationMs: MAX_DURATION_MS,
    sampleIntervalMs: SAMPLE_INTERVAL_MS,
    schemaVersion: 1
  });

  logger.info("SCUBA run started", { uid, runId, appId: request.app?.appId ?? null });

  return {
    runId,
    nonce,
    serverTimeMs: now,
    maxDurationMs: MAX_DURATION_MS,
    sampleIntervalMs: SAMPLE_INTERVAL_MS
  };
});

export const submitRun = onCall(callableOptions, async (request) => {
  const uid = requireAuthUid(request);
  const data = (request.data ?? {}) as SubmitRunInput;

  const runId = assertString(data.runId, "runId", 8, 90);
  const nonce = assertString(data.nonce, "nonce", 20, 80);
  const displayName = sanitizeDisplayName(data.displayName);
  const ipHash = clientIpHash(request);

  await enforceRateLimit(db, `uid:${uid}:submit`, 6, 60_000);
  if (ipHash) await enforceRateLimit(db, `ip:${ipHash}:submit`, 45, 60_000);

  const telemetry = parseTelemetry(data.telemetry);
  const summary = parseSummary(data.summary);
  const validation = validateTelemetry(telemetry, summary);
  const telemetryHash = sha256(JSON.stringify(telemetry));
  const expectedNonceHash = sha256(`${uid}:${runId}:${nonce}`);
  const now = Date.now();

  const runRef = db.doc(`runs/${runId}`);
  const leaderboardRef = db.doc(`leaderboard/${uid}`);
  let savedValidation: ValidationResult = validation;
  let updatedLeaderboard = false;

  await db.runTransaction(async (tx) => {
    const [runSnap, leaderSnap] = await Promise.all([tx.get(runRef), tx.get(leaderboardRef)]);

    if (!runSnap.exists) {
      throw new HttpsError("not-found", "Run session was not found.");
    }

    const run = runSnap.data();
    if (!run || run.uid !== uid) {
      throw new HttpsError("permission-denied", "Run does not belong to this user.");
    }
    if (run.status !== "started") {
      throw new HttpsError("failed-precondition", "Run was already submitted.");
    }
    if (run.nonceHash !== expectedNonceHash) {
      throw new HttpsError("permission-denied", "Run proof is invalid.");
    }

    const expireAt = run.expireAt instanceof Timestamp ? run.expireAt.toMillis() : 0;
    if (expireAt < now) {
      savedValidation = { ...validation, accepted: false, flags: [...validation.flags, "session-expired"] };
    }

    tx.update(runRef, {
      status: savedValidation.accepted ? "accepted" : "rejected",
      submittedAt: FieldValue.serverTimestamp(),
      displayName,
      appId: request.app?.appId ?? null,
      ipHash,
      telemetryHash,
      clientSummary: summary,
      validation: savedValidation
    });

    if (!savedValidation.accepted) return;

    const current = leaderSnap.exists ? leaderSnap.data() : undefined;
    const currentScore = typeof current?.bestScore === "number" ? current.bestScore : -1;
    const currentDuration = typeof current?.bestDurationMs === "number" ? current.bestDurationMs : Number.POSITIVE_INFINITY;
    const isBetter =
      savedValidation.officialScore > currentScore ||
      (savedValidation.officialScore === currentScore && savedValidation.verifiedDurationMs < currentDuration);

    if (isBetter) {
      updatedLeaderboard = true;
      tx.set(
        leaderboardRef,
        {
          uid,
          displayName,
          bestScore: savedValidation.officialScore,
          bestDurationMs: savedValidation.verifiedDurationMs,
          bestQualityAvg: savedValidation.qualityAvg,
          bestCadence: savedValidation.cadence,
          runId,
          verified: true,
          updatedAt: FieldValue.serverTimestamp(),
          createdAt: current?.createdAt ?? FieldValue.serverTimestamp(),
          schemaVersion: 1
        },
        { merge: true }
      );
    }
  });

  logger.info("SCUBA run submitted", {
    uid,
    runId,
    accepted: savedValidation.accepted,
    score: savedValidation.officialScore,
    flags: savedValidation.flags,
    updatedLeaderboard
  });

  return {
    accepted: savedValidation.accepted,
    officialScore: savedValidation.officialScore,
    verifiedDurationMs: savedValidation.verifiedDurationMs,
    message: savedValidation.accepted
      ? updatedLeaderboard
        ? "Verified and leaderboard updated."
        : "Verified. Your previous best is still higher."
      : `Rejected by validator: ${savedValidation.flags.join(", ") || "unknown reason"}.`,
    flags: savedValidation.flags
  };
});
