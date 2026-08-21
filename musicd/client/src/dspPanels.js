// Which DSP panels are open, per zone (v1.1.32.0).
//
// Four of the five DSP categories switch a real per-zone flag, and that flag
// IS the open/closed state — off means off, and there is nothing to show. The
// fifth, AutoEQ, has no such flag: it loads a preset into the zone's PEQ, and
// that curve is already governed by the Parametric EQ switch. A second switch
// claiming to enable the same filters would be a lie, so its heading only
// opens and closes the panel.
//
// That leaves one piece of state with nowhere to live. It goes in
// localStorage rather than on the server because it is a view preference, not
// a setting: it changes nothing about what comes out of the speakers, and it
// belongs to the device you are looking at. Same reasoning as the library sort
// view and the artists grid/list choice.
//
// Keyed per zone: someone with headphones on one output and speakers on
// another wants AutoEQ open on the first and shut on the second.
const STORE_KEY = 'musicd.dsp_panels'

function readStore() {
  try {
    const raw = localStorage.getItem(STORE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    // JSON that parses can still be the wrong SHAPE — a partial write, a
    // hand-edited value, a blob from a future build. Anything that is not a
    // plain object is discarded rather than indexed into.
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch (e) {
    // Private mode, storage disabled, or corrupt. Panels default to closed;
    // the page renders and nothing is lost but a preference.
    return {}
  }
}

const keyFor = (panel, rendererId) => `${panel}:${rendererId || '-'}`

export function loadDspOpen(panel, rendererId) {
  return readStore()[keyFor(panel, rendererId)] === true
}

export function saveDspOpen(panel, rendererId, open) {
  try {
    const store = readStore()
    if (open) store[keyFor(panel, rendererId)] = true
    // Closed is the default, so record it by ABSENCE. Otherwise every zone
    // the user ever opened this page on leaves a `false` behind for good.
    else delete store[keyFor(panel, rendererId)]
    localStorage.setItem(STORE_KEY, JSON.stringify(store))
  } catch (e) {
    // As above: the panel is already open or closed on screen. A failed write
    // costs the user that choice on the next visit and nothing now.
  }
}
