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


// ── OpenSubtitles Arabic subtitles ────────────────────────────────────────────
const TMDB_API_KEY = process.env.TMDB_API_KEY || '3a73619bbb8fc6d47742d1b5b2b707b5';
const OS_API_KEY = process.env.OPENSUBTITLES_API_KEY || 'W8SxuyZGOok0S2YIF2ZV4PBBYoVUJDTf';
const OS_USERNAME = process.env.OPENSUBTITLES_USERNAME || 'adwameshari';
const OS_PASSWORD = process.env.OPENSUBTITLES_PASSWORD || 'MESHARI';
const OS_USER_AGENT = process.env.OPENSUBTITLES_USER_AGENT || 'IPTVExpert v1.0';
const SUB_LANG = 'ar';
const SUB_DIR = path.join(__dirname, '..', 'subtitles');

let osToken = '';
let osTokenAt = 0;

function ensureDirSync(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function srtToVtt(srt) {
  let txt = String(srt || '').replace(/^\uFEFF/, '').replace(/\r+/g, '');
  txt = txt.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
  if (!txt.trim().startsWith('WEBVTT')) txt = 'WEBVTT\n\n' + txt;
  return txt;
}

async function fetchJson(url, options = {}) {
  const r = await fetch(url, options);
  const body = await r.text();
  let data = {};
  try { data = body ? JSON.parse(body) : {}; } catch (_) { data = { raw: body }; }
  if (!r.ok) throw new Error((data && (data.message || data.error)) || ('HTTP ' + r.status));
  return data;
}

async function osLogin() {
  if (osToken && (Date.now() - osTokenAt) < 20 * 60 * 1000) return osToken;
  if (!OS_API_KEY || !OS_USERNAME || !OS_PASSWORD) throw new Error('OpenSubtitles credentials missing');
  const data = await fetchJson('https://api.opensubtitles.com/api/v1/login', {
    method: 'POST',
    headers: {
      'Api-Key': OS_API_KEY,
      'User-Agent': OS_USER_AGENT,
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    },
    body: JSON.stringify({ username: OS_USERNAME, password: OS_PASSWORD })
  });
  osToken = data.token || '';
  osTokenAt = Date.now();
  if (!osToken) throw new Error('OpenSubtitles login did not return token');
  return osToken;
}

async function getTmdbExternalId(id, season, episode) {
  if (!TMDB_API_KEY) return '';
  // للأفلام: IMDb ID للفيلم.
  // للحلقات: نحاول أولاً IMDb ID للحلقة نفسها لأنه أدق مع OpenSubtitles، ثم نرجع لمسلسل الأب كاحتياط.
  if (season) {
    try {
      const epUrl = `https://api.themoviedb.org/3/tv/${encodeURIComponent(id)}/season/${encodeURIComponent(season)}/episode/${encodeURIComponent(episode || 1)}/external_ids?api_key=${TMDB_API_KEY}`;
      const epData = await fetchJson(epUrl, { headers: { 'Accept': 'application/json' } });
      if (epData.imdb_id) return epData.imdb_id;
    } catch (_) {}
    try {
      const tvUrl = `https://api.themoviedb.org/3/tv/${encodeURIComponent(id)}/external_ids?api_key=${TMDB_API_KEY}`;
      const tvData = await fetchJson(tvUrl, { headers: { 'Accept': 'application/json' } });
      return tvData.imdb_id || '';
    } catch (_) { return ''; }
  }
  const url = `https://api.themoviedb.org/3/movie/${encodeURIComponent(id)}/external_ids?api_key=${TMDB_API_KEY}`;
  const data = await fetchJson(url, { headers: { 'Accept': 'application/json' } });
  return data.imdb_id || '';
}

function subtitleLocalPath(id, season, episode) {
  if (season) return path.join(SUB_DIR, 'tv', String(id), String(season), `${episode || 1}.vtt`);
  return path.join(SUB_DIR, 'movie', String(id), 'ar.vtt');
}

function subtitlePublicUrl(id, season, episode) {
  if (season) return `/subtitles/tv/${encodeURIComponent(id)}/${encodeURIComponent(season)}/${encodeURIComponent(episode || 1)}.vtt`;
  return `/subtitles/movie/${encodeURIComponent(id)}/ar.vtt`;
}

function chooseBestArabicSubtitle(items) {
  const list = Array.isArray(items) ? items : [];
  return list
    .filter(x => x && x.attributes)
    .sort((a, b) => {
      const A = a.attributes || {}, B = b.attributes || {};
      const ad = Number(A.download_count || 0), bd = Number(B.download_count || 0);
      const ar = Number(A.ratings || 0), br = Number(B.ratings || 0);
      return (br * 1000 + bd) - (ar * 1000 + ad);
    })[0] || null;
}

async function downloadOpenSubtitlesFile(fileId) {
  const token = await osLogin();
  const data = await fetchJson('https://api.opensubtitles.com/api/v1/download', {
    method: 'POST',
    headers: {
      'Api-Key': OS_API_KEY,
      'Authorization': 'Bearer ' + token,
      'User-Agent': OS_USER_AGENT,
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    },
    body: JSON.stringify({ file_id: fileId, sub_format: 'srt' })
  });
  if (!data.link) throw new Error('OpenSubtitles did not return download link');
  const r = await fetch(data.link, { headers: { 'User-Agent': OS_USER_AGENT } });
  if (!r.ok) throw new Error('Subtitle download failed: ' + r.status);
  return await r.text();
}

async function findArabicSubtitle(id, season, episode) {
  const imdb = await getTmdbExternalId(id, season, episode);
  const qs = new URLSearchParams({ languages: SUB_LANG });
  if (imdb) qs.set('imdb_id', String(imdb).replace(/^tt/i, ''));
  else qs.set('tmdb_id', String(id));
  if (season) {
    qs.set('season_number', String(season));
    qs.set('episode_number', String(episode || 1));
    qs.set('type', 'episode');
  } else {
    qs.set('type', 'movie');
  }
  const url = 'https://api.opensubtitles.com/api/v1/subtitles?' + qs.toString();
  const data = await fetchJson(url, {
    headers: {
      'Api-Key': OS_API_KEY,
      'User-Agent': OS_USER_AGENT,
      'Accept': 'application/json'
    }
  });
  const best = chooseBestArabicSubtitle(data.data);
  if (!best) return null;
  const files = best.attributes && best.attributes.files;
  const fileId = files && files[0] && files[0].file_id;
  if (!fileId) return null;
  const srt = await downloadOpenSubtitlesFile(fileId);
  return srtToVtt(srt);
}

async function getArabicSubtitle(id, season, episode, force = false) {
  const local = subtitleLocalPath(id, season, episode);
  const publicUrl = subtitlePublicUrl(id, season, episode);
  if (!force && fs.existsSync(local) && fs.statSync(local).size > 20) {
    return { ok: true, cached: true, url: publicUrl, label: 'العربية', srclang: 'ar' };
  }
  ensureDirSync(path.dirname(local));
  const vtt = await findArabicSubtitle(id, season, episode);
  if (!vtt) return { ok: false, error: 'لا توجد ترجمة عربية متوفرة لهذا المحتوى' };
  fs.writeFileSync(local, vtt, 'utf8');
  return { ok: true, cached: false, url: publicUrl, label: 'العربية', srclang: 'ar' };
}

// ── Vercel serverless handler ─────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const { searchParams } = new URL(req.url, 'http://localhost');
  const q = Object.fromEntries(searchParams);


  // Arabic subtitle lookup/download: /api?subtitle=1&id=...&s=...&e=...&force=1
  if (q.subtitle === '1') {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    try {
      if (!q.id) throw new Error('missing id');
      const result = await getArabicSubtitle(q.id, q.s, q.e, q.force === '1');
      return res.end(JSON.stringify(result));
    } catch (err) {
      res.statusCode = 500;
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
    const stream = await getStream(q.id, q.s, q.e);
    res.end(JSON.stringify(stream));
  } catch (err) {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: err.message }));
  }
};
