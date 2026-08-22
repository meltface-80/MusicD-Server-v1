const express = require('express');
const cors = require('cors');
const path = require('path');
const { WebSocketServer } = require('ws');
const http = require('http');

const db = require('./db');
const scanner = require('./scanner');
const renderers = require('./renderers');
const versionMod = require('./version');
const playerRouter = require('./routes/player');
const libraryRouter = require('./routes/library');
const streamRouter = require('./routes/stream');
const renderersRouter = require('./routes/renderers');
const settingsRouter = require('./routes/settings');
const shareRouter = require('./routes/share');
const updateRouter = require('./routes/update');
const dspRouter = require('./routes/dsp');
const newsRouter = require('./routes/news');
const scrobbleRouter = require('./routes/scrobble');
const audioRouter = require('./routes/audio');
const schedulerRouter = require('./routes/scheduler');
// v1.1.0.60 — local bug-report capture (Update screen → "Report a bug")
const bugReportRouter = require('./routes/bugReport');
// v1.1.0.67 — user-defined tags + Save-for-later
const tagsRouter = require('./routes/tags');
const playlistsRouter = require('./routes/playlists');
const homeRouter = require('./routes/home');
// v1.1.33.0 — Qobuz + Tidal, merged into the one library
const streamingRouter = require('./routes/streaming');

process.on('uncaughtException', err => console.error('UNCAUGHT EXCEPTION:', err));
process.on('unhandledRejection', (reason) => console.error('UNHANDLED REJECTION:', reason));

const VERSION = versionMod.getVersion();

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const corsOrigin = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(',')
  : (origin, cb) => cb(null, true);
app.use(cors({ origin: corsOrigin }));
app.use(express.json({ limit: '1mb' }));

// v1.1.1.3 — cache headers tuned for SPA correctness.
//
// Vite produces content-hashed bundles in /assets/ (e.g.
// index-Abc123.js). Those filenames change whenever the content
// changes, so they're safe to cache forever — and we WANT them
// cached forever to avoid re-downloading unchanged JS/CSS on
// every navigation.
//
// index.html, on the other hand, references those hashed
// filenames. If the browser caches index.html, it'll keep
// pointing at old hashes even after we deploy new code — and
// the user sees stale JS/CSS until they hard-refresh.
//
// The fix is asymmetric:
//   /assets/* → cache forever, immutable
//   /index.html (and SPA fallback) → never cache
//
// Without this, mobile browsers (especially iOS Safari) hold
// onto index.html for hours via heuristic caching and users
// see stale UI after updates. Bug observed in v1.1.1.0 → v1.1.1.2:
// CSS changes (3-col grid) didn't show up until cache cleared.
const CLIENT_DIST = path.join(__dirname, '../../client/dist');
app.use('/assets', express.static(path.join(CLIENT_DIST, 'assets'), {
  maxAge: '1y',
  immutable: true,
}));
app.use(express.static(CLIENT_DIST, {
  setHeaders: (res, filepath) => {
    // index.html and any other top-level HTML must not be cached
    // so updated builds reach users without a hard-refresh.
    if (filepath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, must-revalidate');
    }
  },
}));

app.get('/api/healthz', (req, res) => res.json({ status: 'ok', version: VERSION }));
app.get('/api/version', (req, res) => res.json({ version: VERSION }));

// Guard: 503 cleanly when DB isn't ready
app.use('/api', (req, res, next) => {
  if (!db.isReady()) {
    return res.status(503).json({ error: 'Database not ready', detail: 'Check /data permissions: chown -R 1000:1000 /var/lib/musicd-data' });
  }
  next();
});

// v1.1.1.3 — attach tier info to every /api request. Cheap (one
// indexed lookup per request) and lets every route decide what to
// gate on the user's current tier without each route having to
// re-read the settings table.
const tierMiddleware = require('./tierMiddleware');
app.use('/api', tierMiddleware.attachTier);

