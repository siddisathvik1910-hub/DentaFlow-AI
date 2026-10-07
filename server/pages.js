// Page registry + tiny template engine. One place defines every public page's title, meta description,
// robots rule, canonical URL, and sitemap entry (SEO items 6, 7, 10).
const fs = require('fs');
const path = require('path');
const cfg = require('./config');

const WEB = path.join(__dirname, '..', 'web');
const PAGES = [
  { path: '/', file: 'index', title: 'DentaFlow AI: The AI Front Desk for Dental Clinics',
    description: 'DentaFlow AI answers every call and text for your dental practice 24/7, books appointments straight into your schedule and cuts no-shows. Book a free demo.',
    sitemap: true, priority: '1.0', changefreq: 'weekly' },
  { path: '/privacy', file: 'privacy', title: 'Privacy Policy | DentaFlow AI',
    description: 'How DentaFlow AI collects, uses, protects and shares information, including patient data handled for dental practices, and your privacy choices.',
    sitemap: true, priority: '0.3', changefreq: 'yearly' },
  { path: '/terms', file: 'terms', title: 'Terms and Conditions | DentaFlow AI',
    description: 'The terms that govern use of the DentaFlow AI website and AI front-desk service for dental practices.',
    sitemap: true, priority: '0.3', changefreq: 'yearly' },
  { path: '/cookies', file: 'cookies', title: 'Cookie Statement | DentaFlow AI',
    description: 'Which cookies DentaFlow AI uses, why we use them, and how to accept, decline or change your cookie choices at any time.',
    sitemap: true, priority: '0.2', changefreq: 'yearly' },
  { path: '/login', file: 'login', title: 'Sign in | DentaFlow AI Dashboard', description: 'Sign in to the DentaFlow AI staff dashboard.', sitemap: false, noindex: true },
  { path: '/app', file: 'app', title: 'Dashboard | DentaFlow AI', description: 'DentaFlow AI staff dashboard.', sitemap: false, noindex: true, app: true },
];
const NOT_FOUND = { path: '/404', file: '404', title: 'Page not found | DentaFlow AI', description: 'The page you are looking for does not exist.', noindex: true };

const cache = new Map();
const read = (rel) => {
  if (cfg.isProd && cache.has(rel)) return cache.get(rel);
  const txt = fs.readFileSync(path.join(WEB, rel), 'utf8');
  if (cfg.isProd) cache.set(rel, txt);
  return txt;
};
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function render(page, extra = {}) {
  const vars = {
    title: esc(page.title), description: esc(page.description), canonical: `${cfg.baseUrl}${page.path === '/404' ? '/' : page.path}`,
    robots: page.noindex ? 'noindex, nofollow' : 'index, follow, max-image-preview:large', base_url: cfg.baseUrl,
    og_image: `${cfg.baseUrl}/img/og-image.png`, company_name: esc(cfg.company.name), company_email: esc(cfg.company.email),
    company_address: esc(cfg.company.address), jurisdiction: esc(cfg.company.jurisdiction), year: new Date().getFullYear(),
    updated: 'October 1, 2026',
    legal_notice: cfg.isProd ? '' : '<p class="notice"><strong>Template notice (shown only in development):</strong> this page is a starting template, not legal advice. Have a qualified attorney review it and set the COMPANY_* values in .env before launch.</p>',
    ...extra,
  };
  let html = read(`pages/${page.file}.html`);
  html = html.replace(/\{\{>\s*([\w-]+)\s*\}\}/g, (_, name) => read(`partials/${name}.html`));
  return html.replace(/\{\{\s*([\w]+)\s*\}\}/g, (m, k) => (vars[k] !== undefined ? vars[k] : m));
}

function sitemapXml() {
  const urls = PAGES.filter((p) => p.sitemap).map((p) => `  <url>\n    <loc>${cfg.baseUrl}${p.path === '/' ? '/' : p.path}</loc>\n    <changefreq>${p.changefreq}</changefreq>\n    <priority>${p.priority}</priority>\n  </url>`);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>\n`;
}
function robotsTxt() {
  return `User-agent: *\nAllow: /\nDisallow: /app\nDisallow: /login\nDisallow: /api/\nDisallow: /webhooks/\n\nSitemap: ${cfg.baseUrl}/sitemap.xml\n`;
}

module.exports = { PAGES, NOT_FOUND, render, sitemapXml, robotsTxt };
