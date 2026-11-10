// Runs inside GitHub Actions (on every push and every Monday).
// 1. Looks up every title in site/data/catalog.json on TMDB.
// 2. Builds a "fresh" feed: titles TMDB recommends for the films and shows Kris & Prashanth loved,
//    plus this week's trending titles in their favourite genres and languages.
// Writes site/data/tmdb.json. The API key comes from the TMDB_API_KEY repository secret and never reaches the site.
import { readFile, writeFile } from 'node:fs/promises';

const KEY = process.env.TMDB_API_KEY;
const OUT = 'site/data/tmdb.json';
const catalog = JSON.parse(await readFile('site/data/catalog.json', 'utf8'));

if (!KEY) {
  console.warn('TMDB_API_KEY secret is not set — publishing without posters.');
  await writeFile(OUT, JSON.stringify({ updated: null, items: {}, fillers: [], fresh: [] }));
  process.exit(0);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function api(path, params = {}) {
  const url = `https://api.themoviedb.org/3${path}?${new URLSearchParams({ api_key: KEY, ...params })}`;
  for (let tries = 0; tries < 3; tries++) {
    const res = await fetch(url);
    if (res.status === 429) { await sleep(1500); continue; }
    if (!res.ok) return null;
    return res.json();
  }
  return null;
}

// Everything the site shows for one title
async function details(kind, id) {
  const d = await api(`/${kind}/${id}`, { append_to_response: 'images,videos,credits', include_image_language: 'en,null', include_video_language: 'en' });
  if (!d) return null;
  const byVotes = (a, b) => b.vote_average - a.vote_average || b.vote_count - a.vote_count;
  const backdrops = (d.images?.backdrops || []).sort(byVotes).slice(0, 12).map(b => b.file_path);
  if (!backdrops.length && d.backdrop_path) backdrops.push(d.backdrop_path);
  const posters = (d.images?.posters || []).sort(byVotes).map(p => p.file_path).filter(p => p !== d.poster_path).slice(0, 8);
  const logo = (d.images?.logos || []).filter(l => l.iso_639_1 === 'en').sort(byVotes)[0]?.file_path || null;
  const yt = (d.videos?.results || []).filter(v => v.site === 'YouTube');
  const order = { Trailer: 0, Teaser: 1, Clip: 2, Featurette: 3, 'Behind the Scenes': 4 };
  const videos = yt.filter(v => v.type in order).sort((a, b) => order[a.type] - order[b.type] || (b.official - a.official)).slice(0, 8).map(v => ({ key: v.key, name: v.name, type: v.type }));
  const tr = yt.find(v => v.type === 'Trailer' && v.official) || yt.find(v => v.type === 'Trailer') || yt.find(v => v.type === 'Teaser') || yt[0];
  const cast = (d.credits?.cast || []).slice(0, 10).map(c => ({ name: c.name, role: c.character, photo: c.profile_path })).filter(c => c.photo);
  const director = kind === 'movie' ? (d.credits?.crew || []).filter(c => c.job === 'Director').map(c => c.name).slice(0, 2).join(' & ')
    : (d.created_by || []).map(c => c.name).slice(0, 2).join(' & ');
  return {
    tmdb: d.id, type: kind, title: d.title || d.name, poster: d.poster_path, backdrops, posters, logo, trailer: tr?.key || null, videos, cast, director,
    overview: d.overview || '', vote: d.vote_count > 20 ? Math.round(d.vote_average * 10) / 10 : null, votes: d.vote_count,
    year: (d.release_date || d.first_air_date || '').slice(0, 4), lang: d.original_language, genres: (d.genres || []).map(g => g.id),
    runtime: d.runtime || d.episode_run_time?.[0] || null, seasons: d.number_of_seasons || null,
  };
}

// 1. The hand-picked catalog
const items = {}, used = new Set(), tmdbOf = {};
for (const it of catalog) {
  const kind = it.type === 'tv' ? 'tv' : 'movie';
  const yearKey = kind === 'tv' ? 'first_air_date_year' : 'year';
  let list = [];
  if (it.year) list = (await api(`/search/${kind}`, { query: it.q, [yearKey]: it.year, include_adult: 'false' }))?.results || [];
  if (!list.length) list = (await api(`/search/${kind}`, { query: it.q, include_adult: 'false' }))?.results || [];
  const pick = list.find(r => r.original_language === it.lang) || list[0];
  if (!pick) { console.warn('Not found:', it.title); continue; }
  const d = await details(kind, pick.id);
  if (!d) continue;
  items[it.id] = d; used.add(`${kind}:${pick.id}`); tmdbOf[it.id] = { kind, id: pick.id, lang: it.lang };
  console.log('✓', it.title, '→', d.title);
}

// 2. Fresh feed
const LOVED = catalog.filter(c => c.loved).map(c => c.id);
const LIKED_GENRES = new Set([27, 53, 80, 9648, 28, 12, 10759, 10765, 878]);   // comedy is handled via same-industry matches   // horror, thriller, crime, mystery, action, adventure, comedy, sci-fi
const LANGS = new Set(['en', 'hi', 'ta', 'te', 'ml', 'kn', 'ko', 'es', 'de', 'ja']);
const cand = new Map();
const BAD = new Set([10751, 10770, 16, 99, 10762, 10764, 10766, 10767]);   // family, TV movie, animation, documentary, kids, reality, soap, talk
const add = (kind, r, from, w, seedLang) => {
  const g = r.genre_ids || [];
  if (!r.poster_path || r.adult || (r.vote_count || 0) < 250 || (r.vote_average || 0) < 6.4 || !LANGS.has(r.original_language)) return;
  if (g.some(x => BAD.has(x))) return;
  // must share a genre they like, or come from the same film industry as the title they loved
  if (!g.some(x => LIKED_GENRES.has(x)) && r.original_language !== seedLang) return;
  const k = `${kind}:${r.id}`; if (used.has(k)) return;
  const c = cand.get(k) || { kind, id: r.id, score: 0, from: new Set(), src: 'rec', vote: r.vote_average };
  c.score += w; if (from) c.from.add(from); cand.set(k, c);
};
for (const sid of LOVED) {
  const t = tmdbOf[sid]; if (!t) continue;
  for (const r of (await api(`/${t.kind}/${t.id}/recommendations`))?.results || []) add(t.kind, r, sid, 1 + (r.vote_average || 0) / 10, t.lang);
}
for (const kind of ['movie', 'tv']) {
  for (const r of (await api(`/trending/${kind}/week`))?.results || []) {
    if ((r.genre_ids || []).some(g => LIKED_GENRES.has(g)) && (r.vote_average || 0) >= 6.5) { add(kind, r, null, 2.2, null); const c = cand.get(`${kind}:${r.id}`); if (c && !c.from.size) c.src = 'trend'; }
  }
}
const ranked = [...cand.values()].map(c => ({ ...c, rank: c.from.size * 2 + c.score + (c.vote || 0) * .4 })).sort((a, b) => b.rank - a.rank);
const fresh = [];
let tv = 0;
for (const c of ranked) {
  if (fresh.length >= 40) break;
  if (c.kind === 'tv' && tv >= 14) continue;
  const d = await details(c.kind, c.id); if (!d || !d.poster) continue;
  const id = `x${c.kind[0]}${c.id}`;
  items[id] = { ...d, fresh: true, src: c.src, from: [...c.from].slice(0, 3), rank: Math.round(c.rank * 10) / 10 };
  fresh.push(id); used.add(`${c.kind}:${c.id}`); if (c.kind === 'tv') tv++;
}

// 3. Popular posters to fill the rest of the wall
const fillers = [];
for (const [kind, page] of [['movie', 1], ['movie', 2], ['tv', 1], ['movie', 3]]) {
  for (const r of (await api(`/trending/${kind}/week`, { page }))?.results || []) {
    if (r.poster_path && !used.has(`${kind}:${r.id}`)) { fillers.push(r.poster_path); used.add(`${kind}:${r.id}`); }
  }
}

// 4. "Buzzing" list: titles picked weekly by Claude's scout (site/data/buzz-titles.json), resolved to TMDB posters here.
try {
  const bt = JSON.parse(await readFile('site/data/buzz-titles.json', 'utf8')), out = [];
  for (const b of bt.items || []) {
    const kind = b.kind === 'tv' ? 'tv' : 'movie', yk = kind === 'tv' ? 'first_air_date_year' : 'year';
    let list = (await api(`/search/${kind}`, { query: b.title, ...(b.year ? { [yk]: b.year } : {}), include_adult: 'false' }))?.results || [];
    if (!list.length) list = (await api(`/search/${kind}`, { query: b.title, include_adult: 'false' }))?.results || [];
    const r = list.find(x => x.poster_path); if (!r) { console.warn('Buzz not found:', b.title); continue; }
    out.push({ id: r.id, kind, title: r.title || r.name, year: (r.release_date || r.first_air_date || '').slice(0, 4), poster: r.poster_path,
      vote: r.vote_count > 20 ? Math.round(r.vote_average * 10) / 10 : null, genres: r.genre_ids || [], lang: r.original_language, overview: (r.overview || '').slice(0, 240) });
  }
  await writeFile('site/data/buzz.json', JSON.stringify({ updated: bt.updated || '', items: out }));
  console.log(`Buzz: ${out.length} titles.`);
} catch (e) { console.warn('No buzz list yet.'); }

await writeFile(OUT, JSON.stringify({ updated: new Date().toISOString(), items, fresh, fillers: fillers.slice(0, 30) }));
console.log(`Wrote ${Object.keys(items).length - fresh.length}/${catalog.length} catalog titles, ${fresh.length} fresh picks, ${Math.min(fillers.length, 30)} wall fillers.`);
