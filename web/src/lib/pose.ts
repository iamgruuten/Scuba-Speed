import {
  FilesetResolver,
  PoseLandmarker,
  type NormalizedLandmark
} from "@mediapipe/tasks-vision";
import type { CompactPoseSample } from "../types";

const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/latest/pose_landmarker_lite.task";
const WASM_URL = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm";

// Upper body only: shoulders, elbows, wrists.
const POINT_INDEXES = [11, 12, 13, 14, 15, 16] as const;
const ACCENT = "217, 119, 87"; // Claude terracotta (rgb)

export async function createPoseLandmarker(): Promise<PoseLandmarker> {
  const vision = await FilesetResolver.forVisionTasks(WASM_URL);
  return PoseLandmarker.createFromOptions(vision, {
    baseOptions: {
      modelAssetPath: MODEL_URL,
      delegate: "GPU"
    },
    runningMode: "VIDEO",
    numPoses: 1,
    minPoseDetectionConfidence: 0.5,
    minPosePresenceConfidence: 0.5,
    minTrackingConfidence: 0.5
  });
}

export function makeCompactSample(
  landmarks: NormalizedLandmark[],
  elapsedMs: number
): CompactPoseSample | null {
  if (!landmarks || landmarks.length < 17 || !Number.isFinite(elapsedMs)) return null;

  const p: number[] = [];
  for (const index of POINT_INDEXES) {
    const landmark = landmarks[index];
    if (!landmark) return null;
    p.push(round4(landmark.x), round4(landmark.y), round4(landmark.visibility ?? 0));
  }

  return { t: Math.round(elapsedMs), p };
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}

export function drawPoseOverlay(
  canvas: HTMLCanvasElement,
  landmarks: NormalizedLandmark[] | null,
  quality: number
): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!landmarks || landmarks.length === 0) return;

  const visible = (index: number) => (landmarks[index]?.visibility ?? 0) > 0.3;
  const xy = (index: number) => ({
    x: landmarks[index].x * canvas.width,
    y: landmarks[index].y * canvas.height
  });

  const lines: Array<[number, number]> = [
    [11, 12],
    [11, 13],
    [13, 15],
    [12, 14],
    [14, 16]
  ];

  const alpha = Math.max(0.45, Math.min(1, quality));
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.lineWidth = Math.max(4, canvas.width / 200);
  ctx.strokeStyle = `rgba(${ACCENT}, ${alpha})`;

  for (const [a, b] of lines) {
    if (!visible(a) || !visible(b)) continue;
    const pa = xy(a);
    const pb = xy(b);
    ctx.beginPath();
    ctx.moveTo(pa.x, pa.y);
    ctx.lineTo(pb.x, pb.y);
    ctx.stroke();
  }

  for (const index of POINT_INDEXES) {
    if (!visible(index)) continue;
    const { x, y } = xy(index);
    ctx.beginPath();
    ctx.arc(x, y, Math.max(4, canvas.width / 210), 0, Math.PI * 2);
    ctx.fillStyle = "rgba(255, 255, 255, 0.95)";
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = `rgba(${ACCENT}, ${alpha})`;
    ctx.stroke();
  }

  ctx.restore();
}

export async function startCamera(video: HTMLVideoElement): Promise<MediaStream> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("Camera API is not available in this browser.");
  }

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      facingMode: "user",
      width: { ideal: 1280 },
      height: { ideal: 720 },
      frameRate: { ideal: 30, max: 60 }
    }
  });

  video.srcObject = stream;
  video.muted = true;
  video.playsInline = true;
  await video.play();
  return stream;
}

export function stopCamera(stream: MediaStream | null): void {
  stream?.getTracks().forEach((track) => track.stop());
}
