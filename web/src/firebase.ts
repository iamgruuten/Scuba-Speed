import { initializeApp } from "firebase/app";
import {
  initializeAppCheck,
  ReCaptchaV3Provider
} from "firebase/app-check";
import {
  getAuth,
  onAuthStateChanged,
  signInAnonymously,
  connectAuthEmulator,
  type User
} from "firebase/auth";
import {
  getFirestore,
  collection,
  query,
  orderBy,
  limit,
  onSnapshot,
  connectFirestoreEmulator,
  type Unsubscribe
} from "firebase/firestore";
import {
  getFunctions,
  httpsCallable,
  connectFunctionsEmulator
} from "firebase/functions";
import type {
  CompactPoseSample,
  LeaderboardEntry,
  SessionSummary,
  StartRunOutput,
  SubmitRunOutput
} from "./types";

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID
};

export const app = initializeApp(firebaseConfig);

const appCheckKey = import.meta.env.VITE_RECAPTCHA_SITE_KEY;
if (import.meta.env.VITE_APPCHECK_DEBUG_TOKEN === "true") {
  // Firebase prints a debug token in DevTools. Register that token in Firebase Console > App Check.
  (globalThis as typeof globalThis & { FIREBASE_APPCHECK_DEBUG_TOKEN?: boolean }).FIREBASE_APPCHECK_DEBUG_TOKEN = true;
}

if (appCheckKey) {
  initializeAppCheck(app, {
    provider: new ReCaptchaV3Provider(appCheckKey),
    isTokenAutoRefreshEnabled: true
  });
} else {
  console.warn("VITE_RECAPTCHA_SITE_KEY is missing. Callable Functions with App Check enforcement will reject production requests.");
}

export const auth = getAuth(app);
export const db = getFirestore(app);
export const functions = getFunctions(app, import.meta.env.VITE_FIREBASE_REGION || "asia-southeast1");

if (import.meta.env.VITE_USE_FIREBASE_EMULATORS === "true") {
  connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
  connectFirestoreEmulator(db, "127.0.0.1", 8080);
  connectFunctionsEmulator(functions, "127.0.0.1", 5001);
}

export function ensureAnonymousUser(): Promise<User> {
  return new Promise((resolve, reject) => {
    const unsubscribe = onAuthStateChanged(auth, async (user) => {
      unsubscribe();
      try {
        if (user) {
          resolve(user);
          return;
        }
        const credential = await signInAnonymously(auth);
        resolve(credential.user);
      } catch (error) {
        reject(error);
      }
    });
  });
}

export function subscribeLeaderboard(
  onEntries: (entries: LeaderboardEntry[]) => void,
  onError: (error: Error) => void
): Unsubscribe {
  const q = query(collection(db, "leaderboard"), orderBy("bestScore", "desc"), orderBy("bestDurationMs", "asc"), limit(25));
  return onSnapshot(
    q,
    (snapshot) => {
      const entries = snapshot.docs.map((doc) => ({ uid: doc.id, ...(doc.data() as Omit<LeaderboardEntry, "uid">) }));
      onEntries(entries);
    },
    onError
  );
}

export async function startVerifiedRun(displayName: string): Promise<StartRunOutput> {
  const callable = httpsCallable<{ displayName: string }, StartRunOutput>(functions, "startRun", {
    limitedUseAppCheckTokens: true
  });
  const result = await callable({ displayName });
  return result.data;
}

export async function submitVerifiedRun(args: {
  runId: string;
  nonce: string;
  displayName: string;
  telemetry: CompactPoseSample[];
  summary: SessionSummary;
}): Promise<SubmitRunOutput> {
  const callable = httpsCallable<typeof args, SubmitRunOutput>(functions, "submitRun", {
    limitedUseAppCheckTokens: true
  });
  const result = await callable(args);
  return result.data;
}
