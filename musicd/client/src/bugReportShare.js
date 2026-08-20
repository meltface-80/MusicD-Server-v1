// Why the bug-report share sheet does or does not offer a file attachment.
//
// The report screen said "Your browser doesn't support sharing files
// directly" and told the user to go and find the JSON on the server. Both
// halves were wrong. Safari on iOS supports sharing files perfectly well; what
// it will not do is expose the API on an insecure origin.
//
// MusicD is served over plain HTTP on a LAN address (http://192.168.x.x:32700),
// which is not a secure context, so the browser withholds:
//
//   navigator.share / navigator.canShare   → the file-attachment path
//   navigator.clipboard                    → "Copy as text"
//
// That is the whole explanation for both failures on that screen, including
// the "undefined is not an object (evaluating 'navigator.clipboard.writeText')"
// the copy button threw. Neither is a browser limitation and neither is fixed
// by changing browsers.
//
// So: say which of the two it actually is, and give the insecure-origin case a
// real way to get the file onto the device instead of a filename to go
// hunting for.

export const SHARE_FILES = 'files'            // the good path: attach directly
export const SHARE_INSECURE = 'insecure-origin' // API withheld, origin's fault
export const SHARE_UNSUPPORTED = 'unsupported'  // secure, but genuinely absent

// `nav` and `secure` are injected so this can be tested without a browser.
// `makeProbe` builds the throwaway File used to ask whether files are
// shareable at all; some browsers expose share() but refuse every file.
export function classifyShare(nav, secure, makeProbe) {
  if (!nav || typeof nav.share !== 'function' || typeof nav.canShare !== 'function') {
    // The APIs are secure-context-gated, so on an insecure origin their
    // absence says nothing about the browser.
    return secure ? SHARE_UNSUPPORTED : SHARE_INSECURE
  }
  try {
    // v1.1.0.84: probe with text/plain, not application/json — iOS Safari has
    // approved canShare for JSON at probe time and then thrown at share time.
    const probe = makeProbe ? makeProbe() : new File(['probe'], 'probe.txt', { type: 'text/plain' })
    if (nav.canShare({ files: [probe] })) return SHARE_FILES
  } catch {
    /* fall through — treat a throwing probe as "no file support" */
  }
  return secure ? SHARE_UNSUPPORTED : SHARE_INSECURE
}

// navigator.clipboard is secure-context-gated too, so the copy button needs
// the old execCommand path on exactly the origins that need it most.
export function hasAsyncClipboard(nav) {
  return !!(nav && nav.clipboard && typeof nav.clipboard.writeText === 'function')
}

// The server already saves every report and already serves it back with
// Content-Disposition: attachment (GET /api/bug-report/file/:name, res.download).
// Pointing the browser at it is all that is needed to get the real .json onto
// the phone, where the mail app's attachment picker can reach it.
//
// The server's own guard is /^[\w\-:.]+\.json$/, so anything that would be
// rejected there is rejected here rather than sent as a URL that 400s.
const SAFE_REPORT_NAME = /^[\w\-:.]+\.json$/

export function reportDownloadUrl(filename) {
  if (!filename || !SAFE_REPORT_NAME.test(filename)) return null
  return `/api/bug-report/file/${encodeURIComponent(filename)}`
}
