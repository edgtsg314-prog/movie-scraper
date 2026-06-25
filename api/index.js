'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const REFERER = 'https://vidlink.pro/';
const ORIGIN  = 'https://vidlink.pro';
const UA      = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124';

// ── WASM singleton (survives warm invocations) ────────────────────────────────
let wasmReady = false;
let bootPromise = null;

function bootWasm() {
  if (bootPromise) return bootPromise;
  bootPromise = (async () => {
    globalThis.window = globalThis;
    globalThis.self = globalThis;
    globalThis.document = { createElement: () => ({}), body: { appendChild: () => {} } };

    const sodium = require('libsodium-wrappers');
    await sodium.ready;
    globalThis.sodium = sodium;

    eval(fs.readFileSync(path.join(__dirname, 'script.js'), 'utf8'));

    const go = new Dm();
    const wasmBuf = fs.readFileSync(path.join(__dirname, 'fu.wasm'));
    const { instance } = await WebAssembly.instantiate(wasmBuf, go.importObject);
    go.run(instance);

    await new Promise(r => setTimeout(r, 500));
    if (typeof globalThis.getAdv !== 'function') throw new Error('getAdv not found after WASM boot');
    wasmReady = true;
  })();
  return bootPromise;
}

// ── Stream URL resolver ───────────────────────────────────────────────────────

function normalizeTrack(t, i = 0) {
  if (!t || typeof t !== 'object') return null;
  const file = t.file || t.url || t.src || t.link;
  if (!file) return null;
  const label = t.label || t.lang || t.language || t.name || `Subtitle ${i + 1}`;
  const lower = String(label).toLowerCase();
  const lang = t.srclang || t.lang || t.language || (lower.includes('arab') || lower.includes('عرب') || lower === 'ar' ? 'ar' : '');
  return {
    file,
    label: String(label),
    kind: 'captions',
    default: lower.includes('arab') || lower.includes('عرب') || lower === 'ar' || String(lang).toLowerCase().startsWith('ar'),
    srclang: lang || undefined
  };
}

function extractSubtitleTracks(data) {
  const buckets = [];
  const push = (v) => { if (Array.isArray(v)) buckets.push(...v); };
  push(data?.subtitles);
  push(data?.captions);
  push(data?.tracks);
  push(data?.stream?.subtitles);
  push(data?.stream?.captions);
  push(data?.stream?.tracks);
  push(data?.media?.subtitles);
  const tracks = buckets.map(normalizeTrack).filter(Boolean);
  tracks.sort((a, b) => Number(Boolean(b.default)) - Number(Boolean(a.default)));
  if (tracks[0]) tracks[0].default = true;
  return tracks;
}

async function getStream(id, season, episode) {
  await bootWasm();
  const token = globalThis.getAdv(String(id));
  if (!token) throw new Error('getAdv returned null');

  const apiUrl = season
    ? `https://vidlink.pro/api/b/tv/${token}/${season}/${episode || 1}?multiLang=1`
    : `https://vidlink.pro/api/b/movie/${token}?multiLang=1`;

  const res = await fetch(apiUrl, {
    headers: { Referer: REFERER, Origin: ORIGIN, 'User-Agent': UA }
  });
  if (!res.ok) throw new Error(`vidlink API returned ${res.status}`);
  const data = await res.json();
  const playlist = data?.stream?.playlist;
  if (!playlist) throw new Error('No playlist in response');
  return { url: playlist, tracks: extractSubtitleTracks(data), rawType: data?.stream?.type || '' };
}


// ── HLS upstream fetcher with redirect support ────────────────────────────────
function fetchUpstream(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('too many redirects'));
    (url.startsWith('https') ? https : http).get(url, {
      headers: { Referer: REFERER, Origin: ORIGIN, 'User-Agent': UA, Accept: '*/*' }
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const loc = res.headers.location;
        return resolve(fetchUpstream(loc.startsWith('http') ? loc : new URL(loc, url).href, redirects + 1));
      }
      resolve(res);
    }).on('error', reject);
  });
}

function rewriteM3u8(body, url) {
  const base = url.split('?')[0];
  const baseDir = base.substring(0, base.lastIndexOf('/') + 1);
  const origin = new URL(url).origin;
  return body.split('\n').map(line => {
    const t = line.trim();
    if (!t || t.startsWith('#')) return line;
    const abs = t.startsWith('http') ? t : t.startsWith('/') ? origin + t : baseDir + t;
    return '/api?url=' + encodeURIComponent(abs);
  }).join('\n');
}

// ── Vercel serverless handler ─────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const { searchParams } = new URL(req.url, 'http://localhost');
  const q = Object.fromEntries(searchParams);

  // Proxy mode: /api?url=...
  if (q.url) {
    const url = decodeURIComponent(q.url);
    try {
      const upstream = await fetchUpstream(url);
      const ct = (upstream.headers['content-type'] || '').toLowerCase();
      const isM3u8 = ct.includes('mpegurl') || ct.includes('m3u8') || /\.m3u8?(\?|$)/i.test(url.split('?')[0]);

      if (isM3u8) {
        const chunks = [];
        for await (const chunk of upstream) chunks.push(chunk);
        const body = Buffer.concat(chunks).toString('utf8');
        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        return res.end(rewriteM3u8(body, url));
      } else {
        res.setHeader('Content-Type', ct || 'application/octet-stream');
        if (upstream.headers['content-length']) res.setHeader('Content-Length', upstream.headers['content-length']);
        res.statusCode = upstream.statusCode;
        upstream.pipe(res);
      }
    } catch (err) {
      res.statusCode = 502;
      res.end(err.message);
    }
    return;
  }

  // Stream lookup: /api?id=550  or  /api?id=456&s=1&e=2
  if (!q.id) {
    res.statusCode = 400;
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ error: 'missing id' }));
  }

  res.setHeader('Content-Type', 'application/json');
  try {
    const url = await getStream(q.id, q.s, q.e);
    res.end(JSON.stringify({ url }));
  } catch (err) {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: err.message }));
  }
};
