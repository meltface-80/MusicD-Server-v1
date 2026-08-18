// DSP profile management (#29.3)
// =================================
// Per-renderer named profile sets. The renderer_dsp row is the LIVE state
// (what the stream pipeline applies). dsp_profiles holds named snapshots
// that the user can save, switch between, and delete.
//
// Apply semantics: when a profile is loaded, we copy its payload into
// renderer_dsp and mark it is_active=1 (clearing any previous active flag
// on that renderer). On Save (overwrite), we read the current
// renderer_dsp and write it back into the active profile's payload.
//
// On first 29.3 boot, any renderer that has a non-default renderer_dsp row
// gets an automatic "Default" profile seeded so existing users don't lose
// their settings. See seedDefaults() — called once from db.init().

const db = require('../db');

// Fields copied between renderer_dsp and a profile payload. peq_preamp_db
// is excluded — it's auto-calculated from peq_filters every save, so
// storing it in a profile is misleading (the value would only be correct
// at save-time and stale on apply if the math algorithm changes).
//
// (#29.6) headroom_* and clipping_indicator dropped — the auto-preamp
// computed from peq_filters is the sole clipping protection now.
// v1.1.0.60 — added headroom_enabled and headroom_db so saved profiles
// preserve the headroom slider state. Previously a Save-as / Apply
// round-trip silently dropped headroom back to defaults, mirroring the
// PUT-route bug fixed in the same release.
const PROFILE_FIELDS = [
  'master_enabled',
  'peq_enabled', 'peq_filters',
  'headroom_enabled', 'headroom_db',
  'conv_enabled', 'conv_irs', 'conv_dry_db', 'conv_wet_db',
  'crossfeed_enabled', 'crossfeed_profile',
  'autoeq_model',
];

function safeJson(s, fallback) {
  if (s == null) return fallback;
  if (typeof s !== 'string') return s;
  try { return JSON.parse(s); } catch { return fallback; }
}

// Build a profile payload object from a renderer_dsp row. Booleans are
// stored as 0/1 in SQLite — we preserve that shape so apply() can flow
// through directly without touching every field.
function payloadFromLive(rendererId) {
  const row = db.get().prepare('SELECT * FROM renderer_dsp WHERE renderer_id = ?').get(rendererId);
  if (!row) {
    // Renderer doesn't have a live row yet (never edited). Build a default.
    return {
      master_enabled:     1,
      peq_enabled:        0,
      peq_filters:        null,
      headroom_enabled:   0,
      headroom_db:        -3,
      conv_enabled:       0,
      conv_irs:           null,
      conv_dry_db:        -120,
      conv_wet_db:        0,
      crossfeed_enabled:  0,
      crossfeed_profile:  null,
      autoeq_model:       null,
    };
  }
  const out = {};
  for (const f of PROFILE_FIELDS) out[f] = row[f];
  return out;
}

// List all saved profiles for a renderer. Returns an array of
// { id, name, is_active, created_at, updated_at } — payload is omitted to
// keep the listing lightweight; UI fetches payload via getProfile() on
// the apply path.
function listProfiles(rendererId) {
  return db.get().prepare(`
    SELECT id, name, is_active, created_at, updated_at
    FROM dsp_profiles
    WHERE renderer_id = ?
    ORDER BY name COLLATE NOCASE
  `).all(rendererId);
}

// Get one profile, with payload parsed.
function getProfile(profileId) {
  const row = db.get().prepare('SELECT * FROM dsp_profiles WHERE id = ?').get(profileId);
  if (!row) return null;
  return { ...row, payload: safeJson(row.payload, {}) };
}

// Get the active profile for a renderer (or null if none marked).
function getActiveProfile(rendererId) {
  const row = db.get().prepare(`
    SELECT * FROM dsp_profiles
    WHERE renderer_id = ? AND is_active = 1
    LIMIT 1
  `).get(rendererId);
  if (!row) return null;
  return { ...row, payload: safeJson(row.payload, {}) };
}

// Create a new profile from the current live state. Throws if a profile
// with this name already exists for this renderer (UNIQUE constraint).
// Marks the new profile active and clears any previous active flag.
function createFromLive(rendererId, name) {
  const trimmed = String(name || '').trim();
  if (!trimmed) throw new Error('Name required');
  if (trimmed.length > 80) throw new Error('Name too long (max 80 chars)');

  const payload = payloadFromLive(rendererId);
  const tx = db.get().transaction(() => {
    // Demote any current active profile for this renderer
    db.get().prepare(`
      UPDATE dsp_profiles SET is_active = 0
      WHERE renderer_id = ? AND is_active = 1
    `).run(rendererId);
    const info = db.get().prepare(`
      INSERT INTO dsp_profiles (renderer_id, name, payload, is_active, created_at, updated_at)
      VALUES (?, ?, ?, 1, unixepoch(), unixepoch())
    `).run(rendererId, trimmed, JSON.stringify(payload));
    return info.lastInsertRowid;
  });
  try {
    return tx();
  } catch (e) {
    if (String(e.message).includes('UNIQUE constraint')) {
      throw new Error(`A profile named "${trimmed}" already exists on this renderer`);
    }
    throw e;
  }
}

// Overwrite an existing profile's payload from the current live state.
// (User has loaded profile X, made changes, now wants to commit them
// back to the same profile rather than create a new one.) Profile must
// belong to the renderer; we don't allow saving across renderers.
function saveLiveToProfile(profileId, rendererId) {
  const row = db.get().prepare(`SELECT renderer_id FROM dsp_profiles WHERE id = ?`).get(profileId);
  if (!row) throw new Error('Profile not found');
  if (row.renderer_id !== rendererId) throw new Error('Profile belongs to a different renderer');
  const payload = payloadFromLive(rendererId);
  db.get().prepare(`
    UPDATE dsp_profiles
    SET payload = ?, updated_at = unixepoch()
    WHERE id = ?
  `).run(JSON.stringify(payload), profileId);
  return getProfile(profileId);
}

