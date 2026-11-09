# Next Frame

Film and show picks for Kris & Prashanth — a scroll-driven 3D poster wall with swipe-to-sort.

**Live site:** https://kishore1521.github.io/Movie/

## How it works
- `site/index.html` — the whole site (Three.js, loaded from a CDN).
- `site/data/catalog.json` — every pick and every "loved" title, with lookup hints.
- `scripts/fetch-tmdb.mjs` — runs in GitHub Actions, looks each title up on TMDB and writes
  `site/data/tmdb.json` (poster and still paths, trailer IDs, TMDB scores).
- `.github/workflows/deploy.yml` — builds and publishes to GitHub Pages on every push and every Monday.

The TMDB key lives only in the `TMDB_API_KEY` repository secret. It is never committed or shipped to the browser.

Swipes are saved in each browser (localStorage).

_This product uses the TMDB API but is not endorsed or certified by TMDB._
