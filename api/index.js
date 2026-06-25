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


// ── Local Live TV source manager ─────────────────────────────────────────────
// Add your channels in data/live-channels.json, then open:
//   /?live=Bein1
// Supported source types: hls, mp4, webm, embed, auto.
const LIVE_CHANNELS_FILE = path.join(__dirname, '..', 'data', 'live-channels.json');
function normalizeKey(v) {
  return String(v || '').trim().toLowerCase().replace(/\s+/g, '').replace(/[^a-z0-9_\-\u0600-\u06ff]/gi, '');
}
function loadLiveChannels() {
  let list = [];
  try {
    const raw = fs.readFileSync(LIVE_CHANNELS_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    list = Array.isArray(parsed) ? parsed : (parsed.channels || []);
  } catch (_) {
    list = [];
  }

  // Optional quick env mapping, e.g. LIVE_BEIN1_URL=https://example.com/live.m3u8
  for (const [k, v] of Object.entries(process.env)) {
    const m = k.match(/^LIVE_([A-Z0-9_]+)_URL$/i);
    if (m && v) {
      list.push({ id: m[1], name: m[1].replace(/_/g, ' '), url: v, type: 'auto' });
    }
  }

  const map = new Map();
  for (const ch of list) {
    if (!ch || !ch.url) continue;
    const id = ch.id || ch.key || ch.slug || ch.name;
    if (!id) continue;
    map.set(normalizeKey(id), {
      id: String(id),
      name: ch.name || String(id),
      logo: ch.logo || '',
      group: ch.group || ch.category || 'Live TV',
      url: ch.url,
      type: (ch.type || 'auto').toLowerCase()
    });
  }
  return map;
}
function getLiveChannel(liveId) {
  const map = loadLiveChannels();
  const key = normalizeKey(liveId);
  if (map.has(key)) return map.get(key);
  const names = [...map.values()].map(x => x.id);
  const err = new Error(`Live channel not found: ${liveId}. Available: ${names.join(', ') || 'none'}`);
  err.statusCode = 404;
  throw err;
}
function detectSourceType(url, preferred) {
  const p = String(preferred || '').toLowerCase();
  if (['hls','mp4','webm','dash','embed'].includes(p)) return p;
  const u = String(url || '').split('?')[0].toLowerCase();
  if (/\.m3u8?$/.test(u)) return 'hls';
  if (/\.mp4$/.test(u)) return 'mp4';
  if (/\.webm$/.test(u)) return 'webm';
  if (/\.mpd$/.test(u)) return 'dash';
  if (/\.php$|embed|watch|stream/.test(u)) return 'embed';
  return 'auto';
}

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
  let body = String(srt || '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/<\/?(font|b|i|u|c|span)[^>]*>/gi, '')
    .replace(/\{\\[^}]+\}/g, '')
    .replace(/\{[^}]+\}/g, '');

  // Some Arabic SRT files start with credits/title lines before the first cue.
  // WebVTT must start cleanly with WEBVTT then cues, so strip anything before
  // the first real timestamp. This is why subtitles could be downloaded but not displayed.
  const firstTime = body.search(/\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}\s*-->/);
  if (firstTime > 0) body = body.slice(firstTime);

  // Normalize timestamp format to WebVTT HH:MM:SS.mmm.
  body = body.replace(/(\d{1,2}:\d{2}:\d{2}),(\d{1,3})/g, (_, a, ms) => `${a}.${String(ms).padEnd(3, '0').slice(0,3)}`);

  const lines = body.split('\n');
  const out = ['WEBVTT', ''];
  for (let line of lines) {
    const t = line.trim();
    // remove numeric SRT cue counters
    if (/^\d+$/.test(t)) continue;
    if (!t) { out.push(''); continue; }
    // remove unsupported SRT coordinate settings after timestamp if present
    if (/\d{1,2}:\d{2}:\d{2}\.\d{3}\s*-->/.test(t)) {
      line = t.replace(/\s+X1:\d+\s+X2:\d+\s+Y1:\d+\s+Y2:\d+/gi, '');
    }
    out.push(line);
  }

  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

async function tmdbJson(endpoint) {
  const sep = endpoint.includes('?') ? '&' : '?';
  const url = `https://api.themoviedb.org/3${endpoint}${sep}api_key=${encodeURIComponent(TMDB_KEY)}`;
  const r = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!r.ok) throw new Error(`TMDB ${r.status}`);
  return r.json();
}

