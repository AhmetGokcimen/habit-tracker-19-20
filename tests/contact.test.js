'use strict';

// Contact page smoke tests.
// Contact details remain placeholders until verified.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { request, createApp } = require('./helpers');

const contactHtml = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'contact.html'),
  'utf8'
);

test('contact page is served successfully', async () => {
  const res = await request(createApp()).get('/contact.html');

  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /text\/html/);
  assert.match(res.text, /Contact · Habit Tracker/);
});

test('contact page contains email, phone and office sections', () => {
  assert.match(contactHtml, /<h3>Email Us<\/h3>/);
  assert.match(contactHtml, /<h3>Call Us<\/h3>/);
  assert.match(contactHtml, /<h3>Office Location<\/h3>/);

  // Unverified contact details must remain placeholders.
  assert.match(contactHtml, /Contact email to be confirmed/);
  assert.match(contactHtml, /Phone number to be confirmed/);
  assert.match(contactHtml, /Office address to be confirmed/);
});

test('contact navigation and page initialization are configured', () => {
  const shell = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'js', 'shell.js'),
    'utf8'
  );

  const contactJs = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'js', 'pages', 'contact.js'),
    'utf8'
  );

  assert.match(
    shell,
    /href:\s*['"]\/contact\.html['"],\s*label:\s*['"]Contact['"]/
  );

  assert.match(
    contactHtml,
    /src="\/js\/pages\/contact\.js"/
  );

  assert.match(
    contactJs,
    /initPage\(\{\s*active:\s*'contact'\s*\}\)/
  );
});
