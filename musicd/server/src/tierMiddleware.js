/**
 * v1.1.1.3 — Tier gating middleware.
 *
 * Reads the current tier from the settings table on every request
 * (cheap — single indexed PK lookup) and exposes:
 *
 *   req.tier            current tier name
 *   req.tierFlags       feature flag map for the tier (or null for tiers above demo)
 *   req.tierCheck(key)  helper: returns true if the feature is allowed
 *
 * Two helpers for routes:
 *
 *   requireFeature(key)        — middleware that 403s if key is not allowed
 *   clampLimit(key, maxFn)     — middleware that clamps req.query.limit
 *                                  to a tier-specific max (used for the
 *                                  album-list 50-cap on demo)
 *
 * The middleware applies tier-aware behavior WITHOUT changing route
 * URLs. Existing client code that doesn't know about tiers continues
 * to work — demo users just get 403s on locked endpoints, which the
 * client can surface as "upgrade to unlock."
 *
 * IMPORTANT: this is server-side enforcement of a SOFT commercial
 * gate. A determined attacker can edit the database, modify the code,
 * or run their own build. We're not pretending otherwise. The point
 * is to make casual bypass inconvenient enough that the honest
 * commercial flow is the path of least resistance.
 */
const db = require('./db');
const tierConfig = require('./tierConfig');

function readTierFromDb(database) {
  try {
    const row = database.prepare("SELECT value FROM settings WHERE key = 'update_tier'").get();
    // v1.1.3.8: normaliseTier floors anything missing, unknown, or
    // below the baseline up to DEFAULT_TIER. So a fresh install with
    // no row and an older install still carrying an explicit 'demo'
    // row both resolve to stable.
    return tierConfig.normaliseTier(row?.value);
  } catch {
    // DB not ready yet — assume the baseline tier. The /api guard
    // above us returns 503 in that case, but during the brief window
    // where tier middleware runs first we want a safe fallback.
    return tierConfig.DEFAULT_TIER;
  }
}

function attachTier(req, res, next) {
  const database = db.get();
  if (!database) {
    // Shouldn't happen — the /api 503 guard runs before this — but
    // be defensive.
    req.tier = tierConfig.DEFAULT_TIER;
    req.tierFlags = tierConfig.featureFlagsForTier(tierConfig.DEFAULT_TIER);
    req.tierCheck = (key) => tierConfig.featureAllowed(tierConfig.DEFAULT_TIER, key);
    return next();
  }
  req.tier = readTierFromDb(database);
  req.tierFlags = tierConfig.featureFlagsForTier(req.tier);
  req.tierCheck = (key) => tierConfig.featureAllowed(req.tier, key);
  next();
}

/**
 * Route-level: 403 if the named feature is not allowed for this tier.
 *
 *   router.post('/dsp/...', requireFeature('dsp'), handler);
 *
 * Demo users get a 403 with a structured body the client can use to
 * show "upgrade to unlock" prompts.
 */
function requireFeature(key) {
  return (req, res, next) => {
    if (!req.tierCheck) return next();   // attachTier didn't run — fail open
    if (req.tierCheck(key) === true) return next();
    return res.status(403).json({
      error: 'Feature not available on this tier',
      feature: key,
      tier: req.tier,
      upgradeRequired: true,
    });
  };
}

/**
 * For demo's library_size_limit. Clamps req.query.limit to the
 * configured limit for the current tier. Doesn't 403 — silently
 * returns fewer rows. The UI shows "showing 50 of N".
 *
 *   router.get('/library/albums', clampLimit('library_size_limit'), handler);
 *
 * v1.1.3.2: also clamps the OFFSET so that offset + limit can't
 * exceed the tier limit. Without this, the client's infinite-scroll
 * behaviour bypasses the cap entirely: each page request gets
 * clamped to 50 rows, but the client just keeps requesting with
 * offset=50, 100, 150… and the server happily serves rows 51-100,
 * 101-150, etc. The cap was effectively a per-request limit, not
 * a total-rows limit.
 *
 * After this fix:
 *   offset=0,   limit=200  → clamped to limit=50,  returns rows 0-49
 *   offset=50,  limit=200  → middleware short-circuits, returns []
 *   offset=100, limit=200  → middleware short-circuits, returns []
 *
 * The client treats "[] returned" the same as a short page
 * (data.length !== PAGE_SIZE) — infinite scroll stops. So demo
 * users see exactly N albums total (where N = library_size_limit),
 * regardless of how aggressively the client paginates.
 *
 * Why short-circuit instead of rewriting limit to 0:
 * The library routes use their own clamp() function with min=1,
 * which forces any 0 back up to 1 — so a "limit=0" rewrite would
 * still return one row per ungated page request and the cap would
 * leak. Returning [] from middleware bypasses the route entirely,
 * which is both faster and safer against this kind of downstream
 * re-clamping.
 */
function clampLimit(key) {
  return (req, res, next) => {
    if (!req.tierCheck) return next();
    const flags = req.tierFlags;
    if (!flags) return next();
    const limit = flags[key];
    if (typeof limit !== 'number' || limit <= 0) return next();
    // Pull the requested limit + offset from query.
    const requestedLimit = parseInt(req.query.limit, 10);
    const requestedOffset = parseInt(req.query.offset, 10);
    const effectiveOffset = isNaN(requestedOffset) ? 0 : Math.max(0, requestedOffset);

    // User has paginated past the cap — short-circuit with [].
    // Don't call next(); the route never runs.
    if (effectiveOffset >= limit) {
      return res.json([]);
    }

    // Otherwise: how many rows are still available within the cap?
    const remaining = limit - effectiveOffset;
    const baseEffective = isNaN(requestedLimit) ? limit : Math.min(requestedLimit, limit);
    const effective = Math.min(baseEffective, remaining);
    req.query.limit = String(effective);
    // Stash the original so the route can include it in the response
    // for client-side "you're seeing N of M" display.
    req.tierLimitApplied = { key, limit, originalRequested: requestedLimit || null };
    next();
  };
}

module.exports = { attachTier, requireFeature, clampLimit };
