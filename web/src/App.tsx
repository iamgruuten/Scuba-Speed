import { useEffect, useMemo, useRef, useState } from "react";
import { Camera, CheckCircle2, Lock, Medal, Play, RotateCcw, ShieldCheck, Waves } from "lucide-react";
import type { NormalizedLandmark, PoseLandmarker } from "@mediapipe/tasks-vision";
import {
  ensureAnonymousUser,
  startVerifiedRun,
  submitVerifiedRun,
  subscribeLeaderboard
} from "./firebase";
import { ScubaCounterEngine, summarizeQuality } from "./lib/counter";
import {
  createPoseLandmarker,
  drawPoseOverlay,
  makeCompactSample,
  startCamera,
  stopCamera
} from "./lib/pose";
import type { CompactPoseSample, LeaderboardEntry, RunStatus, SubmitRunOutput } from "./types";

const DEFAULT_DURATION_SECONDS = 30;
const COUNTDOWN_SECONDS = 3;
const MAX_LOCAL_SAMPLES = 1300;

function safeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return "Something went wrong.";
}

function formatTime(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  return `${seconds}s`;
}

function sanitizeDisplayName(value: string): string {
  return value.replace(/[^a-zA-Z0-9 _.-]/g, "").trim().slice(0, 18) || "Diver";
}

