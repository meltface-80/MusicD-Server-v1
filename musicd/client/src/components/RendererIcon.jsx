import React from 'react'

// Renderer icon set (#30.22)
// ==========================
// SVG path data for ~24 icons used in the per-renderer icon picker.
// Each icon is a single <path> rendered inside a 256x256 viewBox so
// they all scale uniformly. Style is "filled monochrome" -- they
// inherit currentColor so they match whatever colour the parent
// element uses.
//
// Source: Phosphor Icons (https://phosphoricons.com), MIT licensed.
// Path data was hand-extracted from the official "fill" weight SVGs.
// I've kept the original viewBox and path so future updates can be
// drop-in. Brand-specific icons (WiiM, Sonos, Squeezelite, Last.fm)
// are NOT included -- those are trademarked logos that the user can
// supplement separately by dropping additional SVG files alongside.
//
// Icon ids are short string keys that get persisted in the database.
// Don't rename them lightly -- existing renderer_settings rows will
// fall back to default if their saved id doesn't exist anymore.

// Icon definitions. Each entry: { id, label, category, path }
// Category determines which tab the icon shows up under in the picker.
export const ICONS = [
  // -- Speakers --
  { id: 'speaker',         label: 'Speaker',          category: 'speakers',
    path: 'M192,24H64A16,16,0,0,0,48,40V216a16,16,0,0,0,16,16H192a16,16,0,0,0,16-16V40A16,16,0,0,0,192,24ZM128,72a16,16,0,1,1-16,16A16,16,0,0,1,128,72Zm0,128a40,40,0,1,1,40-40A40,40,0,0,1,128,200Zm0-64a24,24,0,1,0,24,24A24,24,0,0,0,128,136Z' },
  { id: 'speaker-wifi',    label: 'Wireless speaker', category: 'speakers',
    path: 'M232,108v36a12,12,0,0,1-24,0V108a12,12,0,0,1,24,0Zm-44-44V216a16,16,0,0,1-16,16H64a16,16,0,0,1-16-16V40A16,16,0,0,1,64,24h84a4,4,0,0,1,4,4V60a4,4,0,0,0,4,4h28A4,4,0,0,1,188,64ZM152,160a32,32,0,1,0-32,32A32,32,0,0,0,152,160Zm-32-72a12,12,0,1,0,12,12A12,12,0,0,0,120,88Z' },
  { id: 'speaker-bt',      label: 'Bluetooth speaker', category: 'speakers',
    path: 'M192,24H64A16,16,0,0,0,48,40V216a16,16,0,0,0,16,16H192a16,16,0,0,0,16-16V40A16,16,0,0,0,192,24ZM128,200a40,40,0,1,1,40-40A40,40,0,0,1,128,200Zm26.83-72.83-15.51,9.31,15.51,9.31a8,8,0,0,1,0,13.42l-24,14.4a8,8,0,0,1-12.13-6.85V152.55l-7.51,4.51a8,8,0,1,1-8.24-13.72L120.45,138l-17.5-10.51a8,8,0,1,1,8.24-13.72l7.51,4.51V103.45a8,8,0,0,1,12.13-6.85l24,14.4A8,8,0,0,1,154.83,127.17ZM136,124.71l8.46-5.07L136,114.55Zm0,38.74,8.46-5.07L136,153.31Z' },
  { id: 'soundbar',        label: 'Soundbar',         category: 'speakers',
    path: 'M232,80H24A16,16,0,0,0,8,96v64a16,16,0,0,0,16,16H232a16,16,0,0,0,16-16V96A16,16,0,0,0,232,80ZM64,144a16,16,0,1,1,16-16A16,16,0,0,1,64,144Zm64,0a16,16,0,1,1,16-16A16,16,0,0,1,128,144Zm64,0a16,16,0,1,1,16-16A16,16,0,0,1,192,144Z' },
  { id: 'speakers',        label: 'Speakers',         category: 'speakers',
    path: 'M196,28H148a16,16,0,0,0-16,16V216a16,16,0,0,0,16,16h48a16,16,0,0,0,16-16V44A16,16,0,0,0,196,28ZM172,80a12,12,0,1,1,12-12A12,12,0,0,1,172,80Zm0,112a32,32,0,1,1,32-32A32,32,0,0,1,172,192Zm0-48a16,16,0,1,0,16,16A16,16,0,0,0,172,144ZM108,28H60A16,16,0,0,0,44,44V216a16,16,0,0,0,16,16h48a16,16,0,0,0,16-16V44A16,16,0,0,0,108,28ZM84,80A12,12,0,1,1,96,68,12,12,0,0,1,84,80Zm0,112a32,32,0,1,1,32-32A32,32,0,0,1,84,192Zm0-48a16,16,0,1,0,16,16A16,16,0,0,0,84,144Z' },

  // -- Audio gear --
  { id: 'amplifier',       label: 'Amplifier',        category: 'gear',
    path: 'M232,72H24A16,16,0,0,0,8,88V184a16,16,0,0,0,16,16H232a16,16,0,0,0,16-16V88A16,16,0,0,0,232,72ZM64,168a32,32,0,1,1,32-32A32,32,0,0,1,64,168Zm104-8H136a8,8,0,0,1,0-16h32a8,8,0,0,1,0,16Zm32-32H136a8,8,0,0,1,0-16h64a8,8,0,0,1,0,16Z' },
  { id: 'av-receiver',     label: 'AV Receiver',      category: 'gear',
    path: 'M224,56H32A16,16,0,0,0,16,72V184a16,16,0,0,0,16,16H224a16,16,0,0,0,16-16V72A16,16,0,0,0,224,56ZM72,164a36,36,0,1,1,36-36A36,36,0,0,1,72,164Zm130-12a12,12,0,1,1,12-12A12,12,0,0,1,202,152Zm0-40a12,12,0,1,1,12-12A12,12,0,0,1,202,112ZM156,128a16,16,0,1,0,16,16A16,16,0,0,0,156,128Z' },
  { id: 'radio',           label: 'Radio',            category: 'gear',
    path: 'M232,56h-1.81L154.94,24.45a8,8,0,0,0-7.88,1.4l-78,62.15H32A16,16,0,0,0,16,104V200a16,16,0,0,0,16,16H232a16,16,0,0,0,16-16V72A16,16,0,0,0,232,56ZM152,40.84,224,56H92.55ZM168,176H64a8,8,0,0,1-8-8V120a8,8,0,0,1,8-8H168a8,8,0,0,1,8,8v48A8,8,0,0,1,168,176Zm40-16a16,16,0,1,1,16-16A16,16,0,0,1,208,160Z' },

  // -- Devices --
  { id: 'laptop',          label: 'Laptop',           category: 'devices',
    path: 'M232,168H224V72a16,16,0,0,0-16-16H48A16,16,0,0,0,32,72v96H24a8,8,0,0,0-8,8v8a24,24,0,0,0,24,24H216a24,24,0,0,0,24-24v-8A8,8,0,0,0,232,168ZM48,72H208v96H48Z' },
  { id: 'desktop',         label: 'Desktop',          category: 'devices',
    path: 'M232,40H24A16,16,0,0,0,8,56V184a16,16,0,0,0,16,16H120v16H88a8,8,0,0,0,0,16h80a8,8,0,0,0,0-16H136V200h96a16,16,0,0,0,16-16V56A16,16,0,0,0,232,40Zm0,144H24V56H232V184Z' },
  { id: 'phone',           label: 'Phone',            category: 'devices',
    path: 'M176,16H80A24,24,0,0,0,56,40V216a24,24,0,0,0,24,24h96a24,24,0,0,0,24-24V40A24,24,0,0,0,176,16ZM128,208a12,12,0,1,1,12-12A12,12,0,0,1,128,208Zm56-32H72V64H184Z' },
  { id: 'tablet',          label: 'Tablet',           category: 'devices',
    path: 'M192,16H64A24,24,0,0,0,40,40V216a24,24,0,0,0,24,24H192a24,24,0,0,0,24-24V40A24,24,0,0,0,192,16ZM128,224a12,12,0,1,1,12-12A12,12,0,0,1,128,224Zm72-32H56V40H200Z' },
  { id: 'tv',              label: 'TV',               category: 'devices',
    path: 'M216,40H40A16,16,0,0,0,24,56V176a16,16,0,0,0,16,16H88v16H64a8,8,0,0,0,0,16H192a8,8,0,0,0,0-16H168V192h48a16,16,0,0,0,16-16V56A16,16,0,0,0,216,40Zm0,136H40V56H216v120Z' },

  // -- Wireless / streaming --
  { id: 'broadcast',       label: 'Broadcast',        category: 'wireless',
    path: 'M180,128a52,52,0,1,1-52-52A52.06,52.06,0,0,1,180,128Zm-52-92a91.4,91.4,0,0,0-65.06,26.94,8,8,0,0,0,11.31,11.31,76,76,0,0,1,107.51,0,8,8,0,0,0,11.31-11.31A91.4,91.4,0,0,0,128,36ZM45.66,73.43A8,8,0,1,0,34.34,62.12a132,132,0,0,0,0,131.76,8,8,0,1,0,11.32-11.31,116,116,0,0,1,0-109.14ZM221.66,62.12A8,8,0,0,0,210.34,73.43a116,116,0,0,1,0,109.14,8,8,0,1,0,11.32,11.31,132,132,0,0,0,0-131.76ZM62.94,193.06A91.4,91.4,0,0,0,128,220a91.4,91.4,0,0,0,65.06-26.94,8,8,0,0,0-11.31-11.31,76,76,0,0,1-107.51,0,8,8,0,0,0-11.31,11.31Z' },
  { id: 'wifi',            label: 'Wi-Fi',            category: 'wireless',
    path: 'M236.83,84.85a12,12,0,0,1-3.55,8.49C218.5,108.12,176.46,140,128,140S37.5,108.12,22.72,93.34a12,12,0,0,1,0-17C37.5,61.55,79.54,29.66,128,29.66s90.5,31.89,105.28,46.7A12,12,0,0,1,236.83,84.85ZM128,164a48,48,0,0,0-43.51,27.85a12,12,0,0,0,21.79,10.06A24,24,0,0,1,128,188a24,24,0,0,1,21.72,13.91a12,12,0,1,0,21.79-10.06A48,48,0,0,0,128,164Z' },
  { id: 'bluetooth',       label: 'Bluetooth',        category: 'wireless',
    path: 'M201.12,123.84,170.78,99.59l30.34-24.25A8,8,0,0,0,202.4,63.69l-72-72a8,8,0,0,0-13.4,5.66V97.59L72.61,62.41a8,8,0,0,0-9.5,12.93L102.78,107,63.11,138.66a8,8,0,1,0,9.5,12.93L117,116.41V232a8,8,0,0,0,13.4,5.66l72-72A8,8,0,0,0,201.12,123.84ZM133,38.62l52,52L133,124.73Zm0,165.13V139.27l52,34.11Z' },
  { id: 'cast',            label: 'Cast',             category: 'wireless',
    path: 'M232,56V200a16,16,0,0,1-16,16H156a8,8,0,0,1,0-16h60V56H40V96a8,8,0,0,1-16,0V56A16,16,0,0,1,40,40H216A16,16,0,0,1,232,56ZM34.58,141.3a8,8,0,0,0-1.13,11.27,8,8,0,0,0,11.27,1.13A40,40,0,0,1,72,148a40,40,0,0,1,40,40,8,8,0,0,0,16,0,56,56,0,0,0-56-56A56,56,0,0,0,34.58,141.3ZM34.59,179.27a8,8,0,1,0,11.31,11.31A24,24,0,0,1,72,184a24,24,0,0,1,24,24,8,8,0,0,0,16,0,40,40,0,0,0-40-40A40,40,0,0,0,34.59,179.27ZM48,200a8,8,0,1,0,8,8A8,8,0,0,0,48,200Z' },

  // -- Rooms / contexts --
  { id: 'bedroom',         label: 'Bedroom',          category: 'rooms',
    path: 'M232,96H192V72a16,16,0,0,0-16-16H80A16,16,0,0,0,64,72V96H24a8,8,0,0,0-8,8v88a8,8,0,0,0,16,0V184H224v8a8,8,0,0,0,16,0V104A8,8,0,0,0,232,96Zm-152,0V72H176V96h-8V88a16,16,0,0,0-16-16H104A16,16,0,0,0,88,88v8Z' },
  { id: 'kitchen',         label: 'Kitchen',          category: 'rooms',
    path: 'M192,32H64A16,16,0,0,0,48,48V208a16,16,0,0,0,16,16H192a16,16,0,0,0,16-16V48A16,16,0,0,0,192,32ZM64,48H192V96H64Zm0,160V112H192V208ZM80,80a8,8,0,1,1,8,8A8,8,0,0,1,80,80Zm0,56a8,8,0,1,1,8,8A8,8,0,0,1,80,136Z' },
  { id: 'lounge',          label: 'Lounge',           category: 'rooms',
    path: 'M240,120a16,16,0,0,0-16-16h-8V96a40,40,0,0,0-40-40H80A40,40,0,0,0,40,96v8H32a16,16,0,0,0-16,16v40a16,16,0,0,0,16,16h8v8a8,8,0,0,0,16,0v-8H200v8a8,8,0,0,0,16,0v-8h8a16,16,0,0,0,16-16ZM56,96a24,24,0,0,1,24-24h96a24,24,0,0,1,24,24v8.81a16,16,0,0,0-8,13.86V136H64V118.66a16,16,0,0,0-8-13.85ZM32,160V120h8v40Zm192,0v-40h8v40Z' },
  { id: 'car',             label: 'Car',              category: 'rooms',
    path: 'M240,112H229.2L201.42,49.5A16,16,0,0,0,186.8,40H69.2a16,16,0,0,0-14.62,9.5L26.8,112H16a8,8,0,0,0,0,16h8v80a16,16,0,0,0,16,16H64a16,16,0,0,0,16-16V192h96v16a16,16,0,0,0,16,16h24a16,16,0,0,0,16-16V128h8a8,8,0,0,0,0-16ZM69.2,56H186.8l24.89,56H44.31ZM64,208H40V192H64Zm128,0V192h24v16Zm24-32H40V128H216ZM56,152a8,8,0,0,1,8-8H80a8,8,0,0,1,0,16H64A8,8,0,0,1,56,152Zm112,0a8,8,0,0,1,8-8h16a8,8,0,0,1,0,16H176A8,8,0,0,1,168,152Z' },
  { id: 'headphones',      label: 'Headphones',       category: 'rooms',
    path: 'M201.89,54.66A104.08,104.08,0,0,0,24,128v56a24,24,0,0,0,24,24H64a24,24,0,0,0,24-24V152a24,24,0,0,0-24-24H40.36A88.12,88.12,0,0,1,190.54,66,87.39,87.39,0,0,1,215.65,128H192a24,24,0,0,0-24,24v32a24,24,0,0,0,24,24h16a24,24,0,0,0,24-24V128A103.41,103.41,0,0,0,201.89,54.66ZM64,144a8,8,0,0,1,8,8v32a8,8,0,0,1-8,8H48a8,8,0,0,1-8-8V144Zm152,40a8,8,0,0,1-8,8H192a8,8,0,0,1-8-8V152a8,8,0,0,1,8-8h24Z' },

  // -- Computing platforms --
  { id: 'raspberry-pi',    label: 'Raspberry Pi',     category: 'platforms',
    path: 'M204.13,79.83a48,48,0,0,0-58.36-37.68A47.94,47.94,0,0,0,87.7,69.42a48,48,0,0,0-44.16,82.86a48,48,0,0,0,18.18,75A48,48,0,0,0,128,232a48,48,0,0,0,66.28-4.71,48,48,0,0,0,18.18-75A48,48,0,0,0,204.13,79.83ZM128,200a32,32,0,1,1,32-32A32,32,0,0,1,128,200Z' },
  { id: 'cpu',             label: 'Generic chip',     category: 'platforms',
    path: 'M232,80V64a16,16,0,0,0-16-16H192V40a8,8,0,0,0-16,0V48H160V40a8,8,0,0,0-16,0V48H128V40a8,8,0,0,0-16,0V48H96V40a8,8,0,0,0-16,0V48H64A16,16,0,0,0,48,64V80H40a8,8,0,0,0,0,16h8v16H40a8,8,0,0,0,0,16h8v16H40a8,8,0,0,0,0,16h8v16H40a8,8,0,0,0,0,16h8v16a16,16,0,0,0,16,16H80v8a8,8,0,0,0,16,0v-8h16v8a8,8,0,0,0,16,0v-8h16v8a8,8,0,0,0,16,0v-8h16v8a8,8,0,0,0,16,0v-8h24a16,16,0,0,0,16-16V176h8a8,8,0,0,0,0-16h-8V144h8a8,8,0,0,0,0-16h-8V112h8a8,8,0,0,0,0-16h-8V80h8a8,8,0,0,0,0-16h-8Zm-16,128H64V64H216ZM112,144a16,16,0,1,1,16-16A16,16,0,0,1,112,144Zm32,32a16,16,0,1,1,16-16A16,16,0,0,1,144,176Z' },
  { id: 'apple',           label: 'Apple',            category: 'platforms',
    path: 'M223.84,178.42a87.43,87.43,0,0,1-15.27,28.81C198.49,221.27,189.51,232,172.31,232c-15.61,0-22.6-9.45-44-9.45-21.74,0-29.49,9.45-44.12,9.45-17.21,0-29.92-12.91-39.81-26.42C18.78,167.61,7.51,98.65,42.39,67.83A57.83,57.83,0,0,1,84.91,56C100,56,112.66,64.24,128,64.24,142.59,64.24,152.45,56,176.31,56c8.6,0,28.31,1.36,42.7,15.94C168.76,113.5,179,167.06,223.84,178.42ZM168.81,12c-13.32.85-29,8.51-37.89,18.79-8.79,10.16-15.85,25.31-13.34,40.59,14.36,1.61,28.92-7,37.81-17.61C164.42,43.66,170.39,28.71,168.81,12Z' },

  // -- Generic --
  { id: 'music-note',      label: 'Music',            category: 'generic',
    path: 'M212.92,17.6a8,8,0,0,0-6.86-1.45l-128,32A8,8,0,0,0,72,56V172.1A36,36,0,1,0,88,202V102.24l112-28v76A36,36,0,1,0,216,180V24A8,8,0,0,0,212.92,17.6ZM52,222a20,20,0,1,1,20-20A20,20,0,0,1,52,222ZM180,200a20,20,0,1,1,20-20A20,20,0,0,1,180,200Z' },
  { id: 'unknown',         label: 'Generic device',   category: 'generic',
    path: 'M128,24a96,96,0,1,0,96,96A96.11,96.11,0,0,0,128,24Zm0,176a80,80,0,1,1,80-80A80.09,80.09,0,0,1,128,200Zm12-60v4a8,8,0,0,1-16,0v-8a8,8,0,0,1,8-8c13.23,0,24-9,24-20s-10.77-20-24-20-24,9-24,20v4a8,8,0,0,1-16,0v-4c0-19.85,17.94-36,40-36s40,16.15,40,36C172,138.36,160.6,153.4,140,158ZM136,180a12,12,0,1,1-12-12A12,12,0,0,1,136,180Z' },
]

