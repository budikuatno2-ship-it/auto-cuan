'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'public', 'landing-experience.css'), 'utf8');

const landingStart = html.indexOf('<section id="landingPage"');
const landingEnd = html.indexOf('<!-- AUTH CHOICE MODAL -->');
const landingHtml = html.slice(landingStart, landingEnd);

test('Landing hero features spotlight candle SVG background and Si Mata mascot', () => {
  assert.match(landingHtml, /id="lp-spot"/);
  assert.match(landingHtml, /id="lpMataWrap"/);
  assert.match(landingHtml, /id="lpMataBtn"/);
  assert.match(landingHtml, /id="lpMataBub"/);
  assert.match(landingHtml, /id="lpMataMini"/);
  assert.match(landingHtml, /acPokeHeroMata/);
  assert.match(landingHtml, /acHideHeroMata/);
  assert.match(landingHtml, /acShowHeroMata/);
});

test('Feature tape spans across page and pauses on hover/focus', () => {
  assert.match(landingHtml, /class="tape"/);
  assert.match(landingHtml, /class="tape-in"/);
  assert.match(landingHtml, /Screener 3 mode/);
  assert.match(landingHtml, /Bandarmologi/);
  assert.match(landingHtml, /Broker Hunter/);
  assert.match(landingHtml, /Jejaring Insider/);
  assert.match(landingHtml, /Chart Workstation/);
  assert.match(landingHtml, /Rentang wajar 10 hari/);
  assert.match(landingHtml, /Portfolio &amp; Risk Lab/);
  assert.match(landingHtml, /Kelola Keuangan/);
  assert.match(css, /\.tape:hover \.tape-in, #landingPage \.tape:focus-within \.tape-in\s*\{\s*animation-play-state:\s*paused;/);
});

test('Statistics bar presents 4 truthful metrics from verifiable sources', () => {
  assert.match(landingHtml, /class="stats"/);
  assert.match(landingHtml, /<b>963<\/b><span>emiten dengan candle harian/);
  assert.match(landingHtml, /<b>500<\/b><span>sesi riwayat per emiten/);
  assert.match(landingHtml, /<b>2\.907<\/b><span>sampel uji walk-forward/);
  assert.match(landingHtml, /<b>77%<\/b><span>harga 10 hari kemudian/);
});

test('Interactive calculator in section 02B calculates lots, risk, and 10-day reasonable range', () => {
  assert.match(landingHtml, /id="landingCalculatorWrap"/);
  assert.match(landingHtml, /id="lpCalcModal"/);
  assert.match(landingHtml, /id="lpCalcRisk"/);
  assert.match(landingHtml, /id="lpCalcLots"/);
  assert.match(landingHtml, /class="fillbar"/);
  assert.match(landingHtml, /class="rng-bar"/);
  assert.match(landingHtml, /acUpdateLandingCalc/);
  assert.match(html, /function showLandingPage/);
  assert.match(html, /window\.acUpdateLandingCalc\(\)/);
});

test('Zero em dashes (—) and clean anti-slop copy across the entire landing page', () => {
  assert.equal(landingHtml.match(/—/g), null, 'Landing page must not contain em dash (—)');
  assert.doesNotMatch(landingHtml, /\bAI Powered\b/i);
  assert.doesNotMatch(landingHtml, /\bSeamless\b/i);
  assert.doesNotMatch(landingHtml, /\bRevolutionary\b/i);
  assert.doesNotMatch(landingHtml, /Masuk dengan Google/);
});

test('Reduced motion and mobile responsiveness rules are strictly respected', () => {
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{[\s\S]*#landingPage \.spot\s*\{[\s\S]*display:\s*none/);
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{[\s\S]*#landingPage \.tape-in\s*\{[\s\S]*animation:\s*none/);
  assert.match(css, /@media\s*\(max-width:\s*980px\)\s*\{[\s\S]*#landingPage \.stats\s*\{[\s\S]*grid-template-columns:\s*repeat\(2,/);
});