export default function App() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const landmarkerRef = useRef<PoseLandmarker | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number | null>(null);
  const engineRef = useRef(new ScubaCounterEngine());
  const telemetryRef = useRef<CompactPoseSample[]>([]);
  const finishingRef = useRef(false);
  const runRef = useRef<{
    active: boolean;
    runId: string;
    nonce: string;
    startedAtPerf: number;
    durationMs: number;
    lastSampleAtPerf: number;
    sampleIntervalMs: number;
    displayName: string;
  } | null>(null);

  const [status, setStatus] = useState<RunStatus>("idle");
  const [cameraReady, setCameraReady] = useState(false);
  const [displayName, setDisplayName] = useState(() => localStorage.getItem("scuba-name") || "");
  const [durationSeconds, setDurationSeconds] = useState(DEFAULT_DURATION_SECONDS);
  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [localCount, setLocalCount] = useState(0);
  const [official, setOfficial] = useState<SubmitRunOutput | null>(null);
  const [quality, setQuality] = useState(0);
  const [stageText, setStageText] = useState("Enable camera to calibrate");
  const [remainingMs, setRemainingMs] = useState(DEFAULT_DURATION_SECONDS * 1000);
  const [sampleCount, setSampleCount] = useState(0);

  const cleanName = useMemo(() => sanitizeDisplayName(displayName), [displayName]);
  const canStart = cameraReady && status !== "running" && status !== "submitting" && status !== "countdown";

  useEffect(() => {
    let unsubscribeLeaderboard: (() => void) | null = null;

    ensureAnonymousUser()
      .then(() => {
        unsubscribeLeaderboard = subscribeLeaderboard(setLeaderboard, (err) => setError(safeError(err)));
      })
      .catch((err) => setError(safeError(err)));

    return () => {
      unsubscribeLeaderboard?.();
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      stopCamera(streamRef.current);
      landmarkerRef.current?.close();
    };
  }, []);

  function syncCanvasSize() {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas || video.videoWidth === 0 || video.videoHeight === 0) return;
    if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) {
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
    }
  }

  function startLoop() {
    if (rafRef.current != null) cancelAnimationFrame(rafRef.current);

    const tick = () => {
      const video = videoRef.current;
      const canvas = canvasRef.current;
      const landmarker = landmarkerRef.current;

      if (video && canvas && landmarker && video.readyState >= 2) {
        syncCanvasSize();
        const now = performance.now();
        const result = landmarker.detectForVideo(video, now);
        const landmarks: NormalizedLandmark[] | null = result.landmarks?.[0] ?? null;
        let currentQuality = quality;

        const run = runRef.current;
        if (run?.active && landmarks) {
          const elapsedMs = now - run.startedAtPerf;
          const sampleDue = now - run.lastSampleAtPerf >= run.sampleIntervalMs;
          setRemainingMs(run.durationMs - elapsedMs);

          if (sampleDue && elapsedMs >= 0) {
            run.lastSampleAtPerf = now;
            const sample = makeCompactSample(landmarks, elapsedMs);
            if (sample && telemetryRef.current.length < MAX_LOCAL_SAMPLES) {
              telemetryRef.current.push(sample);
              setSampleCount(telemetryRef.current.length);
              const snapshot = engineRef.current.update(sample);
              currentQuality = snapshot.quality;
              setLocalCount(snapshot.count);
              setQuality(snapshot.quality);
              setStageText(snapshot.statusText);
            }
          }

          if (elapsedMs >= run.durationMs && !finishingRef.current) {
            void finishRun();
          }
        } else if (landmarks) {
          currentQuality = engineRef.current.snapshot().quality;
        }

        drawPoseOverlay(canvas, landmarks, currentQuality);
      }

      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);
  }

  async function enableCamera() {
    try {
      setError(null);
      setStatus("loading-model");
      setStageText("Loading pose model…");
      if (!landmarkerRef.current) {
        landmarkerRef.current = await createPoseLandmarker();
      }
      if (!videoRef.current) throw new Error("Video element is not ready.");
      streamRef.current = await startCamera(videoRef.current);
      setCameraReady(true);
      setStatus("ready");
      setStageText("Raise both hands above shoulders");
      startLoop();
    } catch (err) {
      setStatus("error");
      setError(safeError(err));
    }
  }

  async function startRun() {
    if (!canStart) return;

    try {
      setError(null);
      setOfficial(null);
      setLocalCount(0);
      setSampleCount(0);
      setQuality(0);
      setRemainingMs(durationSeconds * 1000);
      finishingRef.current = false;
      localStorage.setItem("scuba-name", cleanName);

      const authorized = await startVerifiedRun(cleanName);
      engineRef.current.reset();
      telemetryRef.current = [];
      setStatus("countdown");

      for (let seconds = COUNTDOWN_SECONDS; seconds > 0; seconds -= 1) {
        setCountdown(seconds);
        await new Promise((resolve) => setTimeout(resolve, 820));
      }

      setCountdown(null);
      const start = performance.now();
      runRef.current = {
        active: true,
        runId: authorized.runId,
        nonce: authorized.nonce,
        startedAtPerf: start,
        durationMs: Math.min(durationSeconds * 1000, authorized.maxDurationMs),
        lastSampleAtPerf: start - authorized.sampleIntervalMs,
        sampleIntervalMs: authorized.sampleIntervalMs,
        displayName: cleanName
      };
      setStatus("running");
      setStageText("Raise both hands above shoulders");
    } catch (err) {
      setCountdown(null);
      setStatus(cameraReady ? "ready" : "error");
      setError(safeError(err));
    }
  }

  async function finishRun() {
    const run = runRef.current;
    if (!run || finishingRef.current) return;
    finishingRef.current = true;
    run.active = false;
    setStatus("submitting");
    setStageText("Verifying score on server…");

    const telemetry = telemetryRef.current.slice();
    const durationMs = telemetry.length > 0 ? telemetry[telemetry.length - 1].t : run.durationMs;
    const officialLocalCount = engineRef.current.snapshot().count;
    const summary = {
      localCount: officialLocalCount,
      durationMs,
      qualityAvg: summarizeQuality(telemetry),
      samples: telemetry.length
    };

    try {
      const result = await submitVerifiedRun({
        runId: run.runId,
        nonce: run.nonce,
        displayName: run.displayName,
        telemetry,
        summary
      });
      setOfficial(result);
      setLocalCount(result.officialScore);
      setStatus("finished");
      setStageText(result.accepted ? "Official score verified" : "Run rejected by validator");
    } catch (err) {
      setStatus("ready");
      setError(safeError(err));
      setStageText("Run was not submitted");
    } finally {
      runRef.current = null;
      finishingRef.current = false;
    }
  }

  function resetRun() {
    runRef.current = null;
    finishingRef.current = false;
    telemetryRef.current = [];
    engineRef.current.reset();
    setOfficial(null);
    setLocalCount(0);
    setQuality(0);
    setSampleCount(0);
    setRemainingMs(durationSeconds * 1000);
    setStageText(cameraReady ? "Raise both hands above shoulders" : "Enable camera to calibrate");
    setStatus(cameraReady ? "ready" : "idle");
    setCountdown(null);
  }

  return (
    <main className="shell">
      <section className="hero">
        <div>
          <p className="eyebrow"><Waves size={18} /> Viral camera challenge</p>
          <h1>SCUBA Counter</h1>
          <p className="hero-copy">
            Raise both hands, pull down like an underwater scuba stroke, and race the live leaderboard.
            Scores are verified by Firebase Cloud Functions from pose telemetry before they are published.
          </p>
        </div>
        <div className="trust-pill"><ShieldCheck size={18} /> App Check + server scoring</div>
      </section>

      <section className="grid">
        <div className="camera-card">
          <div className="camera-frame">
            <video ref={videoRef} className="camera-video" aria-label="Camera preview" />
            <canvas ref={canvasRef} className="pose-canvas" />

            {!cameraReady && (
              <div className="camera-empty">
                <Camera size={48} />
                <strong>Camera stays local</strong>
                <span>Only compact pose points are submitted for verification. No video is uploaded.</span>
              </div>
            )}

            {countdown != null && (
              <div className="countdown" aria-live="assertive">{countdown}</div>
            )}

            <div className="hud top-left">
              <span className="label">Official target</span>
              <strong>{formatTime(remainingMs)}</strong>
            </div>
            <div className="hud top-right">
              <span className="label">Tracking</span>
              <strong>{Math.round(quality * 100)}%</strong>
            </div>
            <div className="count-hud" aria-live="polite">
              <span>SCUBA</span>
              <strong>{localCount}</strong>
            </div>
          </div>

          <div className="motion-coach">
            <div>
              <span className="label">Coach</span>
              <strong>{stageText}</strong>
            </div>
            <div className="quality-bar" aria-label={`Tracking quality ${Math.round(quality * 100)} percent`}>
              <span style={{ width: `${Math.max(5, Math.round(quality * 100))}%` }} />
            </div>
          </div>

          {error && <div className="notice error">{error}</div>}
          {official && (
            <div className={official.accepted ? "notice success" : "notice error"}>
              <CheckCircle2 size={18} />
              <span>{official.message} Score: {official.officialScore}. Samples checked: {sampleCount}.</span>
            </div>
          )}
        </div>

        <aside className="control-card">
          <div className="section-heading">
            <span>Controls</span>
            <Lock size={17} />
          </div>

          <label className="field">
            <span>Diver name</span>
            <input
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              maxLength={18}
              placeholder="Diver"
              autoComplete="nickname"
            />
          </label>

          <label className="field">
            <span>Run length</span>
            <select value={durationSeconds} onChange={(event) => setDurationSeconds(Number(event.target.value))}>
              <option value={15}>15 seconds</option>
              <option value={30}>30 seconds</option>
              <option value={45}>45 seconds</option>
              <option value={60}>60 seconds</option>
            </select>
          </label>

          <div className="button-row">
            {!cameraReady ? (
              <button className="primary" onClick={enableCamera} disabled={status === "loading-model"}>
                <Camera size={19} /> {status === "loading-model" ? "Loading…" : "Enable camera"}
              </button>
            ) : (
              <button className="primary" onClick={startRun} disabled={!canStart}>
                <Play size={19} /> Start dive
              </button>
            )}
            <button className="ghost" onClick={resetRun} disabled={status === "submitting"}>
              <RotateCcw size={18} /> Reset
            </button>
          </div>

          <div className="security-stack">
            <div><ShieldCheck size={18} /> Authenticated anonymous session</div>
            <div><ShieldCheck size={18} /> App Check enforced Functions</div>
            <div><ShieldCheck size={18} /> Firestore writes blocked from client</div>
            <div><ShieldCheck size={18} /> Server recomputes every official score</div>
          </div>
        </aside>
      </section>

      <section className="leaderboard-card">
        <div className="section-heading">
          <span><Medal size={19} /> Online leaderboard</span>
          <small>Best verified score per player</small>
        </div>

        <div className="leaderboard-list">
          {leaderboard.length === 0 && <div className="empty-row">No verified dives yet. Be the first.</div>}
          {leaderboard.map((entry, index) => (
            <div className="leaderboard-row" key={entry.uid}>
              <div className="rank">#{index + 1}</div>
              <div className="diver">
                <strong>{entry.displayName || "Diver"}</strong>
                <span>{Math.round(entry.bestDurationMs / 1000)}s verified run</span>
              </div>
              <div className="score">{entry.bestScore}</div>
            </div>
          ))}
        </div>
      </section>
    </main>
  );
}
