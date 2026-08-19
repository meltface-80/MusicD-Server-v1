// The queue screen's row folding and its one piece of index arithmetic.
//
// Pure functions in their own module rather than inside the component, for the
// same reason scrollRestore.js is: they are the parts worth testing, and a
// .jsx file cannot be imported by the node:test suite.

// Fold each run of consecutive skipped tracks behind the playhead into one
// row, leaving everything else alone.
//
// Runs rather than one row for the whole queue: a queue view whose rows are
// out of queue order is worse than a few extra rows, and skips normally arrive
// in runs anyway. A run of one still folds — a lone skipped track rendered
// like a played one would be indistinguishable, which is the thing being
// fixed.
//
// Nothing at or beyond the playhead ever folds: those tracks have not been
// reached. Selection mode never folds either, because every row has to stay
// individually tickable.
//
export function foldSkippedRuns(queue, queueIndex, skippedSet, isSelecting = false) {
  const out = []
  let i = 0
  while (i < queue.length) {
    const foldable = !isSelecting && i < queueIndex && skippedSet.has(queue[i] && queue[i].id)
    if (foldable) {
      const start = i
      const items = []
      while (i < queueIndex && skippedSet.has(queue[i] && queue[i].id)) { items.push(i); i++ }
      out.push({ kind: 'skips', start, items })
    } else {
      out.push({ kind: 'track', index: i })
      i++
    }
  }
  return out
}

// Where a track behind the playhead has to land for "Play next" to put it
// directly after the current track.
//
// reorderQueue splices the track out and back in, so the current track slides
// down one on the way past. Inserting AT queueIndex therefore lands the moved
// track immediately after it, not before — the off-by-one that would otherwise
// interrupt playback with the track the user asked to hear next.
export function playNextTarget(queueIndex) {
  return queueIndex
}
