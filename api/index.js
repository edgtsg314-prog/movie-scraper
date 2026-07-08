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
async function getStream(id, season, episode) {
  await bootWasm();
  const token = globalThis.getAdv(String(id));
  if (!token) throw new Error('getAdv returned null');

  const apiUrl = season
    ? `https://vidlink.pro/api/b/tv/${token}/${season}/${episode || 1}?multiLang=0`
    : `https://vidlink.pro/api/b/movie/${token}?multiLang=0`;

  const res = await fetch(apiUrl, {
    headers: { Referer: REFERER, Origin: ORIGIN, 'User-Agent': UA }
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



// ── OpenSubtitles integration ────────────────────────────────────────────────
const OS_API_KEY = process.env.OPENSUBTITLES_API_KEY || process.env.OS_API_KEY || '';
const OS_UA = process.env.OPENSUBTITLES_USER_AGENT || 'KLOStream/1.0';

function srtToVtt(s) {
  let out = String(s || '').replace(/^\uFEFF/, '').replace(/\r+/g, '');
  out = out.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})\s+-->\s+(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2 --> $3.$4');
  out = out.replace(/<font[^>]*>/gi, '').replace(/<\/font>/gi, '');
  if (!/^WEBVTT/i.test(out.trim())) out = 'WEBVTT\n\n' + out;
  return out;
}

async function osFetch(url, opts = {}) {
  if (!OS_API_KEY) throw new Error('Missing OPENSUBTITLES_API_KEY');
  const res = await fetch(url, {
    ...opts,
    headers: {
      'Api-Key': OS_API_KEY,
      'User-Agent': OS_UA,
      'Content-Type': 'application/json',
      ...(opts.headers || {})
    }
  });
  if (!res.ok) throw new Error(`OpenSubtitles returned ${res.status}`);
  return res;
}

function scoreSubtitle(item, wantedLangs) {
  const a = item.attributes || {};
  const f = (a.files && a.files[0]) || {};
  let score = 0;
  const lang = String(a.language || '').toLowerCase();
  const idx = wantedLangs.indexOf(lang);
  if (idx >= 0) score += 100 - idx * 10;
  if (a.from_trusted) score += 22;
  if (a.hd) score += 10;
  if (!a.hearing_impaired) score += 8;
  if (a.ai_translated === false) score += 8;
  if (a.machine_translated === false) score += 8;
  score += Math.min(25, Number(a.download_count || 0) / 250);
  score += Math.min(12, Number(a.ratings || 0) * 2);
  if (String(f.file_name || '').toLowerCase().includes('proper')) score += 3;
  return score;
}

async function findBestSubtitles({ id, season, episode, lang }) {
  const wantedLangs = String(lang || 'ar,en').split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
  const params = new URLSearchParams();
  params.set('tmdb_id', String(id));
  params.set('languages', wantedLangs.join(','));
  params.set('order_by', 'download_count');
  params.set('order_direction', 'desc');
  if (season) params.set('season_number', String(season));
  if (season) params.set('episode_number', String(episode || 1));
  const res = await osFetch('https://api.opensubtitles.com/api/v1/subtitles?' + params.toString());
  const json = await res.json();
  const rows = Array.isArray(json.data) ? json.data : [];
  return rows
    .filter(x => x?.attributes?.files?.[0]?.file_id)
    .sort((a, b) => scoreSubtitle(b, wantedLangs) - scoreSubtitle(a, wantedLangs))
    .slice(0, 6);
}

async function getDownloadLink(fileId) {
  const res = await osFetch('https://api.opensubtitles.com/api/v1/download', {
    method: 'POST',
    body: JSON.stringify({ file_id: Number(fileId), sub_format: 'srt' })
  });
  const json = await res.json();
  if (!json.link) throw new Error('OpenSubtitles download link missing');
  return json.link;
}

// ── Vercel serverless handler ─────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const { searchParams } = new URL(req.url, 'http://localhost');
  const q = Object.fromEntries(searchParams);


  // OpenSubtitles best subtitle list: /api/subtitles?id=550&lang=ar,en or /api/subtitles?id=94997&s=1&e=1
  if (req.url.startsWith('/subtitles') || new URL(req.url, 'http://localhost').pathname.endsWith('/subtitles')) {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    try {
      if (!q.id) throw new Error('missing id');
      const best = await findBestSubtitles({ id: q.id, season: q.s, episode: q.e, lang: q.lang });
      const output = best.map((item, idx) => {
        const a = item.attributes || {};
        const file = (a.files && a.files[0]) || {};
        return {
          label: `${a.language || 'sub'} • ${a.release || file.file_name || 'OpenSubtitles'}${idx === 0 ? ' • Best' : ''}`,
          language: a.language || 'ar',
          downloads: a.download_count || 0,
          score: Math.round(scoreSubtitle(item, String(q.lang || 'ar,en').split(',').map(x=>x.trim().toLowerCase()))),
          vtt: `/api/subtitle?file_id=${encodeURIComponent(file.file_id)}`
        };
      });
      return res.end(JSON.stringify({ subtitles: output }));
    } catch (err) {
      res.statusCode = 500;
      return res.end(JSON.stringify({ error: err.message, subtitles: [] }));
    }
  }

  // OpenSubtitles VTT proxy: /api/subtitle?file_id=123
  if (req.url.startsWith('/subtitle') || new URL(req.url, 'http://localhost').pathname.endsWith('/subtitle')) {
    try {
      if (!q.file_id) throw new Error('missing file_id');
      const link = await getDownloadLink(q.file_id);
      const subRes = await fetch(link, { headers: { 'User-Agent': OS_UA } });
      if (!subRes.ok) throw new Error(`subtitle download returned ${subRes.status}`);
      const body = await subRes.text();
      res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
      res.setHeader('Cache-Control', 'public, max-age=86400');
      return res.end(srtToVtt(body));
    } catch (err) {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      return res.end(err.message);
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
