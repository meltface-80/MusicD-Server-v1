// v1.1.0.60 — local bug-report capture.
//
// User taps "Report a bug" on the Update screen, types a description,
// hits Send. The server captures:
//   - description          (free text from the user)
//   - timestamp            (ISO)
//   - musicd version       (server package version)
//   - active renderer      (id + name + protocol if available)
//   - last-update log      (whatever the updater wrote on its last run)
//   - systemd journal tail (last ~500 lines if journalctl is available)
//   - basic system info    (uptime, free mem, disk space)
//
// Everything is dumped to <DATA_DIR>/bug-reports/<timestamp>-<id>.json.
// The endpoint returns the file path; for now the user emails it
// manually. A future release can wire this to SMTP if/when the user
// configures an outbound mail relay.

const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');
const paths = require('../paths');
const version = require('../version');

function safeId() {
  // 6 alphanum chars — enough to disambiguate within a second
  return Math.random().toString(36).slice(2, 8);
}

// v1.1.0.78 — retention policy. Bug reports accumulate forever
// otherwise; on a long-lived deployment with a noisy phase that
// could be hundreds of files. Policy:
//   - Keep most recent KEEP_RECENT reports unconditionally
//   - Beyond that, drop anything older than MAX_AGE_DAYS
// Whichever is more lenient wins — i.e. a tester who files a flurry
// in one week and then nothing keeps all of those flurry reports
// for 90 days, plus the 50 most recent at all times.
//
// Idempotent and safe to call frequently. Skipped silently if the
// directory doesn't exist or is unreadable.
const RETENTION_KEEP_RECENT  = 50;
const RETENTION_MAX_AGE_DAYS = 90;
function pruneOldReports() {
  const dir = paths.BUG_REPORT_DIR;
  if (!fs.existsSync(dir)) return { kept: 0, removed: 0 };

  const ageCutoffMs = Date.now() - RETENTION_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
  let entries;
  try {
    entries = fs.readdirSync(dir)
      .filter(f => f.endsWith('.json'))
      .map(f => ({
        name: f,
        path: path.join(dir, f),
        mtime: fs.statSync(path.join(dir, f)).mtimeMs,
      }))
      .sort((a, b) => b.mtime - a.mtime);  // newest first
  } catch (e) {
    return { kept: 0, removed: 0 };
  }

  const removed = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    // First RETENTION_KEEP_RECENT entries always kept regardless of age.
    if (i < RETENTION_KEEP_RECENT) continue;
    // Beyond that, drop anything older than the age cutoff.
    if (e.mtime < ageCutoffMs) {
      try {
        fs.unlinkSync(e.path);
        removed.push(e.name);
      } catch { /* non-fatal */ }
    }
  }
  if (removed.length > 0) {
    console.log(`[bug-report] retention: removed ${removed.length} old reports (kept ${entries.length - removed.length})`);
  }
  return { kept: entries.length - removed.length, removed: removed.length };
}

function readUpdateLog() {
  // Match what /api/update/log reads. Best-effort.
  try {
    const updater = require('../updater');
    return typeof updater.getLastUpdateLog === 'function'
      ? updater.getLastUpdateLog()
      : null;
  } catch (e) {
    return null;
  }
}

function readJournalTail(lines = 500) {
  // journalctl works only on systemd-managed deployments. On dev
  // boxes (running via `node index.js` directly), this returns null.
  try {
    const out = execSync(
      `journalctl -u musicd -n ${lines} --no-pager --output=cat 2>/dev/null`,
      { encoding: 'utf8', timeout: 4000 }
    );
    return out || null;
  } catch (e) {
    return null;
  }
}

function readActiveRenderer() {
  try {
    const playerState = require('../playerState');
    const state = typeof playerState.getState === 'function'
      ? playerState.getState()
      : null;
    if (!state) return null;
    return {
      rendererId: state.rendererId || null,
      currentTrack: state.currentTrack
        ? {
            id: state.currentTrack.id,
            title: state.currentTrack.title,
            artist: state.currentTrack.artist,
            format: state.currentTrack.format,
            sample_rate: state.currentTrack.sample_rate,
          }
        : null,
      status: state.status || null,
    };
  } catch (e) {
    return null;
  }
}

function systemInfo() {
  return {
    platform: os.platform(),
    arch: os.arch(),
    nodeVersion: process.version,
    uptimeSec: Math.floor(process.uptime()),
    freeMemMB: Math.floor(os.freemem() / (1024 * 1024)),
    totalMemMB: Math.floor(os.totalmem() / (1024 * 1024)),
    loadAvg: os.loadavg(),
  };
}

