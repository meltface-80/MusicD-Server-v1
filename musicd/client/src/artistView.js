// Grid or list, for the Artists screen (v1.1.26.0).
//
// localStorage, not component state and not the in-memory cache, for the same
// reason the library's sort view is: the screen unmounts whenever you open an
// artist, and on iOS the whole app is discarded whenever the home-screen
// shortcut relaunches cold. sessionStorage would be lost on exactly the trip
// the user notices.
//
// One key, not one per screen — unlike the sort view, there is only one
// artists wall.
const STORE_KEY = 'musicd_artist_view'

export const ARTIST_VIEWS = ['grid', 'list']
export const DEFAULT_ARTIST_VIEW = 'grid'

// A stored value can be a name this build does not know: a view removed in a
// later release, or a hand-edited entry. Anything unrecognised is the default
// rather than an unrendered screen.
export function normaliseArtistView(v) {
  return ARTIST_VIEWS.includes(v) ? v : DEFAULT_ARTIST_VIEW
}

export function loadArtistView() {
  try {
    return normaliseArtistView(localStorage.getItem(STORE_KEY))
  } catch (e) {
    // Private browsing, or storage disabled. The default is a complete view,
    // so there is nothing to recover from and nothing to tell the user.
    return DEFAULT_ARTIST_VIEW
  }
}

export function saveArtistView(v) {
  try {
    localStorage.setItem(STORE_KEY, normaliseArtistView(v))
  } catch (e) {
    // As above: the view is already applied on screen, so a failed write costs
    // the user their choice on the next launch and nothing now.
  }
}
