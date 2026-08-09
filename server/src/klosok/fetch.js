'use strict';

const { Agent } = require('undici');

const config = require('../config');
const { fetchWithTimeout } = require('../http');

// The Kłosok GTFS-RT feed is served with a certificate chain rooted in Let's
// Encrypt's new "Root YE", which not every host's CA store carries yet — Node
// then rejects the leaf while every other upstream works. The escape hatch is
// scoped to this one endpoint: a dedicated undici Agent with
// connect.rejectUnauthorized=false, attached only to the fetch below when
// KLOSOK_TLS_ALLOW_INVALID_CERT is true (default true). It must never be used
// for MPK, Open Data or any other source, and it is not a global switch —
// everything else in the process keeps full TLS verification.
let klosokAgent = null;
const getKlosokAgent = () => {
  if (!klosokAgent) klosokAgent = new Agent({ connect: { rejectUnauthorized: false } });
  return klosokAgent;
};

/**
 * Fetch the PT KŁOSOK GTFS-RT feed.
 *
 * The only place a relaxed-TLS dispatcher may be attached. `allowInvalidCert`
 * defaults to KLOSOK_TLS_ALLOW_INVALID_CERT (true) and can be passed
 * explicitly for tests; when it is true the request goes through the dedicated
 * agent above and nothing else in the process is affected.
 *
 * @param {string} url
 * @param {{ timeoutMs?: number, allowInvalidCert?: boolean }} options
 * @returns {Promise<Response>}
 */
const fetchKlosokFeed = (
  url,
  {
    timeoutMs = config.klosok.timeoutMs,
    allowInvalidCert = config.klosok.tlsAllowInvalidCert,
  } = {},
) =>
  fetchWithTimeout(url, {
    timeoutMs,
    redirect: 'follow',
    headers: { Accept: 'application/x-protobuf, application/octet-stream' },
    ...(allowInvalidCert ? { dispatcher: getKlosokAgent() } : {}),
  });

module.exports = { fetchKlosokFeed };