// v1.1.0.78 — build a compact, human-readable summary of a report
// suitable for the body of a `mailto:` URL. Mailto bodies are length-
// constrained on most clients (iOS Mail caps around 2000 chars), so
// this stays tight: header, description, version, system fingerprint,
// active renderer if any, and the last 50 journal lines. Anything
// bigger goes on disk for follow-up.
function buildEmailBody(report) {
  const lines = [];
  lines.push(`MusicD bug report ${report.id}`);
  lines.push(`Version: ${report.version || 'unknown'}`);
  lines.push(`Time:    ${report.timestamp}`);
  lines.push('');
  lines.push('--- Description ---');
  lines.push(report.description || '(no description)');
  lines.push('');
  if (report.activeRenderer) {
    lines.push('--- Active renderer ---');
    if (report.activeRenderer.rendererId) {
      lines.push(`Renderer: ${report.activeRenderer.rendererId}`);
    }
    if (report.activeRenderer.status) {
      lines.push(`Status:   ${report.activeRenderer.status}`);
    }
    if (report.activeRenderer.currentTrack) {
      const t = report.activeRenderer.currentTrack;
      lines.push(`Track:    ${t.artist || '?'} — ${t.title || '?'}`);
      const fmtBits = [t.format, t.sample_rate ? `${(t.sample_rate / 1000).toFixed(1)} kHz` : null].filter(Boolean);
      if (fmtBits.length) lines.push(`Format:   ${fmtBits.join(' · ')}`);
    }
    lines.push('');
  }
  if (report.system) {
    lines.push('--- System ---');
    lines.push(`${report.system.platform} ${report.system.arch} · Node ${report.system.nodeVersion}`);
    lines.push(`Uptime ${report.system.uptimeSec}s · Free ${report.system.freeMemMB} / ${report.system.totalMemMB} MB`);
    lines.push('');
  }
  if (report.journalTail) {
    const jlines = report.journalTail.split('\n').filter(Boolean);
    const tail = jlines.slice(-50);  // last 50 lines is the cap
    lines.push(`--- Recent log (last ${tail.length} lines) ---`);
    lines.push(tail.join('\n'));
    lines.push('');
  }
  lines.push(`-- Full report on the box: ${report.id}.json`);
  return lines.join('\n');
}

// POST /api/bug-report
//   body: { description: string }
//   returns: { ok, id, file, version, emailBody, fullJson }
router.post('/', (req, res) => {
  const desc = String(req.body?.description || '').trim();
  if (!desc) return res.status(400).json({ error: 'description is required' });
  if (desc.length > 10000) return res.status(400).json({ error: 'description too long (max 10000 chars)' });

  const ts = new Date();
  const tsIso = ts.toISOString();
  const tsFile = tsIso.replace(/[:.]/g, '-');
  const id = safeId();
  const filename = `${tsFile}-${id}.json`;

  const report = {
    id,
    timestamp: tsIso,
    version: version.getVersion(),
    description: desc,
    activeRenderer: readActiveRenderer(),
    system: systemInfo(),
    updateLog: readUpdateLog(),
    journalTail: readJournalTail(500),
  };

  try {
    paths.ensureDirs();
    const fullPath = path.join(paths.BUG_REPORT_DIR, filename);
    fs.writeFileSync(fullPath, JSON.stringify(report, null, 2), 'utf8');

    // v1.1.0.78 — also run retention cleanup on every save. Cheap,
    // and means the disk doesn't accumulate forever for testers who
    // never reboot. See pruneOldReports() below.
    try { pruneOldReports(); } catch (e) { /* non-fatal */ }

    return res.json({
      ok: true,
      id,
      file: fullPath,
      filename,                   // bare filename, useful for client display
      version: report.version,
      // v1.1.0.78 — compact email body for the client's mailto: fallback
      // path (Web Share API path uses fullJson directly as a File).
      emailBody: buildEmailBody(report),
      fullJson: report,
    });
  } catch (e) {
    console.error('[bug-report] write failed:', e);
    return res.status(500).json({ error: e.message });
  }
});

// GET /api/bug-report/list  → { reports: [{ filename, size, mtime }, …] }
// Lets the user see what's queued locally so they can grab the JSON
// to send manually.
router.get('/list', (req, res) => {
  try {
    paths.ensureDirs();
    if (!fs.existsSync(paths.BUG_REPORT_DIR)) return res.json({ reports: [] });
    const items = fs.readdirSync(paths.BUG_REPORT_DIR)
      .filter(f => f.endsWith('.json'))
      .map(f => {
        const st = fs.statSync(path.join(paths.BUG_REPORT_DIR, f));
        return {
          filename: f,
          size: st.size,
          mtime: Math.floor(st.mtimeMs / 1000),
        };
      })
      .sort((a, b) => b.mtime - a.mtime);
    res.json({ reports: items });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/bug-report/file/:name → raw JSON download
router.get('/file/:name', (req, res) => {
  const name = req.params.name;
  // No path traversal — must be a plain filename matching our format
  if (!/^[\w\-:.]+\.json$/.test(name)) return res.status(400).json({ error: 'invalid name' });
  const full = path.join(paths.BUG_REPORT_DIR, name);
  if (!full.startsWith(paths.BUG_REPORT_DIR + path.sep)) {
    return res.status(400).json({ error: 'invalid name' });
  }
  if (!fs.existsSync(full)) return res.status(404).json({ error: 'not found' });
  res.download(full);
});

// v1.1.0.78 — expose retention helper for boot-time + daily sweeps
// (called from server/src/index.js). Express lets us attach arbitrary
// properties to a router; consumer is the daemon, not HTTP.
router.pruneOldReports = pruneOldReports;

module.exports = router;
