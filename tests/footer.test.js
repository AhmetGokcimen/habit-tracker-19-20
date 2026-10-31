'use strict';

// Footer structure and navigation tests.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const shell = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'shell.js'),
  'utf8'
);

test('shared footer is initialized on application pages', () => {
  // The footer should be managed centrally.
  assert.match(shell, /function renderFooter\(\)/);

  // Avoid creating duplicate footers.
  assert.match(
    shell,
    /document\.getElementById\('site-footer'\)/
  );

  // Initialize the footer after the top navigation.
  assert.match(
    shell,
    /renderTopbar\(user,\s*active\);\s*renderFooter\(\);/
  );
});

test('footer provides product and contact navigation', () => {
  const footerStart = shell.indexOf('function renderFooter()');

  assert.ok(footerStart !== -1);

  const footerCode = shell.slice(footerStart);

  // Verify the main footer links.
  for (const href of [
    '/explore.html',
    '/subscription.html',
    '/challenges.html',
    '/contact.html',
  ]) {
    assert.ok(
      footerCode.includes(`href: '${href}'`),
      `Missing footer link: ${href}`
    );
  }

  // Check semantic and accessible structure.
  assert.match(footerCode, /class:\s*'site-footer'/);
  assert.match(footerCode, /aria-label': 'Footer product links'/);
  assert.match(footerCode, /aria-label': 'Footer company links'/);
});

test('footer supports responsive mobile layouts', () => {
  const css = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'css', 'app.css'),
    'utf8'
  );

  const mobileCss = css.slice(
    css.indexOf('/* Footer: responsive layout for tablets and mobile */')
  );

  // Verify tablet and mobile breakpoints.
  assert.match(mobileCss, /@media\s*\(max-width:\s*760px\)/);
  assert.match(mobileCss, /@media\s*\(max-width:\s*420px\)/);

  // Brand and navigation should stack vertically.
  assert.match(
    mobileCss,
    /\.site-footer-inner\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/
  );

  // Product and Company should use two columns.
  assert.match(
    mobileCss,
    /\.footer-links\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/
  );

  // Legal section should occupy its own row.
  assert.match(
    mobileCss,
    /\.footer-legal\s*\{[^}]*grid-column:\s*1\s*\/\s*-1/
  );
});

test('footer includes accessible Privacy Policy and Terms of Use links', () => {
  const footerCode = shell.slice(
    shell.indexOf('function renderFooter()')
  );

  // Verify Legal navigation is accessible.
  assert.match(
    footerCode,
    /'aria-label': 'Footer legal links'/
  );

  // Verify both legal pages are linked.
  assert.match(footerCode, /href: '\/privacy\.html'/);
  assert.match(footerCode, /href: '\/terms\.html'/);

  // Verify placeholder text has been removed.
  assert.doesNotMatch(
    footerCode,
    /Legal pages coming soon/
  );
});

test('footer links use coral underline on hover', () => {
  const css = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'css', 'app.css'),
    'utf8'
  );

  // Check hover underline styling.
  assert.match(
    css,
    /\.footer-links a:hover\s*\{[^}]*text-decoration-color:\s*#ff5e3a;/
  );
});
