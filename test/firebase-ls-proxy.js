/**
 * WARP Cloud Storage Proxy
 * ========================
 * הוסף את הסקריפט הזה לכל משחק שרוצה לסנכרן localStorage לענן.
 *
 * שימוש:
 *   <script src="firebase-ls-proxy.js"></script>
 *
 * זה יחליף את localStorage הרגיל בגרסה שמסנכרנת אוטומטית ל-Firestore.
 * אין צורך לשנות שום קוד אחר במשחק — כל קריאות setItem/getItem יעבדו כרגיל.
 */

(async function () {
  'use strict';

  // ── Firebase config (זהה לכל המשחקים) ──
  const FIREBASE_CONFIG = {
    apiKey: "AIzaSyAV04ASEGe-b_7UnmNjpOTH7RMwFF-I0O0",
    authDomain: "warp-games.firebaseapp.com",
    projectId: "warp-games",
    storageBucket: "warp-games.firebasestorage.app",
    messagingSenderId: "299502091770",
    appId: "1:299502091770:web:582593b7b31884bfbcf843",
    measurementId: "G-N3JTRQPYRV"
  };

  // ── Load Firebase SDK dynamically ──
  const BASE = 'https://www.gstatic.com/firebasejs/10.12.0/';
  const [
    { initializeApp },
    { getAuth, onAuthStateChanged, signInAnonymously },
    { getFirestore, doc, getDoc, setDoc, deleteDoc, collection, getDocs }
  ] = await Promise.all([
    import(BASE + 'firebase-app.js'),
    import(BASE + 'firebase-auth.js'),
    import(BASE + 'firebase-firestore.js'),
  ]);

  const app  = initializeApp(FIREBASE_CONFIG, 'warp-proxy'); // named to avoid duplicate app error
  const auth = getAuth(app);
  const db   = getFirestore(app);

  // ── In-memory cache ──
  const cache = {};
  let uid = null;

  // ── Restore backup from real localStorage into cache ──
  try {
    for (let i = 0; i < window._realLS.length; i++) {
      const k = window._realLS.key(i);
      if (k) cache[k] = window._realLS.getItem(k);
    }
  } catch (_) {}

  // ── Load cloud data for user ──
  async function loadCloud(userId) {
    try {
      const snap = await getDocs(collection(db, 'users', userId, 'localStorage'));
      snap.forEach(d => { cache[d.id] = d.data().value; });
    } catch (e) { console.warn('[WARP Proxy] load error', e); }
  }

  // ── Override localStorage BEFORE auth resolves (synchronous) ──
  // Save reference to real localStorage first
  const realLS = window.localStorage;
  window._realLS = realLS;

  const proxy = {
    setItem(key, value) {
      value = String(value);
      cache[key] = value;
      // fallback write to real ls
      try { realLS.setItem(key, value); } catch (_) {}
      // async cloud write
      if (uid) {
        setDoc(doc(db, 'users', uid, 'localStorage', key), { value })
          .catch(e => console.warn('[WARP Proxy] setItem error', e));
      }
    },
    getItem(key) {
      return (key in cache) ? cache[key] : null;
    },
    removeItem(key) {
      delete cache[key];
      try { realLS.removeItem(key); } catch (_) {}
      if (uid) {
        deleteDoc(doc(db, 'users', uid, 'localStorage', key))
          .catch(e => console.warn('[WARP Proxy] removeItem error', e));
      }
    },
    clear() {
      Object.keys(cache).forEach(k => proxy.removeItem(k));
    },
    key(i) { return Object.keys(cache)[i] ?? null; },
    get length() { return Object.keys(cache).length; },
  };

  Object.defineProperty(window, 'localStorage', {
    get: () => proxy,
    configurable: true,
  });

  // ── Auth: auto anonymous sign-in ──
  onAuthStateChanged(auth, async user => {
    if (user) {
      uid = user.uid;
      await loadCloud(uid);
      console.log(`[WARP Proxy] Synced to cloud as ${user.isAnonymous ? 'anonymous' : user.email}`);
    } else {
      signInAnonymously(auth).catch(e => console.error('[WARP Proxy] anon auth error', e));
    }
  });

  console.log('[WARP Proxy] localStorage proxy active ✅');
})();
