'use strict';

require('./helpers'); // sets the test environment before src/ is loaded
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isCloudflareIp, CLOUDFLARE_IPV4, CLOUDFLARE_IPV6 } = require('../src/utils/cloudflareIps');

test('Cloudflare range list is well-formed and matches edge addresses only', () => {
  for (const cidr of CLOUDFLARE_IPV4) assert.match(cidr, /^\d+\.\d+\.\d+\.\d+\/\d{1,2}$/);
  for (const cidr of CLOUDFLARE_IPV6) assert.match(cidr, /^[0-9a-f:]+\/\d{1,3}$/);

  for (const ip of ['173.245.48.1', '104.16.0.1', '104.23.255.255', '172.71.255.254', '2606:4700::6810:84e5', '2a06:98c0:3600::103']) {
    assert.equal(isCloudflareIp(ip), true, ip);
  }
  for (const ip of ['8.8.8.8', '127.0.0.1', '10.0.0.1', '104.28.0.1', '2001:db8::1', 'garbage', '']) {
    assert.equal(isCloudflareIp(ip), false, ip);
  }
});
