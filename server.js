// XBT zaps: a Lightning address on the BLAKE2b chain's Lightning network that supports
// nostr zaps (NIP-57), paid into Kilombino's LND. It marks the chain everywhere:
//  - the LNURL-pay response carries "chain": "bitcoin-blake2b";
//  - a zap request tagged for another chain is turned down;
//  - the zap receipt (kind 9735) carries ["chain", "bitcoin-blake2b"].
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const { verifyEvent, finalizeEvent } = require('nostr-tools');

const CHAIN = 'bitcoin-blake2b';
const HOST = process.env.ZAP_DOMAIN || 'zap.kilombino.com';
const PORT = +(process.env.PORT || 3108);
// Lightning addresses served, by domain: name@domain → who receives. kilombino.com reaches this
// server through kilomultisalon's nginx (it proxies /.well-known/lnurlp/zap and /lnurlp/zap/).
const ADDRESSES = { [HOST]: { kilombino: 'Kilombino' }, 'kilombino.com': { zap: 'Kilombino' } };
const MIN_MSAT = 1000, MAX_MSAT = 100_000_000_000; // 1 sat .. 1 BTCB2
const LND = { host: process.env.LND_REST_HOST || '127.0.0.1', port: +(process.env.LND_REST_PORT || 8280) };
const MACAROON = process.env.LND_INVOICE_MACAROON;
const CA = fs.readFileSync(process.env.LND_TLS_CERT || path.join(process.env.HOME, '.config/xbt-zaps/lnd-tls.cert'));
const SK = Uint8Array.from(Buffer.from(process.env.ZAPPER_SK_HEX, 'hex'));
const PUB = process.env.ZAPPER_PUBHEX;
const STATE = path.join(process.env.HOME, '.local/state/xbt-zaps.json');
const DEFAULT_RELAYS = ['wss://relay.kilombino.com', 'wss://relay.damus.io', 'wss://nos.lol'];

