// Scroll-position restore for the shared screen scroller.
//
// App.jsx keeps ONE scroll container for every screen and remembers a
// scrollTop per screen. Putting that number back is not a single assignment.
// When a screen remounts its content arrives asynchronously — one or more
// fetches, then a sticky header that grows as chips and pills load — so at
// the moment of the assignment the container is usually far shorter than the
// saved offset. `el.scrollTop = 4200` on a 900px-tall container silently
// clamps to the maximum, and the number is gone.
//
// That was the library-screen bug. A blind `setTimeout(…, 50)` fired long
// before the album list came back from the server, clamped to ~0, and —
// because a clamp dispatches a scroll event like any other movement — the
// container's own scroll handler wrote that 0 back over the saved position.
// The saved number was right; there was nothing to scroll to yet, and the
// failed attempt destroyed the memory instead of just missing.
//
// So: re-apply on every frame until the assignment sticks, give up after a
// deadline, and stop the moment the user scrolls. The caller keeps the
// returned handle so its scroll handler can tell our own clamped
// assignments apart from the user actually moving the list.

// Long enough for a LAN fetch plus a render and a header that settles;
// short enough that nothing keeps running into the next interaction.
export const SCROLL_RESTORE_DEADLINE_MS = 1500

// Start restoring `target` on `el`. Returns a handle:
//   { target, settled, cancel() }
// `settled` flips to true when the target lands, the deadline passes, the
// user scrolls, or cancel() is called. The first attempt happens
// synchronously, so calling this from a layout effect gets an assignment in
// before the browser can dispatch a scroll event for the commit.
//
// `raf` / `cancelRaf` / `now` are injectable so the loop can be driven by a
// test without a browser.
export function restoreScrollTop(el, target, options = {}) {
  const {
    deadlineMs = SCROLL_RESTORE_DEADLINE_MS,
    raf = (cb) => requestAnimationFrame(cb),
    cancelRaf = (id) => cancelAnimationFrame(id),
    now = () => Date.now(),
  } = options

  const handle = {
    target,
    settled: false,
    // What the browser actually took from our last assignment. Anything
    // else showing up on the element is the user, not us.
    applied: null,
    frame: 0,
    attempts: 0,
    cancel: () => {},
  }

  const stop = () => {
    if (handle.frame) {
      cancelRaf(handle.frame)
      handle.frame = 0
    }
    handle.settled = true
  }
  handle.cancel = stop

  const expiry = now() + deadlineMs

  const step = () => {
    handle.frame = 0
    if (handle.settled) return
    if (!el) { stop(); return }
    if (handle.applied !== null && el.scrollTop !== handle.applied) {
      // The element moved without us asking. Never fight the user.
      stop()
      return
    }
    if (el.scrollTop !== target) {
      handle.attempts++
      el.scrollTop = target
      handle.applied = el.scrollTop   // whatever the clamp left us with
    }
    if (el.scrollTop === target || now() >= expiry) {
      stop()
      return
    }
    handle.frame = raf(step)
  }

  step()
  return handle
}
