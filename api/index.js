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
  const resolved = await getMediaResolve(id, season, episode);
  return resolved.best;
}

function extractPlayableSource(data) {
  const stream = data?.stream || data?.data?.stream || data?.result?.stream || data;

  // Old VidLink format: { stream: { playlist: 'https://...m3u8' } }
  const directCandidates = [
    stream?.playlist,
    data?.playlist,
    stream?.url,
    data?.url,
    stream?.file,
    data?.file,
    stream?.src,
    data?.src,
    stream?.source,
    data?.source,
    data?.link
  ].filter(Boolean);

  for (const x of directCandidates) {
    if (typeof x === 'string' && /^https?:\/\//i.test(x)) return x;
  }

  // New VidLink format: { stream: { qualities: { "360": { url: "...mp4" } } } }
  const qualities = stream?.qualities || data?.qualities || data?.sources?.qualities;
  const qualityUrl = pickBestQualityUrl(qualities);
  if (qualityUrl) return qualityUrl;

  // Common formats: { sources: [{file/url/src: ...}] } or { stream: { sources: [...] } }
  const sourceLists = [stream?.sources, data?.sources, stream?.files, data?.files].filter(Array.isArray);
  for (const list of sourceLists) {
    const best = pickBestFromSources(list);
    if (best) return best;
  }

  // Embed/iframe fallback
  const embedCandidates = [stream?.iframe, data?.iframe, stream?.embed, data?.embed, stream?.embedUrl, data?.embedUrl].filter(Boolean);
  for (const x of embedCandidates) {
    if (typeof x === 'string' && /^https?:\/\//i.test(x)) return x;
  }

  return null;
}

function pickBestQualityUrl(qualities) {
  if (!qualities || typeof qualities !== 'object') return null;
  const order = ['2160','1440','1080','720','480','360','auto','default'];
  for (const q of order) {
    const item = qualities[q] || qualities[String(q)] || qualities[q + 'p'];
    const url = typeof item === 'string' ? item : item?.url || item?.file || item?.src;
    if (url && /^https?:\/\//i.test(url)) return url;
  }
  const values = Object.entries(qualities)
    .map(([quality, item]) => ({ quality: Number(String(quality).replace(/\D/g, '')) || 0, item }))
    .sort((a, b) => b.quality - a.quality);
  for (const { item } of values) {
    const url = typeof item === 'string' ? item : item?.url || item?.file || item?.src;
    if (url && /^https?:\/\//i.test(url)) return url;
  }
  return null;
}

function pickBestFromSources(list) {
  const normalized = list.map(x => {
    const url = typeof x === 'string' ? x : x?.url || x?.file || x?.src || x?.link;
    const q = typeof x === 'object' ? Number(String(x.quality || x.label || x.height || '').replace(/\D/g, '')) || 0 : 0;
    return { url, q };
  }).filter(x => x.url && /^https?:\/\//i.test(x.url));
  normalized.sort((a, b) => b.q - a.q);
  return normalized[0]?.url || null;
}
function detectMediaType(url, hintedType) {
  const u = String(url || '').split('?')[0].toLowerCase();
  const h = String(hintedType || '').toLowerCase();
  if (h.includes('mpeg') || h.includes('hls') || u.endsWith('.m3u8')) return 'hls';
  if (h.includes('dash') || u.endsWith('.mpd')) return 'dash';
  if (h.includes('mp4') || u.endsWith('.mp4') || u.endsWith('.m4v') || u.endsWith('.mov')) return 'mp4';
  if (h.includes('webm') || u.endsWith('.webm')) return 'webm';
  if (h.includes('iframe') || h.includes('embed')) return 'iframe';
  return /^https?:\/\//i.test(String(url || '')) ? 'unknown' : 'unknown';
}

function normalizeQuality(q) {
  const n = Number(String(q || '').replace(/[^0-9]/g, '')) || 0;
  return n;
}

function addVideoSource(out, url, opts = {}) {
  if (!url || typeof url !== 'string' || !/^https?:\/\//i.test(url)) return;
  if (out._seenVideos.has(url)) return;
  out._seenVideos.add(url);
  const type = detectMediaType(url, opts.type);
  const quality = normalizeQuality(opts.quality || opts.label || opts.height);
  const item = {
    url,
    proxiedUrl: type === 'iframe' ? url : '/api?url=' + encodeURIComponent(url),
    type,
    quality: quality || null,
    label: opts.label || (quality ? quality + 'p' : (type === 'hls' ? 'Auto HLS' : type.toUpperCase())),
    source: opts.source || 'primary'
  };
  if (type === 'iframe') out.fallbackIframe = out.fallbackIframe || url;
  else out.videos.push(item);
}

function addSubtitleSource(out, url, opts = {}) {
  if (!url || typeof url !== 'string' || !/^https?:\/\//i.test(url)) return;
  if (out._seenSubs.has(url)) return;
  out._seenSubs.add(url);
  const u = url.split('?')[0].toLowerCase();
  let type = opts.type || (u.endsWith('.vtt') ? 'vtt' : u.endsWith('.srt') ? 'srt' : (u.endsWith('.ass') || u.endsWith('.ssa')) ? 'ass' : 'unknown');
  out.subtitles.push({
    url,
    proxiedUrl: '/api?subtitle_url=' + encodeURIComponent(url),
    type,
    lang: opts.lang || opts.language || 'unknown',
    label: opts.label || opts.name || opts.lang || 'Subtitle',
    default: !!opts.default
  });
}

function addAudioSource(out, url, opts = {}) {
  if (!url || typeof url !== 'string' || !/^https?:\/\//i.test(url)) return;
  if (out._seenAudios.has(url)) return;
  out._seenAudios.add(url);
  out.audios.push({
    url,
    proxiedUrl: '/api?url=' + encodeURIComponent(url),
    type: opts.type || 'audio',
    lang: opts.lang || opts.language || 'unknown',
    label: opts.label || opts.name || opts.lang || 'Audio'
  });
}

function extractMediaResolve(data) {
  const stream = data?.stream || data?.data?.stream || data?.result?.stream || data;
  const out = { ok: true, videos: [], subtitles: [], audios: [], fallbackIframe: null, rawType: stream?.type || data?.type || null, sourceId: data?.sourceId || data?.source || null, _seenVideos: new Set(), _seenSubs: new Set(), _seenAudios: new Set() };

  // Direct playlist/file/url formats.
  const direct = [
    [stream?.playlist, 'hls', 'playlist'], [data?.playlist, 'hls', 'playlist'],
    [stream?.url, stream?.type, 'stream.url'], [data?.url, data?.type, 'url'],
    [stream?.file, stream?.type, 'stream.file'], [data?.file, data?.type, 'file'],
    [stream?.src, stream?.type, 'stream.src'], [data?.src, data?.type, 'src'],
    [stream?.source, stream?.type, 'stream.source'], [data?.source, data?.type, 'source'], [data?.link, data?.type, 'link']
  ];
  for (const [url, type, source] of direct) addVideoSource(out, url, { type, source });

  // Quality map: { qualities: { "1080": {url,type}, "720": "..." } }
  const qMaps = [stream?.qualities, data?.qualities, data?.sources?.qualities].filter(x => x && typeof x === 'object' && !Array.isArray(x));
  for (const qualities of qMaps) {
    for (const [quality, item] of Object.entries(qualities)) {
      const url = typeof item === 'string' ? item : item?.url || item?.file || item?.src || item?.link;
      addVideoSource(out, url, { quality, label: normalizeQuality(quality) ? normalizeQuality(quality) + 'p' : quality, type: typeof item === 'object' ? item?.type : undefined, source: 'qualities' });
    }
  }

  // Common arrays.
  const sourceLists = [stream?.sources, data?.sources, stream?.files, data?.files, stream?.videos, data?.videos].filter(Array.isArray);
  for (const list of sourceLists) {
    for (const item of list) {
      const url = typeof item === 'string' ? item : item?.url || item?.file || item?.src || item?.link;
      addVideoSource(out, url, { quality: item?.quality || item?.label || item?.height, label: item?.label || item?.quality, type: item?.type || item?.mimeType, source: 'sources' });
    }
  }

  // Embedded fallback.
  for (const x of [stream?.iframe, data?.iframe, stream?.embed, data?.embed, stream?.embedUrl, data?.embedUrl]) addVideoSource(out, x, { type: 'iframe', label: 'Embed', source: 'iframe' });

  // Provider subtitle formats.
  const subLists = [stream?.subtitles, data?.subtitles, stream?.captions, data?.captions, stream?.tracks, data?.tracks].filter(Array.isArray);
  for (const list of subLists) {
    for (const item of list) {
      const url = typeof item === 'string' ? item : item?.url || item?.file || item?.src || item?.link;
      const kind = String(item?.kind || item?.type || '').toLowerCase();
      if (kind && !/(subtitle|caption|captions|vtt|srt|ass|ssa)/i.test(kind)) continue;
      addSubtitleSource(out, url, { type: item?.type || item?.format, lang: item?.lang || item?.srclang || item?.language, label: item?.label || item?.name, default: item?.default });
    }
  }

  // Audio tracks if provider returns them separately.
  const audioLists = [stream?.audios, data?.audios, stream?.audio, data?.audio].filter(Array.isArray);
  for (const list of audioLists) {
    for (const item of list) {
      const url = typeof item === 'string' ? item : item?.url || item?.file || item?.src || item?.link;
      addAudioSource(out, url, { type: item?.type || item?.format, lang: item?.lang || item?.language, label: item?.label || item?.name });
    }
  }

  out.videos.sort((a, b) => (b.quality || 0) - (a.quality || 0));
  delete out._seenVideos; delete out._seenSubs; delete out._seenAudios;
  out.best = out.videos[0]?.url || out.fallbackIframe || null;
  return out;
}

async function getMediaResolve(id, season, episode) {
  await bootWasm();
  const token = globalThis.getAdv(String(id));
  if (!token) throw new Error('getAdv returned null');
  const apiUrl = season
    ? `https://vidlink.pro/api/b/tv/${token}/${season}/${episode || 1}?multiLang=0`
    : `https://vidlink.pro/api/b/movie/${token}?multiLang=0`;
  const res = await fetch(apiUrl, { headers: { Referer: REFERER, Origin: ORIGIN, 'User-Agent': BROWSER_UA } });
  if (!res.ok) throw new Error(`vidlink API returned ${res.status}`);
  const data = await res.json();
  const resolved = extractMediaResolve(data);
  if (!resolved.best && !resolved.videos.length && !resolved.fallbackIframe) {
    const body = JSON.stringify(data).slice(0, 900);
    throw new Error(`No playable source in response. keys=[${Object.keys(data || {}).join(', ')}] body=${body}`);
  }
  return resolved;
}


// ── HLS upstream fetcher with redirect support ────────────────────────────────
function fetchUpstream(url, redirects = 0, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('too many redirects'));
    (url.startsWith('https') ? https : http).get(url, {
      headers: { Referer: REFERER, Origin: ORIGIN, 'User-Agent': BROWSER_UA, Accept: '*/*', ...extraHeaders }
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const loc = res.headers.location;
        return resolve(fetchUpstream(loc.startsWith('http') ? loc : new URL(loc, url).href, redirects + 1, extraHeaders));
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



// ── Live Channels Manager ───────────────────────────────────────────────────
// Works locally with data/live-channels.json.
// On Vercel, filesystem is read-only, so this also supports Vercel KV / Upstash Redis.
// Env supported:
//   KV_REST_API_URL + KV_REST_API_TOKEN
//   or UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN
// Optional initial static JSON:
//   LIVE_CHANNELS_JSON='[{"id":"bein1","name":"beIN 1","stream":"https://..."}]'
const LIVE_DB_PATH = path.join(process.cwd(), 'data', 'live-channels.json');
const LIVE_KV_KEY = process.env.LIVE_CHANNELS_KV_KEY || 'iptvexpert:live-channels';
const KV_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '';
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '';
let memoryLiveChannels = null;

function hasKvStorage() {
  return !!(KV_URL && KV_TOKEN);
}

function storageMode() {
  if (hasKvStorage()) return 'kv';
  if (canWriteLocalFile()) return 'file';
  return 'memory';
}

function canWriteLocalFile() {
  try {
    const dir = path.dirname(LIVE_DB_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const test = path.join(dir, '.write-test');
    fs.writeFileSync(test, '1');
    fs.unlinkSync(test);
    return true;
  } catch (_) {
    return false;
  }
}

function initialLiveChannels() {
  if (Array.isArray(memoryLiveChannels)) return memoryLiveChannels;
  try {
    if (process.env.LIVE_CHANNELS_JSON) {
      const arr = JSON.parse(process.env.LIVE_CHANNELS_JSON);
      if (Array.isArray(arr)) return (memoryLiveChannels = arr.map(safeChannel));
    }
  } catch (_) {}
  try {
    const raw = fs.readFileSync(LIVE_DB_PATH, 'utf8');
    const arr = JSON.parse(raw || '[]');
    return (memoryLiveChannels = (Array.isArray(arr) ? arr : []).map(safeChannel));
  } catch (_) {
    return (memoryLiveChannels = []);
  }
}

async function kvFetch(commandParts) {
  const url = KV_URL.replace(/\/$/, '') + '/' + commandParts.map(x => encodeURIComponent(String(x))).join('/');
  const r = await fetch(url, {
    headers: { Authorization: `Bearer ${KV_TOKEN}`, Accept: 'application/json' },
    cache: 'no-store'
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`KV ${r.status}: ${text.slice(0, 180)}`);
  return JSON.parse(text);
}

async function readLiveChannels() {
  if (hasKvStorage()) {
    try {
      const d = await kvFetch(['get', LIVE_KV_KEY]);
      const raw = d.result;
      if (!raw) {
        const init = initialLiveChannels().map(safeChannel);
        if (init.length) await writeLiveChannels(init);
        return init;
      }
      const arr = typeof raw === 'string' ? JSON.parse(raw) : raw;
      return (Array.isArray(arr) ? arr : []).map(safeChannel);
    } catch (err) {
      console.warn('Live KV read failed, using memory/file fallback:', err.message);
    }
  }
  return initialLiveChannels().map(safeChannel);
}

async function writeLiveChannels(list) {
  const clean = (Array.isArray(list) ? list : []).map(safeChannel);
  memoryLiveChannels = clean;
  if (hasKvStorage()) {
    await kvFetch(['set', LIVE_KV_KEY, JSON.stringify(clean)]);
    return { mode: 'kv', persistent: true };
  }
  try {
    const dir = path.dirname(LIVE_DB_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(LIVE_DB_PATH, JSON.stringify(clean, null, 2), 'utf8');
    return { mode: 'file', persistent: true };
  } catch (err) {
    // Vercel serverless has read-only filesystem. Keep runtime memory so admin still works
    // during the same warm invocation, and return a clear non-persistent warning.
    return { mode: 'memory', persistent: false, warning: 'الاستضافة لا تسمح بالحفظ داخل الملفات. اربط Vercel KV / Upstash للحفظ الدائم.' };
  }
}

function makeLiveId(name = '') {
  const base = String(name || '').trim().toLowerCase()
    .replace(/[^a-z0-9\u0600-\u06FF]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 28);
  const rnd = Math.random().toString(36).slice(2, 8);
  return (base ? `${base}-${rnd}` : `live-${rnd}`).replace(/--+/g, '-');
}
function safeChannel(ch = {}) {
  return {
    id: String(ch.id || ch.slug || makeLiveId(ch.name)),
    name: String(ch.name || 'Live Channel'),
    category: String(ch.category || 'عام'),
    logo: String(ch.logo || ''),
    stream: String(ch.stream || ch.url || ''),
    backup: Array.isArray(ch.backup) ? ch.backup.map(String).filter(Boolean) : String(ch.backup || '').split('\n').map(x => x.trim()).filter(Boolean),
    active: ch.active !== false,
    order: Number.isFinite(Number(ch.order)) ? Number(ch.order) : 0,
    createdAt: ch.createdAt || new Date().toISOString(),
    updatedAt: ch.updatedAt || '',
    views: Number(ch.views || 0)
  };
}
function publicChannel(ch) {
  const c = safeChannel(ch);
  return { ...c, watchUrl: `/?live=${encodeURIComponent(c.id)}` };
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 5_000_000) req.destroy(); });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function parseM3U(text) {
  const lines = String(text || '').split(/\r?\n/);
  const out = [];
  let meta = {};
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#EXTINF')) {
      const name = (line.split(',').pop() || 'Live Channel').trim();
      const getAttr = (key) => {
        const m = line.match(new RegExp(key + '="([^"]*)"', 'i'));
        return m ? m[1] : '';
      };
      meta = {
        name,
        logo: getAttr('tvg-logo'),
        category: getAttr('group-title') || 'عام'
      };
    } else if (!line.startsWith('#') && /^https?:\/\//i.test(line)) {
      out.push(safeChannel({ ...meta, stream: line, id: makeLiveId(meta.name || 'live') }));
      meta = {};
    }
  }
  return out;
}

function parseCSV(text) {
  const rows = String(text || '').split(/\r?\n/).map(x => x.trim()).filter(Boolean);
  if (!rows.length) return [];
  const split = (line) => line.split(/,(?=(?:(?:[^"]*"){2})*[^"]*$)/).map(x => x.replace(/^"|"$/g, '').trim());
  const header = split(rows[0]).map(x => x.toLowerCase());
  const hasHeader = header.some(x => ['name','stream','url','logo','category','id'].includes(x));
  const out = [];
  for (const row of rows.slice(hasHeader ? 1 : 0)) {
    const cols = split(row);
    const get = (key, idx) => hasHeader ? cols[header.indexOf(key)] || '' : cols[idx] || '';
    const name = get('name', 0) || get('title', 0);
    const stream = get('stream', 1) || get('url', 1);
    if (!stream) continue;
    out.push(safeChannel({
      id: get('id', 4) || makeLiveId(name),
      name: name || 'Live Channel',
      stream,
      logo: get('logo', 2),
      category: get('category', 3) || 'عام'
    }));
  }
  return out;
}

async function liveAdminApi(req, res, q) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (req.method === 'GET') {
    const list = (await readLiveChannels())
      .map(safeChannel)
      .sort((a, b) => (Number(a.order || 0) - Number(b.order || 0)) || String(a.name).localeCompare(String(b.name), 'ar'));
    return res.end(JSON.stringify({ ok: true, storage: storageMode(), persistent: storageMode() !== 'memory', count: list.length, channels: list.map(publicChannel) }, null, 2));
  }
  if (req.method !== 'POST') {
    res.statusCode = 405;
    return res.end(JSON.stringify({ ok: false, error: 'method not allowed' }));
  }
  try {
    const raw = await readBody(req);
    const body = raw ? JSON.parse(raw) : {};
    const action = body.action || q.action || 'save';
    let list = (await readLiveChannels()).map(safeChannel);

    if (action === 'delete') {
      const id = String(body.id || '').trim();
      list = list.filter(x => x.id !== id);
      const saved = await writeLiveChannels(list);
      return res.end(JSON.stringify({ ok: true, deleted: id, channels: list.length, ...saved }));
    }

    if (action === 'toggle') {
      const id = String(body.id || '').trim();
      list = list.map(x => x.id === id ? { ...x, active: body.active !== undefined ? !!body.active : !x.active, updatedAt: new Date().toISOString() } : x);
      const saved = await writeLiveChannels(list);
      return res.end(JSON.stringify({ ok: true, channel: publicChannel(list.find(x => x.id === id) || {}), ...saved }));
    }

    if (action === 'reorder') {
      const ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
      const pos = new Map(ids.map((id, i) => [id, i + 1]));
      list = list.map(x => pos.has(x.id) ? { ...x, order: pos.get(x.id), updatedAt: new Date().toISOString() } : x);
      const saved = await writeLiveChannels(list);
      return res.end(JSON.stringify({ ok: true, channels: list.length, ...saved }));
    }

    if (action === 'import') {
      const format = String(body.format || '').toLowerCase();
      const imported = (format === 'csv' ? parseCSV(body.text) : parseM3U(body.text)).map((x, i) => ({ ...x, order: list.length + i + 1 }));
      const byId = new Map(list.map(x => [x.id, x]));
      for (const ch of imported) {
        let id = ch.id;
        while (byId.has(id)) id = makeLiveId(ch.name);
        byId.set(id, { ...ch, id });
      }
      list = [...byId.values()];
      const saved = await writeLiveChannels(list);
      return res.end(JSON.stringify({ ok: true, imported: imported.length, channels: list.length, ...saved }));
    }

    const item = safeChannel(body.channel || body);
    if (!item.stream) {
      res.statusCode = 400;
      return res.end(JSON.stringify({ ok: false, error: 'stream url required' }));
    }
    if (body.autoId || !String(body.id || '').trim()) item.id = makeLiveId(item.name);
    const i = list.findIndex(x => x.id === item.id);
    if (i >= 0) list[i] = { ...list[i], ...item, updatedAt: new Date().toISOString() };
    else list.unshift({ ...item, order: item.order || 1 });
    const saved = await writeLiveChannels(list);
    return res.end(JSON.stringify({ ok: true, channel: publicChannel(item), ...saved }, null, 2));
  } catch (err) {
    res.statusCode = 500;
    return res.end(JSON.stringify({ ok: false, error: err.message }));
  }
}



// ── Vercel serverless handler ─────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,HEAD,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Range,Content-Type,Accept,Origin,Referer,User-Agent');
  if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.end('ok');

  const { searchParams } = new URL(req.url, 'http://localhost');
  const q = Object.fromEntries(searchParams);

  // Live channels admin/list API
  if (q.live_list || q.live_admin) {
    return liveAdminApi(req, res, q);
  }

  // Live channel lookup: /api?live=bein1
  if (q.live) {
    const liveId = String(q.live || '').trim();
    const channels = (await readLiveChannels()).map(safeChannel);
    const channel = channels.find(ch => ch.id === liveId || ch.name.toLowerCase() === liveId.toLowerCase());
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    if (!channel || !channel.active) {
      res.statusCode = 404;
      return res.end(JSON.stringify({ ok: false, error: 'live channel not found' }));
    }
    try {
      channel.views = Number(channel.views || 0) + 1;
      const updated = channels.map(ch => ch.id === channel.id ? channel : ch);
      await writeLiveChannels(updated);
    } catch (_) {}
    return res.end(JSON.stringify({ ok: true, channel: { id: channel.id, name: channel.name, category: channel.category, logo: channel.logo, url: channel.stream, backup: channel.backup } }, null, 2));
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

  // Generic external subtitle proxy/converter: /api?subtitle_url=https://...file.srt|vtt|ass
  if (q.subtitle_url) {
    const url = decodeURIComponent(q.subtitle_url);
    try {
      const upstream = await fetch(url, { headers: { 'User-Agent': BROWSER_UA, Referer: REFERER, Origin: ORIGIN, Accept: '*/*' } });
      const text = await upstream.text();
      if (!upstream.ok) throw new Error(`subtitle upstream ${upstream.status}`);
      const clean = /^WEBVTT/i.test(text.trim()) ? text : srtToVtt(text);
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
      res.setHeader('Cache-Control', 'public, max-age=86400, s-maxage=604800');
      return res.end(clean);
    } catch (err) {
      res.statusCode = 502;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      return res.end(JSON.stringify({ ok: false, error: err.message }));
    }
  }

  // Proxy mode: /api?url=...
  if (q.url) {
    const url = decodeURIComponent(q.url);
    try {
      const rangeHeader = req.headers.range || req.headers.Range;
      const upstream = await fetchUpstream(url, 0, rangeHeader ? { Range: rangeHeader } : {});
      const ct = (upstream.headers['content-type'] || '').toLowerCase();
      const isM3u8 = ct.includes('mpegurl') || ct.includes('m3u8') || /\.m3u8?(\?|$)/i.test(url.split('?')[0]);

      if (isM3u8) {
        const chunks = [];
        for await (const chunk of upstream) chunks.push(chunk);
        const body = Buffer.concat(chunks).toString('utf8');
        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        res.setHeader('Access-Control-Allow-Origin','*');
        res.setHeader('Cache-Control','no-store');
        return res.end(rewriteM3u8(body, url));
      } else {
        res.setHeader('Content-Type', ct || 'application/octet-stream');
        res.setHeader('Access-Control-Allow-Origin','*');
        res.setHeader('Accept-Ranges','bytes');
        if (upstream.headers['content-length']) res.setHeader('Content-Length', upstream.headers['content-length']);
        if (upstream.headers['accept-ranges']) res.setHeader('Accept-Ranges', upstream.headers['accept-ranges']);
        if (upstream.headers['content-range']) res.setHeader('Content-Range', upstream.headers['content-range']);
        if (upstream.headers['cache-control']) res.setHeader('Cache-Control', upstream.headers['cache-control']);
        res.statusCode = upstream.statusCode;
        upstream.pipe(res);
      }
    } catch (err) {
      res.statusCode = 502;
      res.end(err.message);
    }
    return;
  }

  // Full media resolver: returns video/audio/subtitle candidates for the player.
  // /api?resolve=1&id=550 OR /api?resolve=1&id=94997&s=1&e=1
  if (q.resolve) {
    if (!q.id) {
      res.statusCode = 400;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      return res.end(JSON.stringify({ ok: false, error: 'missing id' }));
    }
    try {
      const resolved = await getMediaResolve(q.id, q.s, q.e);
      // Keep resolve fast: subtitles are loaded in the background by /api?subtitle_list or /api?subtitle.
      resolved.subtitles = Array.isArray(resolved.subtitles) ? resolved.subtitles : [];
      resolved.subtitleMode = 'background';
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      return res.end(JSON.stringify(resolved, null, 2));
    } catch (err) {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      return res.end(JSON.stringify({ ok: false, error: err.message }));
    }
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
