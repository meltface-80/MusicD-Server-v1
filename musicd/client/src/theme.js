// The four themes, and the one place that applies them (v1.1.24.0).
//
// Brought across from MusicD-Remote, including the two-attribute shape:
// data-theme is the FAMILY (dark | light) and data-palette is the COLOURS
// (classic | copper). Two attributes rather than four theme names because
// two tokens are family-dependent — see the palette blocks in index.css.
//
// The choice lives in localStorage, not on the server, deliberately: it is a
// property of the SCREEN you are looking at, not of the library. A phone in
// bed and a desktop in daylight want different answers, and one server-side
// setting would force them to agree. Same reasoning as the per-grid sort view
// in librarySort.js.
const STORAGE_KEY = 'musicd.theme'

export const DEFAULT_THEME = 'dark'

// `theme` and `palette` are what land on <html>. `swatch` is the pair of
// colours the picker previews with, taken from the palette's own --bg-base
// and --accent so the row shows the theme rather than describing it.
export const THEMES = [
  {
    id: 'dark',
    label: 'Dark',
    note: 'The original. Cool charcoal with a blue accent.',
    theme: 'dark',
    palette: 'classic',
  },
  {
    id: 'light',
    label: 'Light',
    note: 'The same palette in daylight. Warm paper white.',
    theme: 'light',
    palette: 'classic',
  },
  {
    id: 'copper-dark',
    label: 'Copper',
    note: "The MusicD site's own colours — warm charcoal and copper.",
    theme: 'dark',
    palette: 'copper',
  },
  {
    id: 'brass-light',
    label: 'Brass',
    note: 'Copper in daylight. Parchment neutrals, all the colour in the accent.',
    theme: 'light',
    palette: 'copper',
  },
]

export function themeById(id) {
  return THEMES.find(t => t.id === id) || null
}

// An unknown id — a theme removed in a later build, a hand-edited storage
// entry — resolves to the default rather than leaving the app unthemed.
export function normaliseThemeId(id) {
  return themeById(id) ? id : DEFAULT_THEME
}

export function loadThemeId() {
  try {
    return normaliseThemeId(localStorage.getItem(STORAGE_KEY))
  } catch (e) {
    // Private mode, or storage disabled. The default is a complete theme, so
    // there is nothing to recover from and nothing to tell the user.
    return DEFAULT_THEME
  }
}

export function saveThemeId(id) {
  try {
    localStorage.setItem(STORAGE_KEY, normaliseThemeId(id))
  } catch (e) {
    // As above: the theme is already applied in the DOM, so a failed write
    // costs the user their choice on the next launch and nothing now.
  }
}

// The one writer of these attributes. Everything else calls this.
export function applyTheme(id) {
  const t = themeById(normaliseThemeId(id))
  const root = document.documentElement
  root.dataset.theme = t.theme
  root.dataset.palette = t.palette
  // iOS tints the status bar and the app-switcher card from this. Left at a
  // fixed black it framed the light themes in a dark band. Read back from the
  // applied palette rather than kept as a fifth copy of the colour here.
  const meta = document.querySelector('meta[name="theme-color"]')
  if (meta) {
    const bg = getComputedStyle(root).getPropertyValue('--bg-base').trim()
    if (bg) meta.setAttribute('content', bg)
  }
  return t.id
}
