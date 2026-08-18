// Central path resolver for runtime-mutable data (#29.0).
//
// We've historically grown DATA_DIR conventions ad-hoc in different files
// (db.js, coverArt.js, etc each compute their own). This module centralises
// the layout so DSP-related directories — IRs, PEQ presets, the bundled
// AutoEQ snapshot — line up with the existing covers/ and artist-logos/
// without surprises.
//
//   <data>/
//     musicd.db
//     covers/
//     artist-logos/
//     dsp/
//       ir/         user-uploaded WAV impulse responses
//       peq/        saved manual PEQ profiles (JSON)
//       autoeq/     bundled AutoEQ snapshot (presets/* + index.json)
//
// In production the data root is whatever DB_PATH's directory resolves to;
// in dev it's `<repo>/server/data/`.

const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '../../data/musicd.db');
const DATA_DIR = path.dirname(DB_PATH);

const DSP_DIR    = path.join(DATA_DIR, 'dsp');
const IR_DIR     = path.join(DSP_DIR, 'ir');
const PEQ_DIR    = path.join(DSP_DIR, 'peq');
const AUTOEQ_DIR = path.join(DSP_DIR, 'autoeq');

// v1.1.0.60 — local bug-report dump directory. The "Report a bug"
// button on the Update screen drops a JSON file here with the user's
// description, server version, current track, last update log, and a
// tail of the systemd journal. Files are timestamped; nothing is
// rotated automatically yet (volume should be tiny in practice — one
// file per submitted report).
const BUG_REPORT_DIR = path.join(DATA_DIR, 'bug-reports');

// Bundled AutoEQ starter snapshot ships inside the source tree (it's
// versioned with the build) and is *copied* into DATA_DIR/dsp/autoeq/ on
// first boot if not already present. After that the user-data location is
// canonical so manual overrides survive upgrades.
//
// Note: the bundle lives under server/src/dsp/autoeq-starter (alongside the
// rest of the dsp module), not server/src/autoeq-starter. The earlier
// version of this path was wrong, which silently broke the seed step.
const BUNDLED_AUTOEQ_DIR = path.join(__dirname, 'dsp', 'autoeq-starter');

function ensureDirs() {
  for (const d of [DSP_DIR, IR_DIR, PEQ_DIR, AUTOEQ_DIR, BUG_REPORT_DIR]) {
    try { fs.mkdirSync(d, { recursive: true }); } catch (e) { /* non-fatal */ }
  }
  // Seed the AutoEQ data dir with the bundled starter snapshot on first run.
  // We do this by checking whether index.json already exists in the runtime
  // location — if not, copy from the bundled tree. This means edits the user
  // makes (e.g. via "Update AutoEQ database") win over the bundle on
  // subsequent boots.
  try {
    const target = path.join(AUTOEQ_DIR, 'index.json');
    if (!fs.existsSync(target) && fs.existsSync(BUNDLED_AUTOEQ_DIR)) {
      copyDirSync(BUNDLED_AUTOEQ_DIR, AUTOEQ_DIR);
      console.log(`✓ Seeded AutoEQ starter snapshot → ${AUTOEQ_DIR}`);
    }
  } catch (e) { console.warn('AutoEQ seed failed:', e.message); }
}

function copyDirSync(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDirSync(s, d);
    else fs.copyFileSync(s, d);
  }
}

module.exports = {
  DATA_DIR,
  DSP_DIR,
  IR_DIR,
  PEQ_DIR,
  AUTOEQ_DIR,
  BUG_REPORT_DIR,
  BUNDLED_AUTOEQ_DIR,
  ensureDirs,
};