app.use('/api/library', libraryRouter);
app.use('/api/player', playerRouter);
app.use('/api/stream', streamRouter);
app.use('/api/renderers', renderersRouter);
app.use('/api/settings', settingsRouter);
app.use('/api/share', shareRouter);
app.use('/api/update', updateRouter);
// v1.1.1.3 — DSP and scrobble are demo-locked. The middleware
// applies a blanket 403 with upgradeRequired:true for demo users.
app.use('/api/dsp', tierMiddleware.requireFeature('dsp'), dspRouter);
app.use('/api/scrobble', tierMiddleware.requireFeature('scrobbling'), scrobbleRouter);
app.use('/api/news', newsRouter);
app.use('/api/audio', audioRouter);
// v1.1.1.4 — client-side debug log relay.
const debugRouter = require('./routes/debug');
app.use('/api/debug', debugRouter);
app.use('/api/scheduler', schedulerRouter);
app.use('/api/bug-report', bugReportRouter);
app.use('/api/tags', tagsRouter);
app.use('/api/playlists', playlistsRouter);
app.use('/api/home', homeRouter);
// v1.1.33.0 — Qobuz / Tidal. Gated as a whole rather than at the login
// call: with no credentials stored, every route under it would answer
// 401, and a string of auth errors reads like a fault rather than a tier
// limit. One 403 carrying upgradeRequired is the honest answer.
app.use('/api/streaming', tierMiddleware.requireFeature('streaming_services'), streamingRouter);

// SPA fallback: any non-API route returns index.html so client-side routing works
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(__dirname, '../../client/dist/index.html'));
});

// ---- WebSocket broadcast helper ----
const wsClients = new Set();
wss.on('connection', (ws) => {
  wsClients.add(ws);
  ws.on('close', () => wsClients.delete(ws));
});
global.broadcastState = (type, payload) => {
  const msg = JSON.stringify({ type, payload });
  for (const ws of wsClients) {
    if (ws.readyState === 1) {
      try { ws.send(msg); } catch {}
    }
  }
};

// ---- Graceful shutdown ----
let shuttingDown = false;
function shutdown(sig) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`📦 ${sig} — shutting down...`);
  renderers.stopDiscovery();
  scanner.stopWatcher && scanner.stopWatcher();
  try { require('./streamingLibrary').stopScheduledSync(); } catch (e) { /* never started */ }
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

