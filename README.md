# SCUBA Counter

A camera challenge you can ship for free:

- Browser camera + MediaPipe Pose Landmarker
- SCUBA-stroke counter with live motion coaching
- On-device scoring with a local (per-browser) leaderboard
- Static build — deploy free to Vercel (or any static host)

> **This repo currently builds as a free, static, on-device app** — no backend, no account,
> no hosting cost. See [Deploy: free static build (Vercel)](#deploy-free-static-build-vercel)
> below. A Firebase server-verified mode (anonymous auth, App Check, Cloud Functions score
> authority, Firestore leaderboard) is preserved in `functions/`, `firebase.json`, and the
> `*.rules` files for when you want a shared, cheat-resistant leaderboard. Note: Cloud
> Functions require the paid Blaze plan, so that mode is not free.

## Deploy: free static build (Vercel)

The app in `web/` runs entirely in the browser: MediaPipe pose detection, SCUBA-stroke
counting, and a leaderboard stored in `localStorage`. Nothing is uploaded and there is no
server cost.

1. Push this repo to GitHub.
2. In Vercel: **New Project -> import the repo**.
3. Set **Root Directory** to `web` (important — this is a monorepo).
4. Framework preset **Vite**; build command `npm run build`, output `dist` (auto-detected).
5. Deploy. `web/vercel.json` adds the SPA fallback rewrite and security headers (CSP, etc.).

Local dev and build:

```bash
cd web
npm install
npm run dev      # http://localhost:5173
npm run build    # outputs web/dist
```

Note: the leaderboard is per-browser/per-device — it is not shared between visitors, and
scores are not server-verified in this mode.

## How the game works

The counter detects a full "SCUBA stroke":

1. Both wrists rise above or near the shoulder line.
2. Both wrists pull down near the hips.
3. The app uses hysteresis, visibility checks, body framing checks, minimum timing, and symmetry checks to count one rep.

In the static build, the score shown is the official score and it is saved straight to the
local leaderboard. (In the Firebase mode, the client score is only for UX and the score is
recalculated server-side from the pose trace.)

## Static build privacy & security

- The camera stream stays in the browser; no video or images are uploaded.
- Pose detection runs locally via MediaPipe (WASM + model loaded from public CDNs).
- The leaderboard lives in `localStorage`; clearing site data resets it.
- `web/vercel.json` ships hardened headers: a strict Content-Security-Policy, `X-Frame-Options: DENY`,
  `X-Content-Type-Options: nosniff`, a locked-down `Permissions-Policy` (camera only), and HSTS-style upgrades.

## Optional: Firebase server-verified mode

A webcam-only game cannot be made perfectly cheat-proof because a determined attacker controls their browser, JavaScript runtime, camera feed, and network client. The preserved Firebase mode is hardened for public viral usage, not prize-money esports. For cash prizes, add one of these stronger layers:

- server-side random video spot checks,
- WebRTC live verification rooms,
- device integrity checks on native mobile apps,
- human moderation for top scores,
- account reputation / phone / social sign-in for ranked mode.

### Architecture (Firebase mode)

```text
web/                 React + Vite camera app
functions/           Firebase Cloud Functions v2 score authority
firestore.rules      public leaderboard reads; all writes denied to clients
firebase.json        Hosting, CSP, emulators, rules, indexes
```

Data flow:

```text
User camera -> MediaPipe in browser -> compact pose points -> callable Function
Function validates App Check + Auth + session nonce -> recomputes score -> writes leaderboard
Client reads leaderboard from Firestore
```

### Firebase setup

To re-enable this mode: restore `web/src/firebase.ts` from git history, re-add the `firebase`
dependency in `web/package.json`, and wire the firebase calls back into `web/src/App.tsx`.
Then create a Firebase project and enable:

1. Authentication -> Sign-in method -> Anonymous.
2. Firestore Database -> Native mode.
3. Hosting.
4. App Check for the Web app using reCAPTCHA v3 or reCAPTCHA Enterprise.
5. Cloud Functions (requires the Blaze plan).

Copy the Firebase web config into `web/.env`, set your `VITE_FIREBASE_*` keys, and set your
project ID in `.firebaserc` (see `.firebaserc.example`).

### Security checklist before going public (Firebase mode)

- Keep `firestore.rules` as-is: public leaderboard read, no client writes.
- Keep score writes inside Cloud Functions only.
- Keep App Check enforcement enabled on both `startRun` and `submitRun`.
- Use limited-use App Check tokens from the web client for callable Functions.
- Turn on Firebase budget alerts and quota alerts.
- Enable Firestore TTL for `runs.expireAt` and `rateLimits.expireAt`.
- Review Cloud Logging for rejected runs and high-frequency IP/UID attempts.
- Lock CORS to your production domain once your Hosting domain is final.
- Add manual moderation for extreme top scores.

## Tuning the movement

The browser counter and the (optional) server validator use the same thresholds:

- `HIGH_THRESHOLD = 0.16`
- `LOW_THRESHOLD = 0.72`
- `MIN_PULL_MS = 170`
- `MIN_REP_GAP_MS = 240`

If you use the Firebase mode, update both files together:

- `web/src/lib/counter.ts`
- `functions/src/scoreValidator.ts`

## Privacy

No video is uploaded. In the Firebase mode the submission contains a compact array of normalized pose points for shoulders, elbows, wrists, and hips — this is still biometric-like motion data, so add a Privacy Policy before public launch.
