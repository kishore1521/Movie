// Next Frame sync + discover Worker. Paste into the Cloudflare Worker editor.
// Needs: KV binding NF, and a secret named TMDB_KEY (your TMDB v3 API key).
const ORIGIN = "https://kishore1521.github.io";
const cors = {
  "Access-Control-Allow-Origin": ORIGIN,
  "Access-Control-Allow-Methods": "GET,PUT,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type,X-Pass",
};
const sha = async s => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))].map(b => b.toString(16).padStart(2, "0")).join("");
const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
const clean = s => (s || "").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 20);

async function tmdb(env, path, params = {}) {
  const u = new URL("https://api.themoviedb.org/3" + path);
  const key = (env.TMDB_KEY || "").trim();
  const headers = { Accept: "application/json" };
  if (key.startsWith("eyJ")) headers.Authorization = "Bearer " + key; // v4 read-access token
  else u.searchParams.set("api_key", key); // v3 API key
  for (const k in params) u.searchParams.set(k, params[k]);
  const r = await fetch(u, { headers, cf: { cacheTtl: 3600, cacheEverything: true } });
  tmdb.last = r.status;
  return r.ok ? r.json() : null;
}
const slim = (x, kind) => ({
  id: x.id, kind: kind || x.media_type, title: x.title || x.name,
  year: (x.release_date || x.first_air_date || "").slice(0, 4), poster: x.poster_path,
  vote: x.vote_count > 20 ? Math.round(x.vote_average * 10) / 10 : null,
  genres: x.genre_ids || (x.genres || []).map(g => g.id), lang: x.original_language,
  overview: (x.overview || "").slice(0, 240),
});

export default {
  async fetch(req, env) {
    if (req.method === "OPTIONS") return new Response(null, { headers: cors });
    const url = new URL(req.url);
    const path = url.pathname;

    // ---- TMDB-backed helpers (no passcode; only our site's origin) ----
    if (path === "/search" || path === "/recs") {
      const o = req.headers.get("Origin");
      if (o && o !== ORIGIN) return J({ error: "forbidden" }, 403);
      if (!env.TMDB_KEY) return J({ error: "no key" }, 501);
      if (path === "/search") {
        const q = (url.searchParams.get("q") || "").trim().slice(0, 80);
        if (q.length < 2) return J({ results: [] });
        const d = await tmdb(env, "/search/multi", { query: q, include_adult: "false" });
        if (!d) return J({ results: [], error: "TMDB said " + tmdb.last + ". Check the TMDB_KEY secret." }, 502);
        const results = (d.results || []).filter(x => (x.media_type === "movie" || x.media_type === "tv") && x.poster_path).slice(0, 18).map(x => slim(x));
        return J({ results });
      }
      const ids = (url.searchParams.get("ids") || "").split(",").slice(0, 6).map(s => s.split(":")).filter(a => (a[0] === "movie" || a[0] === "tv") && /^\d+$/.test(a[1]));
      if (!ids.length) return J({ results: [] });
      const have = new Set(ids.map(a => a[0] + ":" + a[1]));
      const lists = await Promise.all(ids.map(a => tmdb(env, `/${a[0]}/${a[1]}/recommendations`)));
      const score = new Map();
      lists.forEach((l, li) => ((l && l.results) || []).slice(0, 20).forEach((x, i) => {
        const kind = ids[li][0]; const key = kind + ":" + x.id;
        if (have.has(key) || !x.poster_path || x.vote_count < 150 || x.vote_average < 6.3) return;
        const cur = score.get(key) || { x, kind, n: 0, s: 0 };
        cur.n++; cur.s += (20 - i) / 20 + x.vote_average / 10; score.set(key, cur);
      }));
      const results = [...score.values()].sort((a, b) => b.s - a.s).slice(0, 24).map(c => ({ ...slim(c.x, c.kind), n: c.n }));
      return J({ results });
    }

    // ---- Read-only public list of someone (for Versus) ----
    const pub = clean(url.searchParams.get("pub"));
    if (pub && req.method === "GET") {
      const rec = JSON.parse((await env.NF.get("pub:" + pub)) || "null");
      return J({ exists: !!rec, data: rec });
    }

    // ---- Personal list: name + passcode ----
    const u = clean(url.searchParams.get("u"));
    const pass = req.headers.get("X-Pass") || "";
    if (!u || pass.length < 4) return J({ error: "bad request" }, 400);
    const rec = JSON.parse((await env.NF.get(u)) || "null");
    const h = await sha(u + ":" + pass);
    if (rec && rec.h !== h) return J({ error: "wrong passcode" }, 403);
    if (req.method === "GET") return J({ exists: !!rec, data: rec ? rec.data : null });
    if (req.method === "PUT") {
      const body = await req.text();
      if (body.length > 400000) return J({ error: "too big" }, 413);
      const data = JSON.parse(body);
      await env.NF.put(u, JSON.stringify({ h, data }));
      await env.NF.put("pub:" + u, JSON.stringify({ map: data.map || {}, custom: data.custom || {}, t: Date.now() }));
      return J({ ok: true });
    }
    return J({ error: "method" }, 405);
  },
};