// Apply a profile's payload to renderer_dsp. The stream pipeline reads
// renderer_dsp on every track so the change becomes audible on the next
// track played.
function applyProfile(profileId) {
  const profile = getProfile(profileId);
  if (!profile) throw new Error('Profile not found');
  const p = profile.payload || {};
  const rendererId = profile.renderer_id;

  const tx = db.get().transaction(() => {
    // Mark this profile active, clear others
    db.get().prepare(`UPDATE dsp_profiles SET is_active = 0 WHERE renderer_id = ?`).run(rendererId);
    db.get().prepare(`UPDATE dsp_profiles SET is_active = 1 WHERE id = ?`).run(profileId);

    // Write payload into renderer_dsp. We use the dsp module's saveProfile
    // path here so the auto-preamp recalc happens (peq_preamp_db is
    // computed from peq_filters server-side).
    const dsp = require('./index');
    // Strip null-ish fields so we don't blow away any defaults the dsp
    // module sets. dsp.saveProfile merges with the existing row.
    const patch = {};
    for (const f of PROFILE_FIELDS) {
      if (p[f] != null) patch[f] = p[f];
    }
    // peq_filters comes back as either a JSON string (from older
    // payloads) or already-parsed array. Normalise to array shape since
    // dsp.saveProfile expects arrays.
    if (typeof patch.peq_filters === 'string') {
      patch.peq_filters = safeJson(patch.peq_filters, []);
    }
    if (typeof patch.conv_irs === 'string') {
      patch.conv_irs = safeJson(patch.conv_irs, {});
    }
    // No boolean coercion needed — sqlite stored 0/1 already work correctly
    // through dsp.saveProfile's `value ? 1 : 0` ternaries.
    dsp.saveProfile(rendererId, patch);
  });
  tx();
  return getProfile(profileId);
}

// Rename. The UNIQUE(renderer_id, name) constraint will catch collisions.
function renameProfile(profileId, newName) {
  const trimmed = String(newName || '').trim();
  if (!trimmed) throw new Error('Name required');
  if (trimmed.length > 80) throw new Error('Name too long (max 80 chars)');
  try {
    db.get().prepare(`
      UPDATE dsp_profiles SET name = ?, updated_at = unixepoch() WHERE id = ?
    `).run(trimmed, profileId);
  } catch (e) {
    if (String(e.message).includes('UNIQUE constraint')) {
      throw new Error(`A profile named "${trimmed}" already exists on this renderer`);
    }
    throw e;
  }
  return getProfile(profileId);
}

// Multi-delete. Returns count of profiles actually removed (in case some
// IDs were already gone). Refuses to delete the last profile of a
// renderer — the user should clear its contents instead, not orphan the
// renderer with no profile at all (UI invariants get awkward otherwise).
function deleteProfiles(profileIds) {
  if (!Array.isArray(profileIds) || profileIds.length === 0) return { deleted: 0 };

  // Group by renderer so we can check the "don't delete the last one" rule
  const placeholders = profileIds.map(() => '?').join(',');
  const rows = db.get().prepare(`
    SELECT id, renderer_id FROM dsp_profiles WHERE id IN (${placeholders})
  `).all(...profileIds);

  // Count remaining profiles per renderer if we delete all requested ids
  const byRenderer = {};
  for (const r of rows) {
    byRenderer[r.renderer_id] = byRenderer[r.renderer_id] || { ids: [] };
    byRenderer[r.renderer_id].ids.push(r.id);
  }
  const blocked = [];
  for (const [rendererId, info] of Object.entries(byRenderer)) {
    const total = db.get().prepare(`SELECT COUNT(*) as n FROM dsp_profiles WHERE renderer_id = ?`).get(rendererId).n;
    if (total - info.ids.length < 1) {
      // Would leave this renderer with zero profiles. Refuse the whole call.
      blocked.push(rendererId);
    }
  }
  if (blocked.length > 0) {
    throw new Error('Cannot delete every profile from a renderer. Keep at least one (you can clear its contents instead).');
  }

  const info = db.get().prepare(`
    DELETE FROM dsp_profiles WHERE id IN (${placeholders})
  `).run(...profileIds);
  return { deleted: info.changes };
}

// One-time migration: for each renderer_dsp row that exists, create a
// "Default" profile if no profiles exist yet for that renderer. Idempotent
// — safe to run on every boot.
function seedDefaults() {
  try {
    const rows = db.get().prepare(`
      SELECT renderer_id FROM renderer_dsp
      WHERE renderer_id NOT IN (SELECT DISTINCT renderer_id FROM dsp_profiles)
    `).all();
    for (const { renderer_id } of rows) {
      try {
        const payload = payloadFromLive(renderer_id);
        db.get().prepare(`
          INSERT INTO dsp_profiles (renderer_id, name, payload, is_active, created_at, updated_at)
          VALUES (?, 'Default', ?, 1, unixepoch(), unixepoch())
        `).run(renderer_id, JSON.stringify(payload));
      } catch (e) { /* per-row failure is non-fatal */ }
    }
    if (rows.length > 0) console.log(`✓ Seeded ${rows.length} default DSP profiles`);
  } catch (e) {
    console.warn('DSP profile seed failed:', e.message);
  }
}

module.exports = {
  PROFILE_FIELDS,
  listProfiles,
  getProfile,
  getActiveProfile,
  createFromLive,
  saveLiveToProfile,
  applyProfile,
  renameProfile,
  deleteProfiles,
  seedDefaults,
};
