// src/serviceLog.js — prefixed console logger for the streaming clients.
//
// v1.1.33.0. The Qobuz and Tidal clients were ported from
// MusicD-Server-Bridge, which has a levelled logger module this repo
// does not. Rather than strip the ~40 log calls out of otherwise
// well-exercised network code — every one of which earns its keep the
// first time a token expires in the field — this gives them the same
// `log.debug / info / warn / error` shape over plain console.
//
// debug is off unless MUSICD_DEBUG is set. The Qobuz client debug-logs
// every request URL; those lines carry the app id, the auth token and
// (on the login call) the account password in the query string. The
// client redacts all three before handing the string over, but keeping
// the level off by default means a journal from a normal run has no
// occasion to contain them at all.
'use strict';

function forModule(name) {
  const prefix = `[${name}]`;
  return {
    debug: (msg) => { if (process.env.MUSICD_DEBUG) console.log(`${prefix} ${msg}`); },
    info:  (msg) => console.log(`${prefix} ${msg}`),
    warn:  (msg) => console.warn(`${prefix} ${msg}`),
    error: (msg) => console.error(`${prefix} ${msg}`),
  };
}

module.exports = { forModule };
