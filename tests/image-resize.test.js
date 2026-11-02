'use strict';

// public/js/image.js: the browser-side photo shrinking. The canvas and image
// decoding are replaced by fakes here; the logic around them is what is tested.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const fs = require('node:fs');
const path = require('node:path');

// The frontend is ES modules while this package is CommonJS, so the file is
// loaded as a module from its source (it has no imports of its own).
const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'image.js'), 'utf8');
const load = () => import(`data:text/javascript;charset=utf-8,${encodeURIComponent(SOURCE)}`);
const file = (size, name = 'IMG_1234.PNG', type = 'image/png') => new File([new Uint8Array(size)], name, { type });
const fakeImage = (width, height) => ({ width, height, closed: false, close() { this.closed = true; } });

describe('fitWithin', () => {
  test('scales the long edge down to 1280 px and keeps the aspect ratio', async () => {
    const { fitWithin } = await load();
    assert.deepEqual(fitWithin(4032, 3024), { width: 1280, height: 960 });
    assert.deepEqual(fitWithin(3024, 4032), { width: 960, height: 1280 });
    assert.deepEqual(fitWithin(1280, 720), { width: 1280, height: 720 });
  });

  test('never enlarges a small image', async () => {
    const { fitWithin } = await load();
    assert.deepEqual(fitWithin(800, 600), { width: 800, height: 600 });
  });
});

describe('shrinkPhoto', () => {
  test('a large photo becomes a 1280 px JPEG at quality 0.8 when that is smaller', async () => {
    const { shrinkPhoto } = await load();
    const image = fakeImage(4000, 3000);
    let asked;
    const result = await shrinkPhoto(file(3_000_000), {
      decode: async () => image,
      encode: async (_img, size, quality) => { asked = { size, quality }; return new Blob([new Uint8Array(400_000)], { type: 'image/jpeg' }); },
    });
    assert.deepEqual(asked, { size: { width: 1280, height: 960 }, quality: 0.8 });
    assert.equal(result.type, 'image/jpeg');
    assert.equal(result.size, 400_000);
    assert.equal(result.name, 'IMG_1234.jpg');
    assert.ok(image.closed, 'the decoded bitmap is released');
  });

  test('the original is kept when the resized file is not smaller', async () => {
    const { shrinkPhoto } = await load();
    const original = file(50_000);
    const result = await shrinkPhoto(original, {
      decode: async () => fakeImage(600, 400),
      encode: async () => new Blob([new Uint8Array(80_000)]),
    });
    assert.equal(result, original);
  });

  test('the original is kept when the browser cannot decode or encode the image', async () => {
    const { shrinkPhoto } = await load();
    const original = file(2_000_000);
    assert.equal(await shrinkPhoto(original, { decode: async () => { throw new Error('bad image'); } }), original);
    assert.equal(await shrinkPhoto(original, { decode: async () => fakeImage(2000, 2000), encode: async () => null }), original);
  });
});