async function getMediaIdentifiers(tmdbId, season, episode) {
  // Returns accurate IDs + metadata so OpenSubtitles can match by IMDb first,
  // then TMDB/title/year as fallback. This fixes using TMDB ID directly as IMDb.
  if (season) {
    let showExternal = {}, showDetails = {}, epExternal = {}, epDetails = {};
    try { showExternal = await tmdbJson(`/tv/${tmdbId}/external_ids`); } catch (_) {}
    try { showDetails = await tmdbJson(`/tv/${tmdbId}?language=en-US`); } catch (_) {}
    try { epExternal = await tmdbJson(`/tv/${tmdbId}/season/${season}/episode/${episode || 1}/external_ids`); } catch (_) {}
    try { epDetails = await tmdbJson(`/tv/${tmdbId}/season/${season}/episode/${episode || 1}?language=en-US`); } catch (_) {}
    return {
      tmdbId: String(tmdbId),
      type: 'episode',
      mediaKind: 'episode',
      imdbId: epExternal?.imdb_id || showExternal?.imdb_id || null,
      episodeImdbId: epExternal?.imdb_id || null,
      showImdbId: showExternal?.imdb_id || null,
      season: Number(season),
      episode: Number(episode || 1),
      title: showDetails?.name || showDetails?.original_name || '',
      episodeTitle: epDetails?.name || '',
      year: String(showDetails?.first_air_date || '').slice(0, 4)
    };
  }

  let movieExternal = {}, movieDetails = {};
  try { movieExternal = await tmdbJson(`/movie/${tmdbId}/external_ids`); } catch (_) {}
  try { movieDetails = await tmdbJson(`/movie/${tmdbId}?language=en-US`); } catch (_) {}
  return {
    tmdbId: String(tmdbId),
    type: 'movie',
    mediaKind: 'movie',
    imdbId: movieExternal?.imdb_id || null,
    title: movieDetails?.title || movieDetails?.original_title || '',
    year: String(movieDetails?.release_date || '').slice(0, 4)
  };
}

