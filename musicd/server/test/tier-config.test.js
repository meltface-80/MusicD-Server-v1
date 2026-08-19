// Access tiers.
//
// Stable is the baseline: no install may sit below it, so a fresh install
// is unlocked without a code. The four 4-digit codes still upgrade to the
// higher channels, and they are validated by hashing with a fixed salt and
// comparing against the manifest — so the hashes here and the ones in
// manifest.json must not drift apart.

const test = require('node:test');
const assert = require('node:assert/strict');
const tierConfig = require('../src/tierConfig');

test('stable is the floor', async (t) => {
  const cases = [
    [undefined, 'stable'], [null, 'stable'], ['', 'stable'],
    ['demo', 'stable'],                       // an old row must be lifted
    ['stable', 'stable'],
    ['earlyAccess', 'earlyAccess'], ['beta', 'beta'], ['alpha', 'alpha'],
    ['garbage', 'stable'], ['DEMO', 'stable'],
  ];
  for (const [input, expected] of cases) {
    await t.test(`${JSON.stringify(input)} -> ${expected}`, () => {
      assert.equal(tierConfig.normaliseTier(input), expected);
    });
  }
});

test('the baseline tier has no feature restrictions', () => {
  // featureFlagsForTier returns flags only for demo; anything above it is
  // unrestricted. A non-null here would re-impose the 50-album cap.
  assert.equal(tierConfig.featureFlagsForTier(tierConfig.DEFAULT_TIER), null);
  for (const key of ['settings_write', 'dsp', 'scrobbling', 'backup_restore',
                     'rescan', 'multi_zone', 'share_links', 'library_size_limit']) {
    assert.equal(tierConfig.featureAllowed(tierConfig.DEFAULT_TIER, key), true, key);
  }
});

test('the demo definition is retained so the gate can be restored', () => {
  assert.ok(tierConfig.TIER_DEFINITIONS.demo);
  assert.equal(tierConfig.DEMO_FEATURE_FLAGS.library_size_limit, 50);
});

test('the four codes resolve to their tiers', async (t) => {
  // Built from the salt the server actually uses, so this proves the codes
  // and the hashing agree without hard-coding a digest twice.
  const accessTiers = Object.fromEntries(
    Object.entries({ stable: '7733', earlyAccess: '9632', beta: '4261', alpha: '8417' })
      .map(([tier, code]) => [tier, { codeHash: tierConfig.hashCode(code) }]));

  for (const [code, tier] of [['7733','stable'],['9632','earlyAccess'],
                              ['4261','beta'],['8417','alpha']]) {
    await t.test(`${code} -> ${tier}`, () => {
      assert.equal(tierConfig.tierForCode(code, accessTiers), tier);
    });
  }
  await t.test('an unknown code resolves to nothing', () => {
    assert.equal(tierConfig.tierForCode('0000', accessTiers), null);
  });
  await t.test('the salt has not changed', () => {
    // Changing it invalidates every published manifest at once.
    assert.equal(tierConfig.TIER_CODE_SALT, 'musicd-v1-tier-');
  });
});

test('higher tiers see the lower channels', () => {
  assert.deepEqual(tierConfig.channelsForTier('stable'), ['stable']);
  for (const t of ['earlyAccess', 'beta', 'alpha']) {
    assert.ok(tierConfig.channelsForTier(t).includes('stable'), t);
  }
  assert.ok(tierConfig.channelsForTier('alpha').length >= 4);
});

test('an unknown tier falls back to the baseline, not to demo', () => {
  assert.deepEqual(tierConfig.channelsForTier('nonsense'),
                   tierConfig.TIER_DEFINITIONS[tierConfig.DEFAULT_TIER].channels);
});