const PORT = process.env.PORT || 32700;
server.listen(PORT, '0.0.0.0', async () => {
  console.log(`🎵 musicd v${VERSION} running on port ${PORT}`);
  try {
    db.init();
    // Ensure DSP directory layout exists and seed the AutoEQ starter snapshot
    // on first boot. Done after db.init so the DATA_DIR convention is the
    // same one the database uses. Failures here are non-fatal — DSP simply
    // won't have its data dirs and the relevant features will be inert.
    require('./paths').ensureDirs();
    // Seed a "Default" DSP profile for any renderer that has live settings
    // but no saved profile yet. Idempotent.
    require('./dsp/profiles').seedDefaults();

    // Backfill IR peak metadata for any FIR uploaded before v1.1.0.53
    // (when the per-IR peakDb sidecar was introduced). Runs once per
    // boot, idempotent — only does work for IRs that lack a sidecar.
    // Async via setImmediate so we don't delay listen() readiness.
    setImmediate(() => {
      try {
        const fir = require('./dsp/fir');
        const r = fir.backfillPeakMeta();
        if (r.computed > 0) {
          console.log(`[fir] backfilled peak metadata: ${r.computed} computed, ${r.skipped} skipped, ${r.failed} failed`);
        }
      } catch (e) {
        console.warn('[fir] peak backfill failed:', e.message);
      }
    });

    // v1.1.34.0 — backfill album version keys. On an existing install
    // the column has just been added and is NULL everywhere, so version
    // grouping would collapse nothing until the next scan. onlyMissing
    // keeps this cheap on every subsequent boot: it is a no-op once the
    // column is populated. Deferred so it never delays listen().
    setImmediate(() => {
      try {
        const r = require('./albumVersions').rebuildVersionKeys({ onlyMissing: true });
        if (r.changed > 0) console.log(`[versions] backfilled ${r.changed} album version key(s)`);
      } catch (e) {
        console.warn('[versions] key backfill failed:', e.message);
      }
    });

    // v1.1.0.78 — bug-report retention sweep. Runs on boot then once
    // a day. Drops reports older than 90 days, keeping a floor of
    // 50 most recent so a tester who reported a flurry doesn't lose
    // their backlog. Cheap directory walk; non-fatal on failure.
    setImmediate(() => {
      try {
        const br = require('./routes/bugReport');
        if (typeof br.pruneOldReports === 'function') br.pruneOldReports();
      } catch (e) {
        console.warn('[bug-report] retention sweep failed:', e.message);
      }
    });
    setInterval(() => {
      try {
        const br = require('./routes/bugReport');
        if (typeof br.pruneOldReports === 'function') br.pruneOldReports();
      } catch (e) { /* non-fatal */ }
    }, 24 * 60 * 60 * 1000);
  } catch (err) {
    console.error('');
    console.error('❌ DATABASE INIT FAILED:', err.message);
    console.error('   Most likely cause: /data is not writable by the musicd user (UID 1000).');
    console.error('   Fix on host: sudo chown -R 1000:1000 /var/lib/musicd-data');
    console.error('   Then: docker restart musicd');
    console.error('');
    return;
  }

  await renderers.startDiscovery();

  // Re-attach any queue that was active at last shutdown. This restores the
  // visible state in the UI but does NOT auto-resume playback — the user
  // pressing Play (or selecting a different album) is what kicks playback off.
  try {
    const playerState = require('./playerState');
    playerState.restorePersistedQueue();
  } catch (e) { console.warn('Queue restore failed:', e.message); }

  // Start the music news refresh loop (#30). Initial fetch is deferred a few
  // seconds so it doesn't compete with discovery and library scanning at
  // boot — the home screen falls back to "loading" gracefully until the
  // first fetch completes.
  try {
    require('./news').start();
  } catch (e) { console.warn('News refresh loop failed to start:', e.message); }

  // v1.1.33.0 — reconcile Qobuz / Tidal favourites with the library.
  // Once ~45s after boot, then daily. Without it, an album favourited
  // from the Qobuz app on a phone never reaches this library until the
  // user happens to open Settings and press Sync. No-op when neither
  // service is signed in.
  try {
    require('./streamingLibrary').startScheduledSync();
  } catch (e) { console.warn('Streaming favourites sync failed to start:', e.message); }

  // Start the remote update checker (#30.6). Polls the manifest URL once
  // a day; first check is deferred 30s after start. Idempotent — if no
  // manifest URL is configured the loop runs but each check is a no-op.
  try {
    require('./remoteUpdater').start();
  } catch (e) { console.warn('Remote update checker failed to start:', e.message); }

  // Metadata scheduler (#v1.1.0.28). Reads mode from settings; if
  // 'off' it runs the tick loop but does nothing. Idempotent.
  try {
    require('./metadataScheduler').start();
  } catch (e) { console.warn('Metadata scheduler failed to start:', e.message); }

  const musicDir = process.env.MUSIC_DIR || '/music';
  scanner.scan(musicDir).then(() => {
    scanner.watch(musicDir);
  }).catch(err => console.error('Scan failed:', err));

  // Auto-update preflight (#v1.1.0.48). Now orchestrator-aware:
  // - In docker mode: check docker socket reachable, pre-pull alpine
  //   updater image so the first update doesn't wait on a network pull.
  // - In systemd mode: check write access to /opt/musicd. No image
  //   to pre-pull -- updates are tar-extract + systemctl restart.
  // - In unknown mode: log status only; updates won't be available.
  const orchestrator = require('./orchestrator');
  const orchInfo = orchestrator.describe();
  console.log(`✓ Orchestrator: mode=${orchInfo.mode} canSelfRestart=${orchInfo.canSelfRestart} canApplyUpdate=${orchInfo.canApplyUpdate}`);
  if (orchInfo.mode === 'docker' && orchInfo.canSelfRestart) {
    const updater = require('./updater');
    updater.preflightCheck().then(flight => {
      if (!flight.ok) {
        console.warn(`⚠️  Auto-update preflight failed: ${flight.error}`);
        return;
      }
      console.log(`✓ Auto-update: docker daemon reachable, image ${flight.imagePresent ? 'cached' : 'will be pulled'}`);
      if (!flight.imagePresent) {
        updater.ensureUpdaterImage();
      }
    });
  }
});
