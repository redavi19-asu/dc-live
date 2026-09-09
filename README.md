# DC Live backend

Separate Cloudflare backend for DC Live events, payments, rentals, entitlements, and protected playback.

## Secrets

Set these with `wrangler secret put`:

- `ADMIN_API_KEY`
- `PLAYBACK_SIGNING_KEY`
- `STRIPE_SECRET_KEY` (test key until launch)
- `STRIPE_WEBHOOK_SECRET` (test endpoint until launch)

Never commit secret values. Stripe Checkout stays unavailable until its two secrets are configured.

## Commands

```sh
npm install
npm run types
npm run check
npx wrangler d1 migrations apply dc-live-db --remote
npm run deploy
```

The public API supports event listings, viewer registration/login, Stripe Checkout, entitlement checks, protected HLS proxying, and R2-backed artwork. Administrative event and artwork routes require `X-Admin-Key`.
