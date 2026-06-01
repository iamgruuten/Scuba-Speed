import { useEffect, useMemo, useRef, useState } from "react";
import { Camera, Play, RotateCcw, ShieldCheck, Sparkles, Trash2, Trophy, Waves } from "lucide-react";
import type { NormalizedLandmark, PoseLandmarker } from "@mediapipe/tasks-vision";
import { ScubaCounterEngine, summarizeQuality } from "./lib/counter";
import { clearLeaderboard, loadLeaderboard, saveScore } from "./lib/leaderboard";
import {
  createPoseLandmarker,
  drawPoseOverlay,
  makeCompactSample,
  startCamera,
  stopCamera
} from "./lib/pose";
import type { CompactPoseSample, LeaderboardEntry, RunResult, RunStatus } from "./types";

const DEFAULT_DURATION_SECONDS = 30;
const COUNTDOWN_SECONDS = 3;
const MAX_LOCAL_SAMPLES = 1300;
const MAX_DURATION_MS = 60_000;
const SAMPLE_INTERVAL_MS = 83; // ~12 Hz. Enough for accurate counting, light on the CPU.
const DURATIONS = [15, 30, 45, 60];

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

// --- presentational helpers (avatars for the leaderboard) ---
const AVATAR_HUES = [12, 168, 268, 200, 96, 38, 330, 140];
function avatarColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i += 1) h = (h * 31 + name.charCodeAt(i)) % 360;
  return `oklch(0.62 0.13 ${AVATAR_HUES[h % AVATAR_HUES.length]})`;
}
function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase() || "?";
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
  const [bump, setBump] = useState(0);
  const [official, setOfficial] = useState<RunResult | null>(null);
  const [quality, setQuality] = useState(0);
  const [stageText, setStageText] = useState("Press start when you're ready");
  const [remainingMs, setRemainingMs] = useState(DEFAULT_DURATION_SECONDS * 1000);
  const [sampleCount, setSampleCount] = useState(0);

  const cleanName = useMemo(() => sanitizeDisplayName(displayName), [displayName]);
  const canStart = cameraReady && status !== "running" && status !== "submitting" && status !== "countdown";
  const isRunning = status === "running" || status === "countdown";

  useEffect(() => {
    setLeaderboard(loadLeaderboard());

    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      stopCamera(streamRef.current);
      landmarkerRef.current?.close();
    };
  }, []);

  // Pop the rep counter whenever the live count climbs during a run.
  useEffect(() => {
    if (status === "running" && localCount > 0) setBump((b) => b + 1);
  }, [localCount, status]);

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
            finishRun();
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
        startedAtPerf: start,
        durationMs: Math.min(durationSeconds * 1000, MAX_DURATION_MS),
        lastSampleAtPerf: start - SAMPLE_INTERVAL_MS,
        sampleIntervalMs: SAMPLE_INTERVAL_MS,
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

  function finishRun() {
    const run = runRef.current;
    if (!run || finishingRef.current) return;
    finishingRef.current = true;
    run.active = false;
    setStatus("submitting");
    setStageText("Saving your score…");

    try {
      const telemetry = telemetryRef.current.slice();
      const durationMs = telemetry.length > 0 ? telemetry[telemetry.length - 1].t : run.durationMs;
      const finalCount = engineRef.current.snapshot().count;
      const qualityAvg = summarizeQuality(telemetry);
      const accepted = finalCount > 0;

      if (accepted) {
        const { entries, isNewBest } = saveScore({
          displayName: run.displayName,
          score: finalCount,
          durationMs,
          qualityAvg
        });
        setLeaderboard(entries);
        setOfficial({
          accepted: true,
          officialScore: finalCount,
          durationMs,
          qualityAvg,
          isNewBest,
          message: isNewBest
            ? "New personal best saved to the leaderboard."
            : "Saved — your previous best is still higher."
        });
      } else {
        setOfficial({
          accepted: false,
          officialScore: 0,
          durationMs,
          qualityAvg,
          isNewBest: false,
          message: "No reps detected. Frame your upper body and try again."
        });
      }

      setLocalCount(finalCount);
      setStatus("finished");
      setStageText(accepted ? "Run complete" : "No reps detected");
    } catch (err) {
      setStatus(cameraReady ? "ready" : "error");
      setError(safeError(err));
      setStageText("Run was not saved");
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
    setStageText(cameraReady ? "Raise both hands above shoulders" : "Press start when you're ready");
    setStatus(cameraReady ? "ready" : "idle");
    setCountdown(null);
  }

  function handleClearLeaderboard() {
    setLeaderboard(clearLeaderboard());
    setOfficial(null);
  }

  // Rank of the most recent run within the leaderboard.
  const myRank = useMemo(() => {
    if (!official?.accepted) return null;
    const idx = leaderboard.findIndex((e) => e.displayName.toLowerCase() === cleanName.toLowerCase());
    return idx >= 0 ? idx + 1 : null;
  }, [official, leaderboard, cleanName]);

  const repsPerMin = official?.accepted && official.durationMs > 0
    ? Math.round((official.officialScore / (official.durationMs / 1000)) * 60)
    : 0;

  const hasMyEntry = leaderboard.some((e) => e.displayName.toLowerCase() === cleanName.toLowerCase());
  const showOverlay = isRunning || status === "finished" || status === "submitting";

  return (
    <div>
      <header className="topbar">
        <div className="page topbar-inner">
          <div className="wordmark">
            <span className="glyph"><Waves size={17} /></span>
            <b>Scuba Speed</b>
          </div>
          <nav className="nav">
            <a href="#how" className="hide-sm">How it works</a>
            <a href="#leaderboard">Leaderboard</a>
            <span className="rank-chip"><Trophy size={14} /> {leaderboard.length} ranked</span>
          </nav>
        </div>
      </header>

      <main className="page">
        <section className="hero">
          <p className="kicker"><Trophy size={15} /> Camera speed challenge</p>
          <h1>
            How many strokes can you<br />pull in <span className="accent">{durationSeconds} seconds?</span>
          </h1>
          <p>
            Raise both hands, pull down like a scuba stroke, and rack up reps before the clock runs out.
            Your camera does the counting — every rep lands you on the board.
          </p>
        </section>

        <section className="arena-grid">
          <div className="card arena">
            <div className="stage">
              <video ref={videoRef} className="camera-video" playsInline muted aria-label="Camera preview" />
              <canvas ref={canvasRef} className="pose-canvas" />

              {!cameraReady && (
                <div className="stage-empty">
                  <span className="ring"><Camera size={26} /></span>
                  <strong>Turn on your camera to play</strong>
                  <span>Pose detection runs in your browser. Nothing is recorded or uploaded.</span>
                </div>
              )}

              {countdown != null && <div className="countdown"><span key={countdown}>{countdown}</span></div>}

              {showOverlay && (
                <>
                  <div className="hud tl">
                    <span className="hud-label">Time</span>
                    <span className="hud-val clock">{formatTime(remainingMs)}</span>
                  </div>
                  <div className="hud tr">
                    <span className="hud-label">Tracking</span>
                    <span className="hud-val">{Math.round(quality * 100)}%</span>
                  </div>
                  <div className="repcount" aria-live="polite">
                    <span className={"num" + (bump ? " bump" : "")} key={bump}>{localCount}</span>
                    <span className="reps-label">reps</span>
                  </div>
                </>
              )}
            </div>

            <div className="coach">
              <span className="coach-icon"><Sparkles size={17} /></span>
              <div className="coach-text">
                <span className="lbl">Coach</span>
                <strong>{stageText}</strong>
              </div>
              <div className="track" aria-hidden="true">
                <span style={{ width: `${Math.max(6, Math.round(quality * 100))}%` }} />
              </div>
            </div>

            {error && <div className="notice err"><ShieldCheck size={16} /> {error}</div>}
          </div>

          <aside>
            <div className="card panel">
              <p className="panel-title">Your run</p>

              <div className="field">
                <label htmlFor="diver">Display name</label>
                <input
                  id="diver"
                  value={displayName}
                  onChange={(event) => setDisplayName(event.target.value)}
                  maxLength={18}
                  placeholder="Enter a name"
                  autoComplete="nickname"
                  disabled={isRunning}
                />
              </div>

              <div className="field">
                <label>Length</label>
                <div className="seg">
                  {DURATIONS.map((d) => (
                    <button
                      key={d}
                      type="button"
                      aria-pressed={durationSeconds === d}
                      disabled={isRunning}
                      onClick={() => {
                        setDurationSeconds(d);
                        if (status !== "running") setRemainingMs(d * 1000);
                      }}
                    >
                      {d}s
                    </button>
                  ))}
                </div>
              </div>

              <div className="btn-row">
                {!cameraReady ? (
                  <button className="btn btn-primary" onClick={enableCamera} disabled={status === "loading-model"}>
                    <Camera size={19} /> {status === "loading-model" ? "Loading…" : "Turn on camera"}
                  </button>
                ) : (
                  <button className="btn btn-primary" onClick={startRun} disabled={!canStart}>
                    <Play size={19} /> {status === "finished" ? "Go again" : "Start run"}
                  </button>
                )}
                {(isRunning || status === "finished" || status === "submitting") && (
                  <button className="btn btn-ghost" onClick={resetRun} disabled={status === "submitting"}>
                    <RotateCcw size={16} /> Reset
                  </button>
                )}
              </div>

              <div className="privacy">
                <ShieldCheck size={15} />
                <span>Runs on your device. Your camera feed never leaves the browser.</span>
              </div>
            </div>

            {official && (
              <div className={"card result" + (official.accepted && official.isNewBest ? " win" : "")}>
                <div className="result-head">
                  <span className={"tag" + (official.accepted ? "" : " muted")}>
                    {official.accepted ? (official.isNewBest ? "New personal best" : "Run saved") : "No score"}
                  </span>
                </div>

                {official.accepted ? (
                  <>
                    <div className="result-big">
                      <span className="n">{official.officialScore}</span>
                      <span className="u">reps in {Math.round(official.durationMs / 1000)}s</span>
                    </div>
                    <div className="result-stats">
                      {myRank != null && (
                        <div className="s"><div className="v">#{myRank}</div><div className="k">Leaderboard rank</div></div>
                      )}
                      <div className="s"><div className="v">{repsPerMin}</div><div className="k">Reps / min</div></div>
                      <div className="s"><div className="v">{Math.round(official.qualityAvg * 100)}%</div><div className="k">Tracking</div></div>
                    </div>
                  </>
                ) : (
                  <p className="result-msg">{official.message}</p>
                )}
              </div>
            )}
          </aside>
        </section>

        <section className="how" id="how">
          <h2>Three moves. One clock.</h2>
          <p className="section-sub">No setup, no sign-up. Stand back so your upper body fills the frame.</p>
          <div className="steps">
            <div className="step">
              <div className="idx">01</div>
              <h3>Hands up</h3>
              <p>Reach both arms above your shoulders to load the stroke.</p>
            </div>
            <div className="step">
              <div className="idx">02</div>
              <h3>Pull down</h3>
              <p>Drive both hands straight down past your hips. That's one rep.</p>
            </div>
            <div className="step">
              <div className="idx">03</div>
              <h3>Repeat, fast</h3>
              <p>Keep a clean rhythm until the timer hits zero. Speed wins.</p>
            </div>
          </div>
        </section>

        <section className="lb-wrap" id="leaderboard">
          <div className="lb-head">
            <div>
              <h2>Leaderboard</h2>
              <p className="section-sub" style={{ margin: 0 }}>Best scores saved on this device.</p>
            </div>
          </div>

          <div className="lb">
            {leaderboard.length === 0 && (
              <div className="lb-empty">No runs yet — set your first score above.</div>
            )}
            {leaderboard.map((entry, index) => {
              const rank = index + 1;
              const you = entry.displayName.toLowerCase() === cleanName.toLowerCase();
              const name = entry.displayName || "Diver";
              return (
                <div className={"lb-row" + (you ? " you" : "") + (rank <= 3 ? " r" + rank : "")} key={entry.id}>
                  <span className="lb-rank">{rank}</span>
                  <div className="lb-diver">
                    <span className="lb-ava" style={{ background: avatarColor(name) }}>{initials(name)}</span>
                    <div style={{ minWidth: 0 }}>
                      <div className="lb-name">{name}{you && <span className="you-tag">YOU</span>}</div>
                      <div className="lb-meta">{Math.round(entry.bestQualityAvg * 100)}% tracking</div>
                    </div>
                  </div>
                  <span className="lb-dur">{Math.round(entry.bestDurationMs / 1000)}s</span>
                  <span className="lb-score">{entry.bestScore}</span>
                </div>
              );
            })}
          </div>

          <div className="lb-foot">
            <span>{myRank != null ? `You're #${myRank}` : "Run once to claim your spot"}</span>
            {leaderboard.length > 0 && (
              <button onClick={handleClearLeaderboard}><Trash2 size={15} /> Clear leaderboard</button>
            )}
          </div>
        </section>

        <footer className="foot">
          <span>Scuba Speed</span>
          <span>On-device pose detection · No video leaves your browser</span>
        </footer>
      </main>
    </div>
  );
}
