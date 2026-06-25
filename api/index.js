'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const REFERER = 'https://vidlink.pro/';
const ORIGIN  = 'https://vidlink.pro';
const UA      = process.env.APP_USER_AGENT || 'IPTVExpert/1.0 (+https://localhost)';
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124';

const TMDB_KEY = process.env.TMDB_API_KEY || process.env.TMDB_KEY || '3a73619bbb8fc6d47742d1b5b2b707b5';
const OS_API_KEY = process.env.OPENSUBTITLES_API_KEY || 'W8SxuyZGOok0S2YIF2ZV4PBBYoVUJDTf';
const OS_USERNAME = process.env.OPENSUBTITLES_USERNAME || 'adwameshari';
const OS_PASSWORD = process.env.OPENSUBTITLES_PASSWORD || 'MESHARI';
const OS_USER_AGENT = process.env.OPENSUBTITLES_USER_AGENT || 'IPTVExpert v1.0';

let osToken = null;
let osTokenAt = 0;

// ── WASM singleton (survives warm invocations) ────────────────────────────────
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
  })();
  return bootPromise;
}

// ── Stream URL resolver ───────────────────────────────────────────────────────
async function getStream(id, season, episode) {
  await bootWasm();
  const token = globalThis.getAdv(String(id));
  if (!token) throw new Error('getAdv returned null');

  const apiUrl = season
    ? `https://vidlink.pro/api/b/tv/${token}/${season}/${episode || 1}?multiLang=0`
    : `https://vidlink.pro/api/b/movie/${token}?multiLang=0`;

  const res = await fetch(apiUrl, {
    headers: { Referer: REFERER, Origin: ORIGIN, 'User-Agent': BROWSER_UA }
  });
  if (!res.ok) throw new Error(`vidlink API returned ${res.status}`);
  const data = await res.json();
  const playlist = data?.stream?.playlist;
  if (!playlist) throw new Error('No playlist in response');
  return playlist;
}