function imdbVariants(imdbId) {
  const raw = String(imdbId || '').trim();
  if (!raw) return [];
  const noTt = raw.replace(/^tt/i, '');
  const noZeros = noTt.replace(/^0+/, '') || noTt;
  return [...new Set([noZeros, noTt, raw])].filter(Boolean);
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

async function osSearchArabicOnce(params) {
  const token = await osLogin();
  const qs = new URLSearchParams({ languages: 'ar', order_by: 'download_count', order_direction: 'desc' });
  for (const [k, v] of Object.entries(params || {})) {
    if (v !== undefined && v !== null && String(v).trim() !== '') qs.set(k, String(v));
  }
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
  if (!r.ok) throw new Error(`OpenSubtitles search ${r.status}: ${text.slice(0, 220)}`);
  const data = JSON.parse(text);
  return data?.data || [];
}

function subtitleFileId(item) {
  const files = item?.attributes?.files || [];
  return files[0]?.file_id || item?.id || '';
}

function normalizeText(x) {
  return String(x || '').toLowerCase();
}

function scoreArabicSubtitle(item, info, usedParams) {
  const a = item.attributes || {};
  const feature = a.feature_details || {};
  const files = a.files || [];
  let score = 0;

  // Strong identity match. IMDb based searches are safest; title fallback is weakest.
  if (usedParams?.imdb_id) score += 120;
  if (usedParams?.tmdb_id) score += 70;
  if (usedParams?.query) score += 35;

  const release = normalizeText([a.release, a.release_name, a.file_name, files[0]?.file_name].join(' '));
  const moviehash = a.moviehash_match || a.movie_hash_match;
  if (moviehash) score += 80;

  if (a.from_trusted) score += 30;
  if (a.ai_translated === false) score += 10;
  if (a.machine_translated === false) score += 10;
  if (a.hearing_impaired) score -= 12;

  const rating = Number(a.ratings || a.rating || 0);
  const downloads = Number(a.download_count || a.downloads || 0);
  score += Math.min(25, rating * 3);
  score += Math.min(30, Math.log10(downloads + 1) * 10);

  // Prefer common scene releases. This helps pick subtitles synced to stream sources.
  if (/web[- .]?dl|webrip|web/.test(release)) score += 20;
  if (/bluray|blu[- .]?ray|brrip/.test(release)) score += 14;
  if (/hdrip|dvdrip/.test(release)) score += 5;
  if (/cam|hdcam|ts|telesync/.test(release)) score -= 25;

  if (info.type === 'episode') {
    if (String(feature.season_number || a.season_number || '') === String(info.season)) score += 35;
    if (String(feature.episode_number || a.episode_number || '') === String(info.episode)) score += 35;
  }

  // If OS returns feature year/title, use it as a sanity boost.
  if (info.year && String(feature.year || a.year || '') === String(info.year)) score += 12;
  const titleBag = normalizeText([feature.title, a.movie_name, a.movie_title, a.title].join(' '));
  if (info.title && titleBag && titleBag.includes(normalizeText(info.title).slice(0, 10))) score += 8;

  return score;
}

function subtitleDisplayName(item, index, score) {
  const a = item.attributes || {};
  const files = a.files || [];
  const release = a.release || a.release_name || files[0]?.file_name || a.movie_name || '';
  const parts = [];
  parts.push(`العربية ${index + 1}`);
  if (release) parts.push(String(release).slice(0, 60));
  if (a.download_count) parts.push(`${a.download_count} تحميل`);
  if (a.ratings) parts.push(`تقييم ${a.ratings}`);
  parts.push(`نقاط ${Math.round(score)}`);
  return parts.join(' · ');
}

async function osSearchArabicSmart(info) {
  const attempts = [];
  const isEpisode = info.type === 'episode';
  const type = isEpisode ? 'episode' : 'movie';

  // 1) Best: IMDb ID. OpenSubtitles generally expects IMDb without "tt" and without leading zeroes.
  for (const imdb of imdbVariants(info.episodeImdbId || info.imdbId)) {
    attempts.push({ type, imdb_id: imdb, season_number: isEpisode ? info.season : undefined, episode_number: isEpisode ? info.episode : undefined, _method: 'episode/movie imdb' });
  }

  // 2) If exact episode IMDb did not work, try show IMDb + S/E.
  if (isEpisode && info.showImdbId && info.showImdbId !== info.episodeImdbId) {
    for (const imdb of imdbVariants(info.showImdbId)) {
      attempts.push({ type: 'episode', imdb_id: imdb, season_number: info.season, episode_number: info.episode, _method: 'show imdb + S/E' });
    }
  }

  // 3) TMDB fallback.
  attempts.push({ type, tmdb_id: info.tmdbId, season_number: isEpisode ? info.season : undefined, episode_number: isEpisode ? info.episode : undefined, _method: 'tmdb' });

  // 4) Title/year fallback.
  if (info.title) {
    attempts.push({ type, query: info.title, year: info.year, season_number: isEpisode ? info.season : undefined, episode_number: isEpisode ? info.episode : undefined, _method: 'title + year' });
    if (isEpisode && info.episodeTitle) attempts.push({ type, query: `${info.title} ${info.episodeTitle}`, year: info.year, season_number: info.season, episode_number: info.episode, _method: 'show + episode title' });
  }

  let lastError = null;
  const seen = new Set();
  const candidates = [];

  for (const rawParams of attempts) {
    const { _method, ...params } = rawParams;
    try {
      const results = await osSearchArabicOnce(params);
      const arabic = (results || []).filter(x => {
        const a = x.attributes || {};
        return String(a.language || '').toLowerCase() === 'ar' || /arabic|arab|العربية/i.test(String(a.language || '') + ' ' + String(a.release || '') + ' ' + String(a.file_name || ''));
      });
      for (const item of arabic) {
        const fid = subtitleFileId(item);
        if (!fid || seen.has(fid)) continue;
        seen.add(fid);
        const score = scoreArabicSubtitle(item, info, rawParams);
        candidates.push({ item, score, used: params, method: _method || 'unknown' });
      }
    } catch (err) {
      lastError = err;
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  if (lastError && !candidates.length) console.warn('OpenSubtitles last search error:', lastError.message);
  return { best: candidates[0]?.item || null, used: candidates[0]?.used || null, count: candidates.length, candidates, info };
}

async function getArabicSubtitleCandidates(tmdbId, season, episode) {
  const info = await getMediaIdentifiers(tmdbId, season, episode);
  const search = await osSearchArabicSmart(info);
  return search.candidates.map((c, i) => {
    const a = c.item.attributes || {};
    const file = a.files?.[0] || {};
    return {
      index: i,
      file_id: file.file_id,
      score: Math.round(c.score),
      label: subtitleDisplayName(c.item, i, c.score),
      release: a.release || a.release_name || file.file_name || '',
      downloads: a.download_count || 0,
      ratings: a.ratings || 0,
      trusted: !!a.from_trusted,
      hearing_impaired: !!a.hearing_impaired,
      method: c.method,
      used: c.used
    };
  }).filter(x => x.file_id);
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

async function getArabicSubtitleVtt(tmdbId, season, episode, choice) {
  const list = await getArabicSubtitleCandidates(tmdbId, season, episode);
  if (!list.length) {
    const info = await getMediaIdentifiers(tmdbId, season, episode);
    throw new Error(`No Arabic subtitle found (tmdb=${tmdbId}${season ? ` s${season}e${episode || 1}` : ''}, imdb=${info.imdbId || 'none'})`);
  }
  let idx = Number(choice || 0);
  if (!Number.isFinite(idx) || idx < 0 || idx >= list.length) idx = 0;
  const chosen = list[idx];
  const vtt = await osDownloadVtt(chosen.file_id);
  return { vtt, chosen, total: list.length };
}

// ── Vercel serverless handler ─────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.end('ok');

  const { searchParams } = new URL(req.url, 'http://localhost');
  const q = Object.fromEntries(searchParams);

  // Live channel lookup: /api?live=Bein1
  if (q.live || q.channel) {
    try {
      const ch = getLiveChannel(q.live || q.channel);
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      return res.end(JSON.stringify({
        ok: true,
        live: true,
        id: ch.id,
        title: ch.name,
        name: ch.name,
        logo: ch.logo,
        group: ch.group,
        url: ch.url,
        type: detectSourceType(ch.url, ch.type)
      }, null, 2));
    } catch (err) {
      res.statusCode = err.statusCode || 500;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      return res.end(JSON.stringify({ ok: false, error: err.message }));
    }
  }

  // List live channels: /api?live_list=1
  if (q.live_list) {
    const channels = [...loadLiveChannels().values()].map(ch => ({
      id: ch.id, name: ch.name, logo: ch.logo, group: ch.group, type: detectSourceType(ch.url, ch.type)
    }));
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    return res.end(JSON.stringify({ ok: true, count: channels.length, channels }, null, 2));
  }

  // Debug identifier resolution: /api?subtitle_debug=1&id=238
  if (q.subtitle_debug) {
    try {
      const info = await getMediaIdentifiers(q.id, q.s, q.e || '1');
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      return res.end(JSON.stringify({ ok: true, info }, null, 2));
    } catch (err) {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      return res.end(JSON.stringify({ ok: false, error: err.message }));
    }
  }

  // Arabic subtitle candidates: /api?subtitle_list=1&id=238 OR /api?subtitle_list=1&id=94997&s=1&e=1
  if (q.subtitle_list) {
    if (!q.id) {
      res.statusCode = 400;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      return res.end(JSON.stringify({ ok: false, error: 'missing id' }));
    }
    try {
      const info = await getMediaIdentifiers(q.id, q.s, q.e || '1');
      const subtitles = await getArabicSubtitleCandidates(q.id, q.s, q.e || '1');
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      return res.end(JSON.stringify({ ok: true, info, count: subtitles.length, subtitles }, null, 2));
    } catch (err) {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      return res.end(JSON.stringify({ ok: false, error: err.message }));
    }
  }

  // Arabic subtitle VTT: /api?subtitle=1&id=238 OR /api?subtitle=1&id=94997&s=1&e=1
  if (q.subtitle) {
    if (!q.id) {
      res.statusCode = 400;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      return res.end(JSON.stringify({ ok: false, error: 'missing id' }));
    }
    try {
      const result = await getArabicSubtitleVtt(q.id, q.s, q.e || '1', q.choice);
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
      res.setHeader('X-Subtitle-Choice', String(result.chosen?.index ?? 0));
      res.setHeader('X-Subtitle-Label', encodeURIComponent(result.chosen?.label || 'Arabic'));
      res.setHeader('Cache-Control', 'public, max-age=86400, s-maxage=604800');
      return res.end(result.vtt);
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
