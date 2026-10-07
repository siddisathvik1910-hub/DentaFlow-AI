# Website launch checklist: where each item lives and how it is verified

Run everything with `npm test` (automated tests) and `npm run audit-site` (link, contrast, secret and speed audits).
"Verified" means an automated test or script checks it. Items marked *manual* need a human check on your real domain.

| # | Item | Implementation | Verified by |
|---|---|---|---|
| 1 | Privacy policy page | `/privacy` (`web/pages/privacy.html`). Covers roles (controller vs. processor/business associate), data categories, AI and recordings, retention, rights (GDPR/CCPA), transfers. | `test/site.test.js` (exists, linked on every page). *Manual:* lawyer review; set `COMPANY_*` in `.env`. |
| 2 | Terms and conditions page | `/terms` (`web/pages/terms.html`). Includes "not medical advice / call 911", customer consent responsibilities, BAA, liability, governing law. | same. *Manual:* lawyer review. |
| 3 | Secrets off the frontend | All keys read from `.env` by `server/config.js`; browser only receives `/api/public/config` (4 whitelisted public values). `.env` and `data/` are git-ignored and never served. Dev secrets auto-generated into `data/.dev-secrets.json`. | `npm run scan-secrets`; `test/web.test.js` ("secrets stay on the server"). |
| 4 | Force HTTPS | `server/middleware/security.js`: 301 redirect to https, HSTS (2 years), `upgrade-insecure-requests` in CSP. On by default in production; localhost exempt; `/healthz` exempt for probes. Respects `X-Forwarded-Proto` (`TRUST_PROXY`). | `test/web.test.js` ("HTTPS is forced"). *Manual:* confirm on your real domain behind your TLS proxy. |
| 5 | Cookie statement banner | Banner on every public page (`web/partials/cookie-banner.html`, `web/js/consent.js`): Accept analytics / Essential only with equal prominence, remembered 12 months, re-openable from the footer. Cookie Statement at `/cookies` lists every cookie/storage key. Analytics loads only after consent; withdrawing consent clears IDs. | `test/site.test.js`; jsdom UI test (no beacon before consent, none after declining). |
| 6 | Meta titles and descriptions | Per-page registry in `server/pages.js`; unique titles (20-70 chars) and descriptions (70-175 chars), canonical URL, robots, JSON-LD on home. | `test/site.test.js`. |
| 7 | Social media preview | Open Graph + Twitter Card tags with 1200x630 `og-image.png` (16 KB) and alt text (`web/partials/head.html`). | `test/site.test.js` (tags present, image dimensions and size). *Manual:* paste your URL into the LinkedIn / Facebook sharing debuggers. |
| 8 | Compress images | PNG optimised + palette-quantised, SVG for illustrations, WebP social image; size budgets enforced. Regenerate with `python3 scripts/make-images.py`. | `test/site.test.js` (per-file size budgets). |
| 9 | Favicon | `favicon.ico` (16/32/48), PNG 16/32, apple-touch-icon 180, PWA icons 192/512, `site.webmanifest`, `theme-color`. | `test/site.test.js` (linked and served). |
| 10 | Sitemap + robots.txt | Generated dynamically from the page registry (`/sitemap.xml`, `/robots.txt`); private pages (`/app`, `/login`, `/api`) disallowed and sent `X-Robots-Tag: noindex`. | `test/site.test.js`. *Manual:* submit sitemap in Google Search Console. |
| 11 | Alt text | Every `<img>` has `alt` (descriptive for the hero, empty for decorative logos); SVG icons are `aria-hidden`. | `test/site.test.js` scans every page. |
| 12 | Page-load speed | System fonts (no font requests), one CSS file, scripts deferred, gzip, cache headers (images 7 days immutable), preloaded CSS, `fetchpriority` on hero, explicit image sizes. ~20 KB transferred for the home page. | `npm run perf`; `test/site.test.js` budgets. *Manual:* run Lighthouse (`npx lighthouse <url>`) on your real host. |
| 13 | Mobile friendly | Responsive CSS (900px / 520px breakpoints), viewport tag, collapsible nav, 44-48px tap targets, full-width CTA on phones, dashboard sidebar collapses. | `test/site.test.js` (CSS rules). *Manual:* check on a real phone. |
| 14 | Custom 404 | Branded page with a way home, real `404` status, `no-store`. JSON 404 for `/api/*`. | `test/site.test.js`. |
| 15 | Fix broken links | `npm run check-links` crawls all pages, assets and in-page `#anchors`; test suite runs the same crawl. | `npm run check-links`; `test/site.test.js`. |
| 16 | Form validation | Demo form: labelled fields, inline accessible errors (`aria-invalid`, `aria-describedby`), focus moved to first error, plus identical server-side validation with zod. Dashboard forms validate too. | `test/web.test.js`; jsdom UI test. |
| 17 | Color contrast | Palette defined as CSS variables; `scripts/check-contrast.js` computes WCAG ratios for 48 text/background pairs (all >= 4.5:1; UI components >= 3:1). Visible focus rings, reduced-motion support, skip link. | `npm run check-contrast`; `test/site.test.js`. *Manual:* screen-reader pass. |
| 18 | Spam / bot protection | Hidden honeypot field, signed form token with minimum fill time (3 s) and expiry, per-IP rate limits (forms, chat, login, API), account lockout, duplicate suppression, optional Cloudflare Turnstile (`TURNSTILE_*`). | `test/web.test.js`. |
| 19 | Analytics | Consent-gated first-party analytics (no cookies, no IPs, bots excluded) plus optional GA4 / Plausible by ID. CSP allows those hosts only when configured. | `test/web.test.js`, jsdom UI test. |
| 20 | One clear call to action | A single primary action, "Book a free demo", repeated identically in header, hero and form; one `<h1>`. | `test/site.test.js`. |

## Extra hardening included
Strict Content-Security-Policy (no inline scripts or styles), clickjacking protection, CSRF defence (custom header + origin check),
bcrypt password hashing, optional TOTP two-step sign-in, role-based access, tenant isolation, field-level AES-256-GCM encryption of
patient identifiers, audit log of PHI views, SSRF-safe website importer, CSV formula-injection protection, Twilio signature verification.