// ── HLS upstream fetcher with redirect support ────────────────────────────────
function fetchUpstream(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('too many redirects'));
    (url.startsWith('https') ? https : http).get(url, {
      headers: { Referer: REFERER, Origin: ORIGIN, 'User-Agent': BROWSER_UA, Accept: '*/*' }
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

// ── OpenSubtitles Arabic subtitles: no filesystem writes; works on Vercel ─────
function srtTimeToVtt(t) {
  return String(t || '').trim().replace(',', '.');
}

function srtToVtt(srt) {
  let body = String(srt || '').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  body = body.replace(/(\d{2}:\d{2}:\d{2}),([0-9]{3})/g, '$1.$2');
  // remove numeric cue counters when they are alone on a line
  body = body.replace(/^\d+\n(?=\d{2}:\d{2}:\d{2}\.\d{3}\s+-->)/gm, '');
  if (!body.trim().startsWith('WEBVTT')) body = 'WEBVTT\n\n' + body.trim() + '\n';
  return body;
}

async function tmdbJson(endpoint) {
  const sep = endpoint.includes('?') ? '&' : '?';
  const url = `https://api.themoviedb.org/3${endpoint}${sep}api_key=${encodeURIComponent(TMDB_KEY)}`;
  const r = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!r.ok) throw new Error(`TMDB ${r.status}`);
  return r.json();
}

async function getImdbId(tmdbId, season, episode) {
  if (season) {
    // best match: external id for the exact episode
    try {
      const ep = await tmdbJson(`/tv/${tmdbId}/season/${season}/episode/${episode || 1}/external_ids`);
      if (ep?.imdb_id) return { imdbId: ep.imdb_id, mediaKind: 'episode' };
    } catch (_) {}
    // fallback: show imdb id + season/episode search
    const show = await tmdbJson(`/tv/${tmdbId}/external_ids`);
    return { imdbId: show?.imdb_id || null, mediaKind: 'tv' };
  }
  const movie = await tmdbJson(`/movie/${tmdbId}/external_ids`);
  return { imdbId: movie?.imdb_id || null, mediaKind: 'movie' };
}

async function osLogin() {
  if (osToken && Date.now() - osTokenAt < 1000 * 60 * 60 * 20) return osToken;
  if (!OS_API_KEY || !OS_USERNAME || !OS_PASSWORD) throw new Error('OpenSubtitles credentials missing');
  const r = await fetch('https://api.opensubtitles.com/api/v1/login', {
    method: 'POST',
    headers: {
      'Api-Key': OS_API_KEY,
      'User-Agent': OS_USER_AGENT,
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    },
    body: JSON.stringify({ username: OS_USERNAME, password: OS_PASSWORD })
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`OpenSubtitles login ${r.status}: ${text.slice(0, 160)}`);
  const data = JSON.parse(text);
  if (!data.token) throw new Error('OpenSubtitles token missing');
  osToken = data.token;
  osTokenAt = Date.now();
  return osToken;
}

function cleanImdb(imdbId) {
  return String(imdbId || '').replace(/^tt/i, '');
}

async function osSearchArabic({ imdbId, season, episode }) {
  const token = await osLogin();
  const qs = new URLSearchParams({ languages: 'ar', order_by: 'download_count', order_direction: 'desc' });
  if (imdbId) qs.set('imdb_id', cleanImdb(imdbId));
  if (season) qs.set('season_number', String(season));
  if (episode) qs.set('episode_number', String(episode));
  const url = `https://api.opensubtitles.com/api/v1/subtitles?${qs.toString()}`;
  const r = await fetch(url, {
    headers: {
      'Api-Key': OS_API_KEY,
      'Authorization': `Bearer ${token}`,
      'User-Agent': OS_USER_AGENT,
      'Accept': 'application/json'
    }
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`OpenSubtitles search ${r.status}: ${text.slice(0, 160)}`);
  const data = JSON.parse(text);
  return data?.data || [];
}

function pickBestArabic(results) {
  const items = (results || []).filter(x => {
    const a = x.attributes || {};
    return String(a.language || '').toLowerCase() === 'ar' || /arabic|arab/i.test(String(a.language || '') + ' ' + String(a.release || ''));
  });
  return items.sort((a, b) => {
    const aa = a.attributes || {}, bb = b.attributes || {};
    const ai = (aa.ratings || 0) + (aa.download_count || 0) / 1000 + (aa.from_trusted ? 10 : 0);
    const bi = (bb.ratings || 0) + (bb.download_count || 0) / 1000 + (bb.from_trusted ? 10 : 0);
    return bi - ai;
  })[0];
}

async function osDownloadVtt(fileId) {
  const token = await osLogin();
  const r = await fetch('https://api.opensubtitles.com/api/v1/download', {
    method: 'POST',
    headers: {
      'Api-Key': OS_API_KEY,
      'Authorization': `Bearer ${token}`,
      'User-Agent': OS_USER_AGENT,
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    },
    body: JSON.stringify({ file_id: fileId })
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`OpenSubtitles download ${r.status}: ${text.slice(0, 160)}`);
  const data = JSON.parse(text);
  const link = data?.link;
  if (!link) throw new Error('OpenSubtitles download link missing');
  const sub = await fetch(link, { headers: { 'User-Agent': OS_USER_AGENT } });
  if (!sub.ok) throw new Error(`subtitle file ${sub.status}`);
  const subtitleText = await sub.text();
  return srtToVtt(subtitleText);
}

async function getArabicSubtitleVtt(tmdbId, season, episode) {
  const { imdbId } = await getImdbId(tmdbId, season, episode);
  if (!imdbId) throw new Error('IMDb ID not found from TMDB');
  let results = await osSearchArabic({ imdbId, season, episode });
  let best = pickBestArabic(results);
  // If exact episode ID was used and no result, fallback to show imdb id + S/E already covered by getImdb fallback only when ep id missing.
  if (!best) throw new Error('No Arabic subtitle found');
  const file = best.attributes?.files?.[0];
  if (!file?.file_id) throw new Error('Arabic subtitle has no downloadable file_id');
  return osDownloadVtt(file.file_id);
}

// ── Vercel serverless handler ─────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.end('ok');

  const { searchParams } = new URL(req.url, 'http://localhost');
  const q = Object.fromEntries(searchParams);

  // Arabic subtitle VTT: /api?subtitle=1&id=238 OR /api?subtitle=1&id=94997&s=1&e=1
  if (q.subtitle) {
    if (!q.id) {
      res.statusCode = 400;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      return res.end(JSON.stringify({ ok: false, error: 'missing id' }));
    }
    try {
      const vtt = await getArabicSubtitleVtt(q.id, q.s, q.e || '1');
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
      res.setHeader('Cache-Control', 'public, max-age=86400, s-maxage=604800');
      return res.end(vtt);
    } catch (err) {
      res.statusCode = 404;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      return res.end(JSON.stringify({ ok: false, error: err.message }));
    }
  }

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
