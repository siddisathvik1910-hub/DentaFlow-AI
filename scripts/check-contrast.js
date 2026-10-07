#!/usr/bin/env node
// WCAG 2.1 AA contrast check for every text/background pairing used in the site and dashboard.
// Reads the CSS variables from web/css/site.css so a palette change that breaks contrast fails the build.
const fs = require('fs');
const path = require('path');
const css = fs.readFileSync(path.join(__dirname, '..', 'web/css/site.css'), 'utf8');
const V = {};
for (const m of css.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6})/g)) V[m[1]] = m[2];
const c = (x) => (x.startsWith('#') ? x : V[x]);
const lum = (hex) => { const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4))); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const ratio = (a, b) => { const [x, y] = [lum(c(a)), lum(c(b))].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

// [foreground, background, description, minimum ratio]  (4.5 normal text, 3 for large text / UI components)
const PAIRS = [
  ['ink', 'bg', 'Body text'], ['ink', 'soft', 'Body text on soft sections'], ['muted', 'bg', 'Secondary text'], ['muted', 'soft', 'Secondary text on soft'],
  ['brand', 'bg', 'Links'], ['brand', 'soft', 'Links on soft'], ['#ffffff', 'brand', 'Primary button'], ['#ffffff', 'brand-dark', 'Primary button hover'],
  ['brand', '#ffffff', 'Ghost button text'], ['teal', 'bg', 'Eyebrow text'], ['teal', 'soft', 'Eyebrow on soft'], ['#ffffff', 'teal', 'Chat launcher'], ['#ffffff', '#095755', 'Chat launcher hover'],
  ['on-dark', 'dark', 'Text on dark sections'], ['#ffffff', 'dark', 'Headings on dark'], ['#bcd8f5', 'dark', 'Links on dark sections'], ['#cfe4fa', 'dark', 'Footer links'], ['#bcd0e4', 'dark', 'Footer legal text'],
  ['on-dark', '#16344f', 'Card text on dark'], ['#9fd0ff', '#16344f', 'Icon on dark card', 3],
  ['danger', 'bg', 'Error text'], ['ok', 'bg', 'Success text'], ['#ffffff', 'danger', 'Danger button / badge'],
  ['#7a1a14', '#fdecea', 'Error banner'], ['#0f4d22', '#e6f4ea', 'Success banner'], ['#5a4300', '#fff8e1', 'Notice banner'], ['#0a3d70', '#e6f0fa', 'Info banner'], ['#5a4300', '#fff4d6', 'Warning banner'],
  ['#26394d', '#e8eef5', 'Neutral tag'], ['#0f4d22', '#dff3e4', 'OK tag'], ['#6b4300', '#fdf0d2', 'Warn tag'], ['#7a1a14', '#fde2df', 'Bad tag'], ['#0a3d70', '#dcebfa', 'Info tag'], ['#0a3d70', '#e3edf7', 'Header pill'],
  ['#ffffff', 'brand', 'Active nav item / patient bubble'], ['ink', '#eef3f8', 'Agent bubble'], ['ink', '#f6f9fc', 'Chat log text'], ['#e3edf7', '#0f2740', 'Trace block'], ['#ffb4ad', '#0f2740', 'Trace error'],
  ['muted', '#f8fafc', 'Table header'], ['#14212f', '#f3f8fd', 'Table row hover'], ['ink', '#fff8e1', 'Callouts'],
  ['#0b4f4e', '#e3f4f3', 'Hero illustration booked card'], ['#ffffff', '#0e6b6a', 'Hero illustration header'], ['#cfe0f2', '#0f2740', 'Hero illustration dark card'],
  ['brand', '#e3edf7', 'Brand text on pill background'], ['brand', 'bg', 'Focus ring on light backgrounds (UI component)', 3], ['focus', 'dark', 'Focus ring on dark backgrounds (UI component)', 3],
];
let failed = 0;
console.log('Contrast check (WCAG 2.1 AA)\n');
for (const [fg, bg, label, min = 4.5] of PAIRS) {
  if (!c(fg) || !c(bg)) { console.log('??  unknown colour for', label); failed++; continue; }
  const r = ratio(fg, bg); const ok = r >= min;
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${r.toFixed(2).padStart(5)}:1  (need ${min})  ${label}  [${c(fg)} on ${c(bg)}]`);
}
console.log(failed ? `\n${failed} pair(s) fail WCAG AA.` : `\nAll ${PAIRS.length} pairs pass WCAG AA.`);
process.exit(failed ? 1 : 0);
