// divigames.js: the Divi Games browser SDK.
//
// Keys, Divi signed messages, transactions, and a client for the gamechain HTTP + WebSocket API.
// One ES module with no build step. It runs in browsers and in Node 20+ (subscribe() needs a global
// WebSocket, which Node has from 22).
//
// Everything here is byte-compatible with dg_core (Rust) and with Divi Core's
// `signmessage` / `verifymessage`. See ARCHITECTURE.md §1 and §9.

import * as secp from '../vendor/noble-secp256k1/index.js';
import { sha256 } from '../vendor/noble-hashes/sha2.js';
import { ripemd160 } from '../vendor/noble-hashes/legacy.js';
import { hmac } from '../vendor/noble-hashes/hmac.js';

// noble-secp256k1 needs a synchronous HMAC-SHA256 for deterministic (RFC 6979) signing.
secp.etc.hmacSha256Sync = (key, ...msgs) => hmac(sha256, key, concatBytes(...msgs));

/** The gamechain's chain id. A tx signed for another chain id is rejected. */
export const CHAIN_ID = 'divi-games-testnet-1';

/**
 * The Divi network this build plays on: the one switch for every network default in the SDK and the games. It must
 * match the gamechain's `network` (`/v1/info`).
 * @type {'testnet'|'mainnet'}
 */
export const NETWORK = 'testnet';

/** Prefix Divi Core puts in front of every signed message before hashing it. */
export const MESSAGE_MAGIC = 'DarkNet Signed Message:\n';

/**
 * Version bytes for each Divi network.
 * @type {Record<'testnet'|'mainnet', {pubkey: number, secret: number}>}
 */
export const NETWORKS = {
  testnet: { pubkey: 139, secret: 239 },
  mainnet: { pubkey: 30, secret: 212 },
};

// ---------------------------------------------------------------------------------------------------------
// Bytes and hashes

const utf8 = new TextEncoder();

