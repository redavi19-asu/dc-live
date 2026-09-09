# DC Live

Static viewer front end for DC Live.

This repository is intentionally separated from `dc-live-backend`, which contains the Cloudflare Worker API, D1 database integration, R2 media handling, viewer auth, payments, entitlements, and protected playback.

## GitHub Pages

Every push to `main` runs the Pages deployment workflow.

Expected Pages URL:

`https://redavi19-asu.github.io/dc-live/`

## Structure

- `index.html` — viewer landing page
- `styles.css` — responsive visual design
- `app.js` — front-end behavior
- `.github/workflows/pages.yml` — GitHub Pages deployment
