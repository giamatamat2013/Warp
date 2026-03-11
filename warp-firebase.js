/**
 * warp-firebase.js
 * ────────────────────────────────────────────────────────────────────────────
 * Universal Firebase sync for WARP game library.
 * Add ONE <script> tag to any game → all localStorage & cookie writes
 * are automatically mirrored to Firebase Realtime Database.
 * On page load, saved cloud data is restored before the game starts.
 *
 * © 2026 WARP
 * ────────────────────────────────────────────────────────────────────────────
 *
 * HOW TO USE IN ANY GAME:
 *   Add this tag as the FIRST script in <body> (before any game scripts):
 *
 *   <script src="https://YOUR-WARP-DOMAIN/warp-firebase.js"></script>
 *
 *   Or if the game uses ES modules, add it as a classic script BEFORE the module:
 *   <script src="warp-firebase.js"></script>
 *   <script type="module" src="main.js"></script>
 *
 * GAME NAMESPACE:
 *   By default uses hostname+pathname as key namespace.
 *   Override before loading this script:
 *   <script>window.WARP_GAME_ID = "my-game-id";</script>
 */

(function () {
  'use strict';

  // ── Firebase config (web API keys are public by design) ─────────────────
  const FIREBASE_CONFIG = {
    apiKey:            "AIzaSyAV04ASEGe-b_7UnmNjpOTH7RMwFF-I0O0",
    authDomain:        "warp-games.firebaseapp.com",
    projectId:         "warp-games",
    storageBucket:     "warp-games.firebasestorage.app",
    messagingSenderId: "299502091770",
    appId:             "1:299502091770:web:582593b7b31884bfbcf843",
    measurementId:     "G-N3JTRQPYRV",
    // databaseURL is required for Realtime Database.
    // Find it in Firebase Console → Realtime Database → copy the URL shown at the top.
    // Format: https://warp-games-default-rtdb.europe-west1.firebasedatabase.app
    databaseURL: "https://warp-games-default-rtdb.europe-west1.firebasedatabase.app"
  };

  // ── Derive a stable game ID from the URL ────────────────────────────────
  const GAME_ID = (window.WARP_GAME_ID || (
    location.hostname.replace(/\./g, '_') +
    location.pathname.replace(/\//g, '_').replace(/[^a-zA-Z0-9_-]/g, '')
  )).substring(0, 60);

  const LOG = (...a) => console.log('[WARP-FB]', ...a);

  // ── State ────────────────────────────────────────────────────────────────
  let db   = null;   // Firebase DB instance
  let uid  = null;   // Anonymous user ID
  let ready = false; // true once user is authed + cloud data restored

  // Write queue: collected while not yet ready, flushed after auth
  const writeQueue = [];

  // ── 1. Load Firebase SDKs dynamically ───────────────────────────────────
  const FB_VER = '12.10.0';
  const BASE   = `https://www.gstatic.com/firebasejs/${FB_VER}`;

  function loadModule(url) {
    return import(url);
  }

  async function initFirebase() {
    try {
      const [{ initializeApp },
             { getAuth, signInAnonymously, onAuthStateChanged },
             { getDatabase, ref, set, get, child }] = await Promise.all([
        loadModule(`${BASE}/firebase-app.js`),
        loadModule(`${BASE}/firebase-auth.js`),
        loadModule(`${BASE}/firebase-database.js`),
      ]);

      // Named app 'warp' to avoid conflicts with games that also init Firebase
      let app;
      try        { app = initializeApp(FIREBASE_CONFIG, 'warp'); }
      catch (e)  {
        // App already exists — get it
        const { getApp } = await loadModule(`${BASE}/firebase-app.js`);
        app = getApp('warp');
      }
      const auth = getAuth(app);
      db         = getDatabase(app);

      // ── 2. Anonymous sign-in ─────────────────────────────────────────────
      await new Promise(resolve => {
        onAuthStateChanged(auth, async user => {
          if (user) { uid = user.uid; }
          else      { const c = await signInAnonymously(auth); uid = c.user.uid; }
          LOG(`Signed in as ${uid} | game: ${GAME_ID}`);
          resolve();
        });
      });

      // ── 3. Restore cloud data into localStorage & cookies ────────────────
      const dbRef  = ref(db);
      const lsSnap = await get(child(dbRef, `users/${uid}/${GAME_ID}/ls`));
      const ckSnap = await get(child(dbRef, `users/${uid}/${GAME_ID}/ck`));

      if (lsSnap.exists()) {
        const saved = lsSnap.val();
        for (const [k, v] of Object.entries(saved)) {
          // Write directly to real localStorage (bypass our patch)
          _ls.setItem.call(localStorage, k, v);
        }
        LOG(`Restored ${Object.keys(saved).length} localStorage keys from cloud`);
      }

      if (ckSnap.exists()) {
        const saved = ckSnap.val();
        for (const [k, v] of Object.entries(saved)) {
          // Restore cookie — expires in 365 days
          const exp = new Date(Date.now() + 365 * 864e5).toUTCString();
          _setCookieRaw(`${k}=${v};expires=${exp};path=/`);
        }
        LOG(`Restored ${Object.keys(saved).length} cookies from cloud`);
      }

      // ── 4. Flush any writes that happened before auth completed ──────────
      ready = true;
      for (const fn of writeQueue) fn(db, uid, ref, set);
      writeQueue.length = 0;

      // ── 5. Announce to the game that cloud data is ready ─────────────────
      window.dispatchEvent(new CustomEvent('warp:ready', { detail: { uid } }));
      LOG('Ready ✅');

    } catch (e) {
      LOG('Init error (falling back to local-only):', e.message);
    }
  }

  // ── Helpers: write a single key to Firebase ──────────────────────────────
  function pushToFirebase(bucket, key, value) {
    const task = (db, uid, ref, set) => {
      const path = `users/${uid}/${GAME_ID}/${bucket}/${sanitizeKey(key)}`;
      set(ref(db, path), value).catch(e =>
        LOG(`Write error [${key}]:`, e.message)
      );
    };

    if (ready && db && uid) {
      // Need ref/set — re-import is cached by browser so this is free
      import(`${BASE}/firebase-database.js`).then(({ ref, set }) => {
        task(db, uid, ref, set);
      });
    } else {
      writeQueue.push(task);
    }
  }

  function sanitizeKey(key) {
    // Firebase keys cannot contain . # $ [ ]
    return String(key).replace(/[.#$\[\]]/g, '_').substring(0, 768);
  }

  // ── 6. Monkey-patch localStorage ─────────────────────────────────────────
  const _ls = {
    setItem:    localStorage.setItem.bind(localStorage),
    removeItem: localStorage.removeItem.bind(localStorage),
  };

  localStorage.setItem = function (key, value) {
    _ls.setItem(key, value);
    pushToFirebase('ls', key, String(value));
  };

  localStorage.removeItem = function (key) {
    _ls.removeItem(key);
    // Mark as deleted with null — or just remove:
    pushToFirebase('ls', key, null);
  };

  // ── 7. Monkey-patch document.cookie ──────────────────────────────────────
  const _cookieDescriptor = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie')
                         || Object.getOwnPropertyDescriptor(HTMLDocument.prototype, 'cookie');

  function _setCookieRaw(val) {
    if (_cookieDescriptor && _cookieDescriptor.set) {
      _cookieDescriptor.set.call(document, val);
    }
  }

  if (_cookieDescriptor && _cookieDescriptor.set) {
    Object.defineProperty(document, 'cookie', {
      configurable: true,
      enumerable:   true,
      get: function () {
        return _cookieDescriptor.get.call(document);
      },
      set: function (val) {
        _setCookieRaw(val);
        // Parse "name=value;..." to extract name and value
        try {
          const parts    = val.split(';');
          const nameVal  = parts[0].trim();
          const eqIdx    = nameVal.indexOf('=');
          if (eqIdx < 1) return;
          const name  = nameVal.substring(0, eqIdx).trim();
          const value = nameVal.substring(eqIdx + 1).trim();
          if (name) pushToFirebase('ck', name, value);
        } catch { /* silent */ }
      }
    });
  }

  // ── 8. Expose helpers for games that want to use Firebase directly ────────
  window.WARP = window.WARP || {};
  window.WARP.getUID    = () => uid;
  window.WARP.gameId    = GAME_ID;
  window.WARP.isReady   = () => ready;
  window.WARP.onReady   = (cb) => {
    if (ready) { cb(uid); return; }
    window.addEventListener('warp:ready', e => cb(e.detail.uid), { once: true });
  };

  // ── 9. Kick off Firebase init ─────────────────────────────────────────────
  // Use a microtask so the patch above is in place before any sync game code runs
  Promise.resolve().then(initFirebase);

})();
