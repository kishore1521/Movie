// Runs inside GitHub Actions. Looks up every title in site/data/catalog.json on TMDB and
// writes site/data/tmdb.json (poster + still paths, trailer key, TMDB score).
// The API key comes from the TMDB_API_KEY repository secret and is never written to the site.
import { readFile, writeFile } from 'node:fs/promises';

const KEY = process.env.TMDB_API_KEY;
const OUT = 'site/data/tmdb.json';
const catalog = JSON.parse(await readFile('site/data/catalog.json', 'utf8'));

if (!KEY) {
  console.warn('TMDB_API_KEY secret is not set — publishing without posters.');
  await writeFile(OUT, JSON.stringify({ updated: null, items: {}, fillers: [] }));
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

const items = {}, used = new Set();
for (const it of catalog) {
  const kind = it.type === 'tv' ? 'tv' : 'movie';
  const yearKey = kind === 'tv' ? 'first_air_date_year' : 'year';
  let list = [];
  if (it.year) list = (await api(`/search/${kind}`, { query: it.q, [yearKey]: it.year, include_adult: 'false' }))?.results || [];
  if (!list.length) list = (await api(`/search/${kind}`, { query: it.q, include_adult: 'false' }))?.results || [];
  const pick = list.find(r => r.original_language === it.lang) || list[0];
  if (!pick) { console.warn('Not found:', it.title); continue; }
  const d = await api(`/${kind}/${pick.id}`, { append_to_response: 'images,videos', include_image_language: 'en,null', include_video_language: 'en' });
  if (!d) continue;
  const backdrops = (d.images?.backdrops || []).sort((a, b) => b.vote_average - a.vote_average).slice(0, 6).map(b => b.file_path);
  if (!backdrops.length && d.backdrop_path) backdrops.push(d.backdrop_path);
  const vids = (d.videos?.results || []).filter(v => v.site === 'YouTube');
  const tr = vids.find(v => v.type === 'Trailer' && v.official) || vids.find(v => v.type === 'Trailer') || vids.find(v => v.type === 'Teaser') || vids[0];
  items[it.id] = { tmdb: pick.id, type: kind, title: d.title || d.name, poster: d.poster_path, backdrops, trailer: tr?.key || null,
    vote: d.vote_count > 20 ? Math.round(d.vote_average * 10) / 10 : null };
  used.add(`${kind}:${pick.id}`);
  console.log('✓', it.title, '→', items[it.id].title);
}

// Popular titles to fill the rest of the poster wall
const fillers = [];
for (const [kind, page] of [['movie', 1], ['movie', 2], ['tv', 1], ['movie', 3]]) {
  for (const r of (await api(`/trending/${kind}/week`, { page }))?.results || []) {
    if (r.poster_path && !used.has(`${kind}:${r.id}`)) { fillers.push(r.poster_path); used.add(`${kind}:${r.id}`); }
  }
}

await writeFile(OUT, JSON.stringify({ updated: new Date().toISOString(), items, fillers: fillers.slice(0, 40) }));
console.log(`Wrote ${Object.keys(items).length}/${catalog.length} titles and ${Math.min(fillers.length, 40)} wall fillers.`);