// Categories with display labels for the picker tabs
export const CATEGORIES = [
  { id: 'speakers',  label: 'Speakers' },
  { id: 'gear',      label: 'Audio gear' },
  { id: 'wireless',  label: 'Wireless' },
  { id: 'devices',   label: 'Devices' },
  { id: 'rooms',     label: 'Rooms' },
  { id: 'platforms', label: 'Platforms' },
  { id: 'generic',   label: 'Generic' },
]

// Map a renderer's protocol/manufacturer/model to a sensible default
// icon id when the user hasn't picked one explicitly. Conservative:
// most renderers fall through to the generic 'speaker' icon. We
// special-case Squeezelite (broadcast-style ring), and detect a few
// brands by matching their typical UPnP strings.
export function defaultIconFor(renderer) {
  if (!renderer) return 'speaker'
  const proto = renderer.protocol || ''
  const mfr = (renderer.manufacturer || '').toLowerCase()
  const model = (renderer.model || '').toLowerCase()
  if (proto === 'squeezelite') return 'broadcast'
  if (proto === 'sonos') return 'speakers'
  // WiiM devices typically report manufacturer="LinkPlay Technology"
  // with the brand name in modelName -- detect that combination.
  if (mfr.includes('linkplay') || model.includes('wiim')) return 'speaker-wifi'
  if (model.includes('soundbar')) return 'soundbar'
  if (model.includes('receiver') || model.includes('amplifier')) return 'av-receiver'
  if (model.includes('headphone')) return 'headphones'
  // Default: generic speaker
  return 'speaker'
}

// Look up an icon by id, returning the SVG path string or null. Null
// is the signal for callers to render whatever fallback they like
// (typically the default for that renderer's protocol).
export function getIconPath(id) {
  const found = ICONS.find(i => i.id === id)
  return found ? found.path : null
}

// Render a renderer's icon. The component picks the right icon based
// on the saved icon_id, falling back to the protocol-based default
// if the saved id isn't in the current icon set.
//
// Props:
//   renderer  -- the renderer object (uses .icon_id and .protocol/.manufacturer/.model)
//   size      -- pixel size (square)
//   color     -- override colour, defaults to currentColor
export default function RendererIcon({ renderer, size = 18, color }) {
  const savedId = renderer?.icon_id
  // Try the saved id first; if it's not in the current set (icon was
  // removed in a later release, or the saved id is malformed), fall
  // back to the protocol default.
  const id = (savedId && getIconPath(savedId)) ? savedId : defaultIconFor(renderer)
  const path = getIconPath(id)
  if (!path) return null

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 256 256"
      fill={color || 'currentColor'}
      xmlns="http://www.w3.org/2000/svg"
      style={{ flexShrink: 0 }}
      aria-hidden="true"
    >
      <path d={path} />
    </svg>
  )
}