let pending = {};
try { pending = JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch {}
const save = () => { fs.mkdirSync(path.dirname(STATE), { recursive: true }); fs.writeFileSync(STATE + '.tmp', JSON.stringify(pending)); fs.renameSync(STATE + '.tmp', STATE); };

function lnd(method, p, body) {
  return new Promise((resolve, reject) => {
    const req = https.request({ ...LND, method, path: p, ca: CA, servername: 'localhost', checkServerIdentity: () => undefined,
      headers: { 'Grpc-Metadata-macaroon': MACAROON, 'content-type': 'application/json' } }, (res) => {
      let d = ''; res.on('data', (c) => (d += c));
      res.on('end', () => { try { const j = JSON.parse(d); res.statusCode < 300 ? resolve(j) : reject(new Error(j.message || d)); } catch (e) { reject(e); } });
    });
    req.on('error', reject); if (body) req.write(JSON.stringify(body)); req.end();
  });
}

const metadata = (name, host) => JSON.stringify([['text/plain', `Zap ${ADDRESSES[host][name]} on Bitcoin (BLAKE2b chain)`], ['text/identifier', `${name}@${host}`]]);

function json(res, code, o) {
  res.writeHead(code, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
  res.end(JSON.stringify(o));
}

async function callback(name, host, q, res) {
  const amount = parseInt(q.get('amount') || '0', 10);
  if (!(amount >= MIN_MSAT && amount <= MAX_MSAT)) return json(res, 200, { status: 'ERROR', reason: 'amount out of range' });
  let descHash, zapReq = null;
  const nostr = q.get('nostr');
  if (nostr) {
    try { zapReq = JSON.parse(nostr); } catch { return json(res, 200, { status: 'ERROR', reason: 'bad zap request' }); }
    if (zapReq.kind !== 9734 || !verifyEvent(zapReq)) return json(res, 200, { status: 'ERROR', reason: 'invalid zap request' });
    const tag = (k) => (zapReq.tags.find((t) => t[0] === k) || [])[1];
    if (tag('amount') && parseInt(tag('amount'), 10) !== amount) return json(res, 200, { status: 'ERROR', reason: 'amount does not match the zap request' });
    if (tag('chain') && tag('chain') !== CHAIN) return json(res, 200, { status: 'ERROR', reason: `this address is on ${CHAIN}, the zap request is for ${tag('chain')}` });
    descHash = crypto.createHash('sha256').update(nostr).digest();
  } else {
    descHash = crypto.createHash('sha256').update(metadata(name, host)).digest();
  }
  const inv = await lnd('POST', '/v1/invoices', { value_msat: String(amount), description_hash: descHash.toString('base64'), expiry: '3600' });
  if (zapReq) { pending[Buffer.from(inv.r_hash, 'base64').toString('hex')] = { zapReq, raw: nostr, bolt11: inv.payment_request, at: Date.now() }; save(); }
  json(res, 200, { pr: inv.payment_request, routes: [] });
}

function publish(event, relays) {
  for (const url of relays.slice(0, 8)) {
    try {
      const ws = new WebSocket(url, { handshakeTimeout: 15000 });
      ws.on('open', () => { ws.send(JSON.stringify(['EVENT', event])); setTimeout(() => ws.close(), 5000); });
      ws.on('message', (m) => console.log('relay', url, String(m).slice(0, 120)));
      ws.on('error', (e) => console.log('relay error', url, e.message));
    } catch (e) { console.log('relay', url, e.message); }
  }
}

async function receipt(hashHex, inv) {
  const p = pending[hashHex]; if (!p) return;
  const zr = p.zapReq; const tags = [];
  for (const k of ['p', 'e', 'a']) { const t = zr.tags.find((x) => x[0] === k); if (t) tags.push([k, t[1]]); }
  tags.push(['P', zr.pubkey], ['bolt11', p.bolt11], ['description', p.raw || JSON.stringify(zr)],
            ['preimage', Buffer.from(inv.r_preimage, 'base64').toString('hex')], ['chain', CHAIN]);
  const ev = finalizeEvent({ kind: 9735, created_at: Math.floor(Number(inv.settle_date) || Date.now() / 1000), tags, content: '' }, SK);
  const relays = (zr.tags.find((t) => t[0] === 'relays') || []).slice(1);
  publish(ev, relays.length ? relays : DEFAULT_RELAYS);
  console.log('zap receipt', ev.id, 'for', hashHex.slice(0, 12), inv.amt_paid_sat, 'sats');
  delete pending[hashHex]; save();
}

// Settled invoices: poll the ones we are waiting on (simple, survives restarts).
setInterval(async () => {
  for (const [h, p] of Object.entries(pending)) {
    if (Date.now() - p.at > 2 * 3600_000) { delete pending[h]; save(); continue; }
    try { const inv = await lnd('GET', `/v1/invoice/${h}`); if (inv.state === 'SETTLED') await receipt(h, inv); } catch (e) { console.log('lookup', e.message); }
  }
}, 5000);

http.createServer(async (req, res) => {
  try {
    // The domain the address was asked on (behind a proxy, its forwarded host).
    const asked = String(req.headers['x-forwarded-host'] || req.headers.host || HOST).split(',')[0].trim().split(':')[0].toLowerCase();
    const host = ADDRESSES[asked] ? asked : HOST;
    const users = ADDRESSES[host];
    const u = new URL(req.url, `https://${host}`);
    let m;
    if ((m = u.pathname.match(/^\/\.well-known\/lnurlp\/([a-z0-9._-]+)$/)) && users[m[1]]) {
      return json(res, 200, { tag: 'payRequest', callback: `https://${host}/lnurlp/${m[1]}/callback`, minSendable: MIN_MSAT, maxSendable: MAX_MSAT,
        metadata: metadata(m[1], host), allowsNostr: true, nostrPubkey: PUB, commentAllowed: 0, chain: CHAIN });
    }
    if ((m = u.pathname.match(/^\/lnurlp\/([a-z0-9._-]+)\/callback$/)) && users[m[1]]) return await callback(m[1], host, u.searchParams, res);
    if (u.pathname === '/') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end(`XBT zaps (${CHAIN}): ${Object.entries(ADDRESSES).flatMap(([d, us]) => Object.keys(us).map((n) => `${n}@${d}`)).join(', ')}\n`); }
    json(res, 404, { status: 'ERROR', reason: 'not found' });
  } catch (e) { console.log('error', e.message); json(res, 500, { status: 'ERROR', reason: e.message }); }
}).listen(PORT, '0.0.0.0', () => console.log('xbt-zaps on', PORT));
