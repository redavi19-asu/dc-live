# DC Live

Viewer front end for DC Live, deployed through Cloudflare Pages.

The backend remains isolated in `redavi19-asu/dc-live-backend` and owns the Cloudflare Worker API, D1 data, R2 media, viewer auth, Stripe checkout, entitlements, and protected playback.

## Frontend → backend connection

Set the Worker origin once in `config.js`:

```js
window.DC_LIVE_CONFIG = {
  apiBase: "https://dc-live-api.<your-workers-dev-subdomain>.workers.dev"
};
```

The frontend is already wired to:

- `GET /health`
- `GET /api/events`
- `GET /api/events/:slug`
- `POST /api/auth/register`
- `POST /api/auth/login`
- `POST /api/auth/logout`
- `GET /api/auth/me`
- `GET /api/library`
- `POST /api/events/:slug/checkout`
- `POST /api/events/:slug/playback`
- protected `/media/...` playback URLs

For temporary testing, open the Pages site once with `?api=https://YOUR-WORKER-URL`; the value is stored locally and the query string is removed.

## Deployment

Cloudflare Pages should deploy the `main` branch of this repository.

The backend currently allows the front-end origin `https://dc-live.pages.dev` through `APP_ORIGIN`.
