// Sonos bonded sets.
//
// Every ZonePlayer answers SSDP for itself, so a stereo pair registered as
// two renderers with the same extracted name — and only one of them worked.
// The other was the bonded satellite: it answers discovery but rejects
// SetAVTransportURI, because in a bonded set only the group coordinator
// drives playback. Discovery now reads ZoneGroupTopology and registers
// coordinators only.
//
// Firmware represents a bonded set three different ways, so all three are
// pinned here. Getting this wrong hides a speaker the user owns, which is
// worse than the original bug.

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseZoneGroupState, fetchTopology } = require('../src/renderers/sonos');

const LR  = 'RINCON_AAA01400';   // Living Room, coordinator
const LR2 = 'RINCON_BBB01400';   // Living Room, bonded satellite
const KIT = 'RINCON_CCC01400';   // Kitchen, standalone

test('stereo pair: satellite listed as its own Invisible member', async () => {
  const { hidden, rooms } = await parseZoneGroupState(`<ZoneGroupState><ZoneGroups>
    <ZoneGroup Coordinator="${LR}" ID="${LR}:3">
      <ZoneGroupMember UUID="${LR}" ZoneName="Living Room" Invisible="0"
        ChannelMapSet="${LR}:LF,LF;${LR2}:RF,RF"/>
      <ZoneGroupMember UUID="${LR2}" ZoneName="Living Room" Invisible="1"/>
    </ZoneGroup>
    <ZoneGroup Coordinator="${KIT}" ID="${KIT}:5">
      <ZoneGroupMember UUID="${KIT}" ZoneName="Kitchen" Invisible="0"/>
    </ZoneGroup>
  </ZoneGroups></ZoneGroupState>`);

  assert.ok(!hidden.has(LR), 'the coordinator must stay visible');
  assert.ok(hidden.has(LR2), 'the satellite must be hidden');
  assert.ok(!hidden.has(KIT), 'an unrelated standalone must be untouched');
  assert.equal(rooms.get(LR), 'Living Room');
});

test('stereo pair: satellite named only in ChannelMapSet', async () => {
  // Some firmware omits the satellite as a member entirely.
  const { hidden } = await parseZoneGroupState(`<ZoneGroupState><ZoneGroups>
    <ZoneGroup Coordinator="${LR}" ID="${LR}:3">
      <ZoneGroupMember UUID="${LR}" ZoneName="Living Room" Invisible="0"
        ChannelMapSet="${LR}:LF,LF;${LR2}:RF,RF"/>
    </ZoneGroup>
  </ZoneGroups></ZoneGroupState>`);
  assert.ok(hidden.has(LR2));
  assert.ok(!hidden.has(LR));
});

test('home theatre: nested Satellite elements and HTSatChanMapSet', async () => {
  const ARC = 'RINCON_ARC01400', SUB = 'RINCON_SUB01400';
  const S1 = 'RINCON_S101400', S2 = 'RINCON_S201400';
  const { hidden } = await parseZoneGroupState(`<ZoneGroupState><ZoneGroups>
    <ZoneGroup Coordinator="${ARC}" ID="${ARC}:9">
      <ZoneGroupMember UUID="${ARC}" ZoneName="TV Room" Invisible="0"
        HTSatChanMapSet="${ARC}:LF,RF;${SUB}:SW;${S1}:LR;${S2}:RR">
        <Satellite UUID="${S1}" ZoneName="TV Room" Invisible="1"/>
        <Satellite UUID="${S2}" ZoneName="TV Room" Invisible="1"/>
      </ZoneGroupMember>
    </ZoneGroup>
  </ZoneGroups></ZoneGroupState>`);
  for (const u of [SUB, S1, S2]) assert.ok(hidden.has(u), u);
  assert.ok(!hidden.has(ARC), 'the soundbar drives playback');
});

test('a room grouped under another follows its coordinator', async () => {
  const { hidden } = await parseZoneGroupState(`<ZoneGroupState><ZoneGroups>
    <ZoneGroup Coordinator="${LR}" ID="${LR}:7">
      <ZoneGroupMember UUID="${LR}" ZoneName="Living Room" Invisible="0"/>
      <ZoneGroupMember UUID="${KIT}" ZoneName="Kitchen" Invisible="0"/>
    </ZoneGroup>
  </ZoneGroups></ZoneGroupState>`);
  assert.ok(hidden.has(KIT), 'a grouped follower cannot be played to directly');
  assert.ok(!hidden.has(LR));
});

