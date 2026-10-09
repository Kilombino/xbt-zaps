# xbt-zaps

A Lightning address with nostr zaps (NIP-57) for Bitcoin on the BLAKE2b chain, paid into your
own LND. It marks the chain at every step so clients never mix it up with SHA-256 bitcoin:

- the LNURL-pay response carries `"chain": "bitcoin-blake2b"`;
- a zap request (kind 9734) tagged `["chain", "<other>"]` is refused;
- the zap receipt (kind 9735) carries `["chain", "bitcoin-blake2b"]`.

Live: `kilombino@zap.kilombino.com`.

## Run

Needs Node 18+ and an LND with REST and an invoice macaroon.

```sh
npm install
export LND_REST_HOST=127.0.0.1 LND_REST_PORT=8080
export LND_INVOICE_MACAROON=<hex of invoice.macaroon>
export LND_TLS_CERT=/path/to/tls.cert
export ZAPPER_SK_HEX=<hex secret key that signs the 9735 receipts>
export ZAPPER_PUBHEX=<its public key>
export ZAP_DOMAIN=zap.example.com PORT=3108
node server.js
```

Put it behind HTTPS at `ZAP_DOMAIN` and edit `USERS` in `server.js` (`name@ZAP_DOMAIN`).

## The convention (proposal)

1. Profile (kind 0): optional `"lud16_blake2b": "name@domain"` next to `lud16`.
2. LNURL-pay response: optional `"chain": "bitcoin-blake2b"`; a client pays only if its wallet is on that chain.
3. Zap request (9734): optional `["chain", "bitcoin-blake2b"]`; servers refuse other chains; the 9735 receipt carries it.
4. NWC: until `get_info` says it, a wallet's chain shows in its `block_hash` at `block_height` (the chains split at block 961640).

License: MIT.
