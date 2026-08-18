const BASE = '/api'

// Read an error response body and turn it into a useful Error.
// Server endpoints typically return JSON like { "error": "Foo went wrong" }.
// Earlier versions of this file just rethrew the raw response text — which
// meant callers ended up showing the literal `{"error":"..."}` string in
// the UI. Now we try to parse the JSON and pull out the `error` field;
// if that fails (HTML error page, plain text, empty body), we fall back
// to the raw text or the HTTP status.
async function failure(r) {
  let txt = ''
  try { txt = await r.text() } catch {}
  if (txt) {
    try {
      const j = JSON.parse(txt)
      if (j && typeof j === 'object' && j.error) return new Error(String(j.error))
    } catch { /* not JSON — fall through */ }
    return new Error(txt)
  }
  return new Error(`HTTP ${r.status}`)
}

async function get(path) {
  const r = await fetch(BASE + path)
  if (!r.ok) throw await failure(r)
  return r.json()
}

async function post(path, body) {
  const r = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
  if (!r.ok) throw await failure(r)
  return r.json()
}

async function put(path, body) {
  const r = await fetch(BASE + path, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
  if (!r.ok) throw await failure(r)
  return r.json()
}

// v1.1.0.92 — del() now accepts an optional body, since some
// endpoints (DELETE /library/focus/saved with a list of ids)
// need to pass payload in. Plain DELETE without body still works
// — the body arg is optional and only triggers Content-Type +
// JSON.stringify when present.
async function del(path, body) {
  const opts = { method: 'DELETE' }
  if (body !== undefined) {
    opts.headers = { 'Content-Type': 'application/json' }
    opts.body = JSON.stringify(body)
  }
  const r = await fetch(BASE + path, opts)
  if (!r.ok) throw await failure(r)
  return r.json()
}

async function patch(path, body) {
  const r = await fetch(BASE + path, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
  if (!r.ok) throw await failure(r)
  return r.json()
}

export const api = { get, post, put, patch, del }