test('with no pairs, nothing is hidden', async () => {
  const { hidden, rooms } = await parseZoneGroupState(`<ZoneGroupState><ZoneGroups>
    <ZoneGroup Coordinator="${LR}" ID="${LR}:1">
      <ZoneGroupMember UUID="${LR}" ZoneName="Living Room" Invisible="0"/>
    </ZoneGroup>
    <ZoneGroup Coordinator="${KIT}" ID="${KIT}:2">
      <ZoneGroupMember UUID="${KIT}" ZoneName="Kitchen" Invisible="0"/>
    </ZoneGroup>
  </ZoneGroups></ZoneGroupState>`);
  assert.equal(hidden.size, 0);
  assert.equal(rooms.size, 2);
});

test("a coordinator is never hidden by another member's stale map", async () => {
  const { hidden } = await parseZoneGroupState(`<ZoneGroupState><ZoneGroups>
    <ZoneGroup Coordinator="${LR}" ID="${LR}:1">
      <ZoneGroupMember UUID="${LR}" ZoneName="Living Room" Invisible="0"/>
    </ZoneGroup>
    <ZoneGroup Coordinator="${KIT}" ID="${KIT}:2">
      <ZoneGroupMember UUID="${KIT}" ZoneName="Kitchen" Invisible="0"
        ChannelMapSet="${KIT}:LF,LF;${LR}:RF,RF"/>
    </ZoneGroup>
  </ZoneGroups></ZoneGroupState>`);
  assert.ok(!hidden.has(LR), 'hiding a coordinator loses a speaker entirely');
});

test('fetchTopology unwraps the SOAP envelope and its escaped payload', async () => {
  // GetZoneGroupState returns the real document as an escaped XML STRING
  // inside the response, so it needs a second parse. Getting this wrong
  // yields an empty topology and silently disables the whole feature.
  const inner =
    `<ZoneGroupState><ZoneGroups><ZoneGroup Coordinator="${LR}" ID="${LR}:3">` +
    `<ZoneGroupMember UUID="${LR}" ZoneName="Living Room" Invisible="0" ` +
    `ChannelMapSet="${LR}:LF,LF;${LR2}:RF,RF"/>` +
    `<ZoneGroupMember UUID="${LR2}" ZoneName="Living Room" Invisible="1"/>` +
    `</ZoneGroup></ZoneGroups></ZoneGroupState>`;
  const esc = inner.replace(/&/g, '&amp;').replace(/</g, '&lt;')
                   .replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  const axios = require('axios');
  const realPost = axios.post;
  let seenUrl = null, seenAction = null;
  axios.post = async (url, body, cfg) => {
    seenUrl = url; seenAction = cfg.headers.SOAPAction;
    return { data:
      '<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">' +
      '<s:Body><u:GetZoneGroupStateResponse ' +
      'xmlns:u="urn:schemas-upnp-org:service:ZoneGroupTopology:1">' +
      `<ZoneGroupState>${esc}</ZoneGroupState>` +
      '</u:GetZoneGroupStateResponse></s:Body></s:Envelope>' };
  };
  try {
    const { hidden, rooms } = await fetchTopology('192.168.0.10', '1400');
    assert.equal(seenUrl, 'http://192.168.0.10:1400/ZoneGroupTopology/Control');
    assert.equal(seenAction,
      '"urn:schemas-upnp-org:service:ZoneGroupTopology:1#GetZoneGroupState"');
    assert.ok(hidden.has(LR2) && !hidden.has(LR));
    assert.equal(rooms.get(LR), 'Living Room');
  } finally {
    axios.post = realPost;
  }
});

test('an unreachable speaker rejects rather than hiding everything', async () => {
  // The caller fails OPEN on a rejection: every speaker stays registered.
  // Resolving with an empty topology instead would hide nothing but also
  // silently stop filtering, so the rejection itself is the contract.
  const axios = require('axios');
  const realPost = axios.post;
  axios.post = async () => { throw new Error('ECONNREFUSED'); };
  try {
    await assert.rejects(() => fetchTopology('192.168.0.99', '1400'));
  } finally {
    axios.post = realPost;
  }
});
