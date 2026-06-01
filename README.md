# SCUBA Counter

A production-ready starter for a viral camera challenge:

- Browser camera + MediaPipe Pose Landmarker
- SCUBA-stroke counter with live motion coaching
- Firebase Hosting web app
- Firebase Auth anonymous sessions
- Firebase App Check enforced callable Cloud Functions
- Firestore leaderboard with public reads and no client writes
- Server-side score verification from compact pose telemetry

## How the game works

The counter detects a full “SCUBA stroke”:

1. Both wrists rise above or near the shoulder line.
2. Both wrists pull down near the hips.
3. The app uses hysteresis, visibility checks, body framing checks, minimum timing, and symmetry checks to count one official rep.

The client shows a live score for UX, but the leaderboard score is recalculated inside Cloud Functions from the submitted pose trace. The browser never gets permission to write scores directly.

## Important security reality

A webcam-only game cannot be made perfectly cheat-proof because a determined attacker controls their browser, JavaScript runtime, camera feed, and network client. This project is hardened for public viral usage, not prize-money esports. For cash prizes, add one of these stronger layers:

- server-side random video spot checks,
- WebRTC live verification rooms,
- device integrity checks on native mobile apps,
- human moderation for top scores,
- account reputation / phone / social sign-in for ranked mode.

## Architecture

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

## Firebase setup

Create a Firebase project, then enable:

1. Authentication -> Sign-in method -> Anonymous.
2. Firestore Database -> Native mode.
3. Hosting.
4. App Check for the Web app using reCAPTCHA v3 or reCAPTCHA Enterprise.
5. Cloud Functions.

Copy the Firebase web config into `web/.env`:

```bash
cp web/.env.example web/.env
```

Edit `.firebaserc`:

```bash
cp .firebaserc.example .firebaserc
```

Then set your project ID in `.firebaserc`.

## App Check replay protection

The Functions use:

```ts
enforceAppCheck: true,
consumeAppCheckToken: true
```

For `consumeAppCheckToken: true`, grant the function runtime service account the **Firebase App Check Token Verifier** role in Google Cloud IAM. If you skip this, deployment can succeed but calls may fail at runtime.

For local dev with App Check:

1. Set `VITE_APPCHECK_DEBUG_TOKEN=true` in `web/.env`.
2. Open DevTools. Firebase prints a debug token.
3. Add that token in Firebase Console -> App Check -> Manage debug tokens.

## Install and run

Use Node.js 22+ for Cloud Functions.

```bash
npm install
npm run build
```

Local web dev:

```bash
npm run dev
```

Firebase emulators:

```bash
npm run emulators
```

Deploy everything:

```bash
npm run deploy
```

Or deploy in pieces:

```bash
npm run deploy:rules
npm run deploy:functions
npm run deploy:hosting
```

## Security checklist before going public

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

The browser and server intentionally use the same thresholds:

- `HIGH_THRESHOLD = 0.16`
- `LOW_THRESHOLD = 0.72`
- `MIN_PULL_MS = 170`
- `MIN_REP_GAP_MS = 240`

Update both files together:

- `web/src/lib/counter.ts`
- `functions/src/scoreValidator.ts`

## Privacy

No video is uploaded. The submission contains a compact array of normalized pose points for shoulders, elbows, wrists, and hips. This is still biometric-like motion data, so add a Privacy Policy before public launch.