/** @param {...Uint8Array} parts */
function concatBytes(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** @param {Uint8Array} bytes @returns {string} */
export function bytesToHex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** @param {Uint8Array} bytes @returns {string} */
function toBase64(bytes) {
  return btoa(String.fromCharCode(...bytes));
}

/** @param {string} text @returns {Uint8Array} */
function fromBase64(text) {
  return Uint8Array.from(atob(text.trim()), (c) => c.charCodeAt(0));
}

/** @param {Uint8Array} a @param {Uint8Array} b */
function sameBytes(a, b) {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/** SHA256(SHA256(data)). @param {Uint8Array} data */
export function sha256d(data) {
  return sha256(sha256(data));
}

/** RIPEMD160(SHA256(data)), the hash inside a P2PKH address. @param {Uint8Array} data */
export function hash160(data) {
  return ripemd160(sha256(data));
}

export { sha256 };

// ---------------------------------------------------------------------------------------------------------
// Base58Check

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/**
 * Base58 of `payload || first 4 bytes of sha256d(payload)`.
 * @param {Uint8Array} payload
 * @returns {string}
 */
export function base58checkEncode(payload) {
  const bytes = concatBytes(payload, sha256d(payload).subarray(0, 4));
  let n = BigInt('0x' + (bytesToHex(bytes) || '0'));
  let out = '';
  while (n > 0n) {
    out = ALPHABET[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = '1' + out; // each leading zero byte is a leading '1'
  }
  return out;
}

/**
 * Decode Base58Check and verify the checksum. Throws on bad characters or a bad checksum.
 * @param {string} text
 * @returns {Uint8Array} the payload, without the checksum
 */
export function base58checkDecode(text) {
  let n = 0n;
  for (const c of text) {
    const digit = ALPHABET.indexOf(c);
    if (digit < 0) throw new Error(`not base58: ${JSON.stringify(c)}`);
    n = n * 58n + BigInt(digit);
  }
  let hex = n === 0n ? '' : n.toString(16);
  if (hex.length % 2) hex = '0' + hex;
  const zeros = text.length - text.replace(/^1+/, '').length;
  const bytes = new Uint8Array(zeros + hex.length / 2);
  for (let i = 0; i < hex.length / 2; i++) bytes[zeros + i] = parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  if (bytes.length < 4) throw new Error('base58check: too short');
  const payload = bytes.subarray(0, -4);
  if (!sameBytes(sha256d(payload).subarray(0, 4), bytes.subarray(-4))) throw new Error('base58check: bad checksum');
  return payload;
}

// ---------------------------------------------------------------------------------------------------------
// Addresses

/**
 * The P2PKH address of a compressed public key.
 * @param {Uint8Array} publicKey 33 bytes
 * @param {'testnet'|'mainnet'} [network]
 */
export function addressFromPublicKey(publicKey, network = NETWORK) {
  return base58checkEncode(concatBytes(Uint8Array.of(NETWORKS[network].pubkey), hash160(publicKey)));
}

/**
 * Parse a Divi P2PKH address. Throws if it is not one.
 * @param {string} address
 * @returns {{network: 'testnet'|'mainnet', hash160: Uint8Array}}
 */
export function decodeAddress(address) {
  const raw = base58checkDecode(address);
  const network = /** @type {'testnet'|'mainnet'|undefined} */ (
    Object.keys(NETWORKS).find((k) => NETWORKS[/** @type {'testnet'} */ (k)].pubkey === raw[0])
  );
  if (raw.length !== 21 || !network) throw new Error(`not a Divi address: ${address}`);
  return { network, hash160: raw.slice(1) };
}

/**
 * True when `address` is a valid Divi address (on `network`, if given).
 * @param {string} address
 * @param {'testnet'|'mainnet'} [network]
 */
export function isAddress(address, network) {
  try {
    const a = decodeAddress(address);
    return !network || a.network === network;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------------------------------------
// Divi signed messages

/** Bitcoin compact-size length prefix. @param {number} n */
function compactSize(n) {
  if (n < 0xfd) return Uint8Array.of(n);
  if (n <= 0xffff) return Uint8Array.of(0xfd, n & 0xff, n >> 8);
  return Uint8Array.of(0xfe, n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, n >>> 24);
}

/** compactsize(len) || bytes. @param {Uint8Array} bytes */
function varBytes(bytes) {
  return concatBytes(compactSize(bytes.length), bytes);
}

/**
 * The 32-byte digest that Divi `signmessage` signs.
 * The length prefix counts UTF-8 bytes, not JavaScript characters.
 * @param {string} message
 */
export function messageHash(message) {
  return sha256d(concatBytes(varBytes(utf8.encode(MESSAGE_MAGIC)), varBytes(utf8.encode(message))));
}

/** A secp256k1 private key and the Divi address it controls. */
export class Key {
  /** @type {Uint8Array} */ #secret;
  /** @type {Uint8Array|undefined} */ #publicKey;

  /**
   * @param {Uint8Array} secret 32-byte private key
   * @param {'testnet'|'mainnet'} [network]
   */
  constructor(secret, network = NETWORK) {
    if (!(secret instanceof Uint8Array) || secret.length !== 32 || !secp.utils.isValidPrivateKey(secret)) {
      throw new Error('invalid private key');
    }
    if (!NETWORKS[network]) throw new Error(`unknown network: ${network}`);
    this.#secret = Uint8Array.from(secret);
    /** @type {'testnet'|'mainnet'} */
    this.network = network;
  }

  /** A fresh random key. @param {'testnet'|'mainnet'} [network] */
  static generate(network = NETWORK) {
    return new Key(secp.utils.randomPrivateKey(), network);
  }

  /**
   * Parse a WIF private key, as printed by `divi-cli dumpprivkey`. The network comes from its version byte.
   * @param {string} wif
   */
  static fromWif(wif) {
    const raw = base58checkDecode(wif.trim());
    const network = raw[0] === NETWORKS.testnet.secret ? 'testnet' : raw[0] === NETWORKS.mainnet.secret ? 'mainnet' : null;
    const compressed = raw.length === 34 && raw[33] === 1;
    if (!network || !(raw.length === 33 || compressed)) throw new Error('not a Divi WIF private key');
    return new Key(raw.slice(1, 33), network);
  }

  /** WIF with the compressed-key flag (testnet keys start with 'c'). */
  toWif() {
    return base58checkEncode(concatBytes(Uint8Array.of(NETWORKS[this.network].secret), this.#secret, Uint8Array.of(1)));
  }

  /** The 33-byte compressed public key. @returns {Uint8Array} */
  get publicKey() {
    return (this.#publicKey ??= secp.getPublicKey(this.#secret, true));
  }

  /** The P2PKH address. @returns {string} */
  get address() {
    return addressFromPublicKey(this.publicKey, this.network);
  }

  /**
   * Divi `signmessage`: base64 of header || r || s, with header = 27 + recid + 4 (compressed key).
   * Deterministic (RFC 6979) and low-s, exactly like Divi Core and dg_core.
   * @param {string} message
   * @returns {string}
   */
  signMessage(message) {
    const sig = secp.sign(messageHash(message), this.#secret, { lowS: true });
    return toBase64(concatBytes(Uint8Array.of(27 + sig.recovery + 4), sig.toBytes()));
  }
}

/**
 * Recover the compressed public key that made a Divi message signature. Throws if the signature is malformed.
 * @param {string} message
 * @param {string} sigB64
 * @returns {Uint8Array} 33 bytes
 */
export function recoverMessageSigner(message, sigB64) {
  const raw = fromBase64(sigB64);
  if (raw.length !== 65) throw new Error('signature must be 65 bytes');
  const header = raw[0];
  // 31..34 are compressed keys. Every Divi wallet signs with compressed keys.
  if (header < 31 || header > 34) throw new Error('unsupported signature header');
  let recid = (header - 27) & 3;
  let sig = secp.Signature.fromBytes(raw.subarray(1));
  if (sig.hasHighS()) {
    sig = sig.normalizeS();
    recid ^= 1;
  }
  return sig.addRecoveryBit(recid).recoverPublicKey(messageHash(message)).toBytes(true);
}

/**
 * Divi `verifymessage`: true when `sigB64` is `address`'s signature over `message`. Never throws.
 * @param {string} address
 * @param {string} message
 * @param {string} sigB64
 * @returns {boolean}
 */
export function verifyMessage(address, message, sigB64) {
  try {
    const { hash160: want } = decodeAddress(address);
    return sameBytes(hash160(recoverMessageSigner(message, sigB64)), want);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------------------------------------
// Transactions

/**
 * @typedef {{type: string, [field: string]: unknown}} Action
 * @typedef {{nonce: number, action: Action, memo?: string, chain?: string}} TxFields
 * @typedef {{body: string, sig: string}} SignedTx
 */

/**
 * The exact JSON text of a tx body. The node never re-serialises it, so these bytes are what gets signed.
 * @param {string} from signer address
 * @param {TxFields} fields
 * @returns {string}
 */
export function txBody(from, { nonce, action, memo, chain = CHAIN_ID }) {
  if (!Number.isSafeInteger(nonce) || nonce < 0) throw new Error('nonce must be a non-negative integer');
  if (!action || typeof action.type !== 'string' || !action.type) throw new Error('action needs a type');
  /** @type {Record<string, unknown>} */
  const body = { v: 1, chain, from, nonce, action };
  if (memo != null && memo !== '') {
    if ([...memo].length > 140) throw new Error('memo is longer than 140 characters');
    body.memo = memo;
  }
  return JSON.stringify(body);
}

/**
 * The text an owner signs to let `key` play as them until `until` (ARCHITECTURE §1.4); the `session` action's `sig`
 * is the owner's signed-message signature over exactly this string.
 * @param {string} key the session key's address
 * @param {number} until unix seconds
 * @param {string} [chain]
 */
export function sessionText(key, until, chain = CHAIN_ID) {
  if (!Number.isSafeInteger(until) || until < 0) throw new Error('until must be a non-negative integer of seconds');
  const iso = new Date(until * 1000).toISOString().replace('.000Z', 'Z');
  return `Divi Games session: key ${key} may play as this address on ${chain} until ${iso}`;
}

/** `hex(SHA256(body))`. @param {string} body */
export function txidOf(body) {
  return bytesToHex(sha256(utf8.encode(body)));
}

/**
 * Build and sign a transaction.
 * @param {Key} key
 * @param {TxFields} fields
 * @returns {SignedTx & {txid: string}}
 */
export function signTx(key, fields) {
  const body = txBody(key.address, fields);
  return { body, sig: key.signMessage(body), txid: txidOf(body) };
}

// ---------------------------------------------------------------------------------------------------------
// Amounts: decimal strings of integer base units (GOLD has 2 decimals, TDIVI 8)

/**
 * Base units to a display amount, trailing zeros trimmed: formatAmount("1250", 2) === "12.5".
 * @param {string|bigint|number} baseUnits
 * @param {number} decimals
 */
export function formatAmount(baseUnits, decimals) {
  const n = BigInt(baseUnits);
  if (decimals === 0) return n.toString();
  const scale = 10n ** BigInt(decimals);
  const sign = n < 0n ? '-' : '';
  const abs = n < 0n ? -n : n;
  const frac = (abs % scale).toString().padStart(decimals, '0').replace(/0+$/, '');
  return sign + (abs / scale).toString() + (frac ? '.' + frac : '');
}

/**
 * A display amount to base units: parseAmount("12.5", 2) === "1250". Throws on anything else.
 * @param {string} display
 * @param {number} decimals
 * @returns {string}
 */
export function parseAmount(display, decimals) {
  const s = String(display).trim();
  const m = /^(\d*)(?:\.(\d*))?$/.exec(s);
  if (!m || (!m[1] && !m[2]) || (m[2] ?? '').length > decimals) throw new Error(`not an amount with ${decimals} decimals: ${display}`);
  const whole = BigInt(m[1] || '0');
  const frac = BigInt((m[2] ?? '').padEnd(decimals, '0') || '0');
  return (whole * 10n ** BigInt(decimals) + frac).toString();
}

// ---------------------------------------------------------------------------------------------------------
// Block time

/**
 * A block time (ms since 1970) as the visitor's local date and time, e.g. "Sun 25 Oct, 14:05".
 * @param {number} ms
 */
export function localTime(ms) {
  return new Date(ms).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

/**
 * How long until `ms`, as "4:59", "1 h 20 min" or "3 days 4 h"; "now" once it has passed.
 * @param {number} ms
 * @param {number} [now]
 */
export function timeLeft(ms, now = Date.now()) {
  const s = Math.ceil((ms - now) / 1000);
  if (s <= 0) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  const h = Math.floor(s / 3600);
  if (h < 48) return `${h} h ${Math.floor((s % 3600) / 60)} min`;
  return `${Math.floor(h / 24)} days ${h % 24} h`;
}

/**
 * The decimals of a token the chain makes itself, or undefined for any other: GOLD 2, TDGOLD 2 (tower defense),
 * TDIVI 8 (the bridge), and the season tokens S<n>GOLD 2 and S<n>DIVI 8 (crates/dg-market).
 * @param {string} symbol
 * @returns {number|undefined}
 */
export function tokenDecimals(symbol) {
  const known = /** @type {Record<string, number>} */ ({ GOLD: 2, TDGOLD: 2, TDIVI: 8 });
  if (Object.hasOwn(known, symbol)) return known[symbol];
  const season = /^S\d+(GOLD|DIVI)$/.exec(symbol);
  return season ? (season[1] === 'GOLD' ? 2 : 8) : undefined;
}

/**
 * A chain error with any "block time N" turned into the visitor's local time and how long until it, a bet's limits
 * in GOLD rather than base units, and an "insufficient" refusal in whole tokens (left as it is for a token whose
 * decimals `tokenDecimals` doesn't know).
 * @param {string} message
 * @param {number} [now]
 */
export function readableError(message, now = Date.now()) {
  return String(message)
    .replace(/block time (\d{12,})/g, (_, ms) => {
      const left = timeLeft(Number(ms), now);
      return left === 'now' ? localTime(Number(ms)) : `${localTime(Number(ms))} (in ${left})`;
    })
    .replace(/bet must be (\d+) to (\d+) base units/, (_, lo, hi) => `bet must be ${formatAmount(lo, 2)} to ${formatAmount(hi, 2)} GOLD`)
    .replace(/(?:rejected: )?insufficient ([A-Z0-9]+): need (\d+), have (\d+)/, (all, sym, need, have) => {
      const d = tokenDecimals(sym);
      return d == null ? all : `Not enough ${sym}: this needs ${formatAmount(need, d)} ${sym} and you have ${formatAmount(have, d)} ${sym}`;
    });
}

/** The page where a player logs in with Telegram and links an address. */
export const ACCOUNT_URL = 'https://games.divi.domains/account';

/**
 * When a faucet is in fast-drip mode (from 2 Nov 2026, after a rush of claims it pays only addresses linked to a
 * Telegram account for an hour), the block time in ms it ends; 0 in slow drip. `info` is `/v1/info`.
 * @param {any} info @param {string} [symbol] @param {number} [now]
 */
export function faucetFastUntil(info, symbol = 'GOLD', now = Date.now()) {
  const until = Number(info?.faucet_fast_until_ms?.[symbol] ?? 0);
  return Number.isFinite(until) && until > now ? until : 0;
}

/** The note a game page shows while the GOLD faucet is in fast-drip mode, or '' in slow drip. */
export function faucetFastNote(/** @type {any} */ info, now = Date.now()) {
  const until = faucetFastUntil(info, 'GOLD', now);
  return until ? `The GOLD faucet is in fast-drip mode until block time ${until}: many people are claiming, so for now it pays only addresses linked to a Telegram account. Link yours at ${ACCOUNT_URL}` : '';
}

/** Set a node's text, turning the account page's address into a link. */
export function setTextWithLinks(/** @type {HTMLElement} */ node, /** @type {string} */ text) {
  node.replaceChildren();
  String(text).split(ACCOUNT_URL).forEach((part, i) => {
    if (i) {
      const a = document.createElement('a');
      a.href = ACCOUNT_URL;
      a.textContent = ACCOUNT_URL;
      node.append(a);
    }
    node.append(part);
  });
}

// ---------------------------------------------------------------------------------------------------------
// Gamechain API client

/**
 * @typedef {{kind: string, data: any}} ChainEvent
 * @typedef {{txid: string, height: number, index: number, ok: boolean, error: string|null, events: ChainEvent[]}} Receipt
 * @typedef {{type: 'block', header: any, receipts: Receipt[]}} BlockMessage
 * @typedef {{owner: string, until: number, ended: boolean}} Session
 * @typedef {{address: string, nonce: number, next_nonce: number, balances: Record<string, string>, session: Session|null}} Account
 */

/**
 * The http(s) address in the page's `<meta name="…" content="…">`, without a trailing slash, or undefined.
 * A game published as plain files (on IPFS, say) has no /chain or site pages of its own, so
 * `scripts/export-clients.mjs --static` writes `divigames-chain` and `divigames-site` tags into it. The tags are
 * part of the published page, so only whoever publishes the page can set them.
 * @param {string} name
 * @param {{querySelector: (s: string) => any}|undefined} [doc]
 */
export function pageSetting(name, doc = globalThis.document) {
  const raw = doc?.querySelector?.(`meta[name="${name}"]`)?.getAttribute('content');
  if (!raw) return undefined;
  let u;
  try {
    u = new URL(raw);
  } catch {
    return undefined;
  }
  if (!/^https?:$/.test(u.protocol) || u.username || u.password) return undefined;
  return u.origin + u.pathname.replace(/\/+$/, '');
}

/**
 * A link to a page of the site (`/leaderboard`, `/explorer/tx/…`): relative on the site and in the stand-alone
 * clients, whose server sends site pages on, and on the `divigames-site` the page names when it is plain files.
 * @param {string} path starting with /
 * @param {{querySelector: (s: string) => any}|undefined} [doc]
 */
export function siteUrl(path, doc = globalThis.document) {
  const site = pageSetting('divigames-site', doc);
  return site ? site + path : path;
}

function defaultBaseUrl() {
  const named = pageSetting('divigames-chain');
  if (named) return named;
  const loc = globalThis.location;
  if (loc && /^https?:$/.test(loc.protocol)) return loc.origin + '/chain';
  return 'http://127.0.0.1:7410';
}

/**
 * The chain API root a game page asked for with `?chain=`, or undefined for the default. A page served from the
 * public site accepts only its own origin, so a link cannot point a player's signed moves at another server; a page
 * served from localhost or 127.0.0.1 accepts any address, for development.
 * @param {string} search location.search
 * @param {{origin: string, hostname: string, href: string}} [loc]
 */
export function chainFromQuery(search, loc = globalThis.location) {
  const wanted = new URLSearchParams(search).get('chain');
  if (!wanted) return undefined;
  let url;
  try {
    url = new URL(wanted, loc.href);
  } catch {
    return undefined;
  }
  const local = loc.hostname === 'localhost' || loc.hostname === '127.0.0.1';
  return local || url.origin === loc.origin ? url.href : undefined;
}

const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));

/** The address deposits go to on the games.divi.domains chain. A chain that names another is not trusted with deposits. */
export const BRIDGE_ADDRESS = 'y7SwXAHzGzAb2hpn5Ueb8kwuVAQuBwqHF3';
/** The sequencer that signs games.divi.domains blocks. */
export const SEQUENCER = 'xw9aaoN8FBrQcesu8F29ZjL6irKxyXpRRZ';

/**
 * The chain a page's `?chain=` names, if it may use it: this site's own `/chain`, or a node on this computer
 * (http://127.0.0.1 or http://localhost, any port) for development. Anything else is ignored, so a link
 * cannot point a player's wallet at someone else's node. Returns null for the default chain.
 * @param {string} search the page's `location.search`
 * @param {string} [origin] the page's origin
 */
export function chainFromSearch(search, origin = globalThis.location?.origin ?? '') {
  const raw = new URLSearchParams(search).get('chain');
  if (!raw) return null;
  let u;
  try {
    u = new URL(raw, origin || undefined);
  } catch {
    return null;
  }
  if (u.username || u.password) return null;
  const local = u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost');
  return local ? u.origin + u.pathname.replace(/\/+$/, '') : null;
}

export class Chain {
  /**
   * @param {string} [baseUrl] API root, e.g. "https://games.divi.domains/chain".
   *   Defaults to the page's `divigames-chain` meta tag (see {@link pageSetting}), else `<this page's origin>/chain`
   *   in a browser and http://127.0.0.1:7410 elsewhere. A chain named by the tag is the page's own default, not a
   *   development chain: it is not marked `local`, and deposits still go only to the pinned BRIDGE_ADDRESS.
   * @param {{chain?: string}} [opts] chain id used by send() (default CHAIN_ID)
   */
  constructor(baseUrl = defaultBaseUrl(), opts = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.chainId = opts.chain ?? CHAIN_ID;
    /** True for a development node named by `?chain=`: wallet sessions and deposits are kept apart from it. */
    this.local = this.baseUrl !== defaultBaseUrl();
  }

  /** The chain this page should use: the one `?chain=` names when {@link chainFromSearch} allows it, else the default. */
  static fromPage() {
    const url = chainFromSearch(globalThis.location?.search ?? '');
    return url ? new Chain(url) : new Chain();
  }

  /** @param {string} path @param {RequestInit} [init] */
  async #request(path, init) {
    const res = await fetch(this.baseUrl + path, init);
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* not JSON */
    }
    if (!res.ok) {
      const err = /** @type {Error & {status?: number}} */ (new Error(json?.error ?? `${res.status} ${res.statusText || 'error'} from ${path}`));
      err.status = res.status;
      throw err;
    }
    return json;
  }

  /** Chain id, network, height, head hash, Divi checkpoint, modules, tokens. */
  info() {
    return this.#request('/v1/info');
  }

  /** @param {string} address @returns {Promise<Account>} */
  account(address) {
    return this.#request(`/v1/account/${encodeURIComponent(address)}`);
  }

  /**
   * Registered tokens, by symbol. With `page`, one page: the node caps a page at 100, the next page
   * starts `after` the last symbol, and a short page is the last. Without, every page in turn.
   * @param {{after?: string, limit?: number}} [page]
   */
  async tokens(page) {
    if (page) {
      const q = new URLSearchParams();
      for (const [k, v] of Object.entries(page)) if (v != null) q.set(k, String(v));
      return this.#request(`/v1/tokens?${q}`);
    }
    const all = [];
    for (;;) {
      const got = await this.tokens({ after: all.at(-1)?.symbol, limit: 100 });
      const list = Array.isArray(got) ? got : got?.tokens ?? [];
      all.push(...list);
      if (list.length < 100) return all;
    }
  }

  /**
   * Submit a signed tx. Throws with the node's `error` text if it is rejected.
   * @param {SignedTx} tx
   * @returns {Promise<{txid: string}>}
   */
  submit({ body, sig }) {
    return this.#request('/v1/tx', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ body, sig }),
    });
  }

  /**
   * A tx and its receipt (`receipt` is null while pending). Resolves to null if the node does not know the txid.
   * @param {string} txid
   * @returns {Promise<{body: string, sig: string, receipt: Receipt|null}|null>}
   */
  async tx(txid) {
    try {
      return await this.#request(`/v1/tx/${txid}`);
    } catch (e) {
      if (/** @type {any} */ (e).status === 404) return null;
      throw e;
    }
  }

  /**
   * Poll until the tx is in a block. Resolves to its receipt; check `receipt.ok`.
   * @param {string} txid
   * @param {{timeoutMs?: number, intervalMs?: number}} [opts]
   * @returns {Promise<Receipt>}
   */
  async waitForReceipt(txid, { timeoutMs = 30000, intervalMs = 500 } = {}) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const t = await this.tx(txid).catch(() => null);
      if (t?.receipt) return t.receipt;
      if (Date.now() >= deadline) throw new Error(`tx ${txid.slice(0, 12)}… not in a block after ${timeoutMs / 1000}s`);
      await sleep(intervalMs);
    }
  }

  /**
   * A game module's view: GET /v1/games/<name>?<query>.
   * @param {string} name e.g. "tictactoe"
   * @param {Record<string, string|number|boolean|undefined|null>} [query]
   */
  game(name, query = {}) {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) if (v != null) q.set(k, String(v));
    const qs = q.toString();
    return this.#request(`/v1/games/${encodeURIComponent(name)}${qs ? '?' + qs : ''}`);
  }

  /**
   * Fetch the next nonce, sign `action`, submit it, and return the txid.
   * `signer` is a Key, or anything with `address` and a (sync or async) `signMessage`, such as a wallet.
   * @param {{address: string, signMessage(msg: string): string|Promise<string>}} signer
   * @param {Action} action
   * @param {{memo?: string}} [opts]
   * @returns {Promise<string>}
   */
  async send(signer, action, { memo } = {}) {
    // Two tabs on one key can both read the same next nonce; the loser re-reads it and signs once more.
    for (let attempt = 0; ; attempt++) {
      const { next_nonce } = await this.account(signer.address);
      const body = txBody(signer.address, { nonce: next_nonce, action, memo, chain: this.chainId });
      const sig = await signer.signMessage(body);
      try {
        const { txid } = await this.submit({ body, sig });
        return txid;
      } catch (e) {
        if (attempt > 0 || !/nonce: expected/.test(/** @type {Error} */ (e).message)) throw e;
      }
    }
  }

  /**
   * Stream blocks from GET /v1/ws. Reconnects on its own until you call the returned function.
   * Blocks that arrive while disconnected are missed, so refresh your view in `onStatus(true)`.
   * @param {(block: BlockMessage) => void} onBlock
   * @param {{onStatus?: (connected: boolean) => void}} [opts]
   * @returns {() => void} unsubscribe
   */
  subscribe(onBlock, { onStatus } = {}) {
    const url = this.baseUrl.replace(/^http/, 'ws') + '/v1/ws';
    let closed = false;
    let delay = 1000;
    /** @type {WebSocket|undefined} */ let ws;
    /** @type {ReturnType<typeof setTimeout>|undefined} */ let timer;

    const connect = () => {
      ws = new WebSocket(url);
      ws.onopen = () => {
        delay = 1000;
        onStatus?.(true);
      };
      ws.onmessage = (ev) => {
        let msg;
        try {
          msg = JSON.parse(typeof ev.data === 'string' ? ev.data : '');
        } catch {
          return;
        }
        if (msg?.type === 'block') onBlock(msg);
      };
      ws.onclose = () => {
        if (closed) return;
        onStatus?.(false);
        timer = setTimeout(connect, delay);
        delay = Math.min(delay * 2, 15000);
      };
      ws.onerror = () => ws?.close();
    };
    connect();

    return () => {
      closed = true;
      clearTimeout(timer);
      ws?.close();
    };
  }
}
