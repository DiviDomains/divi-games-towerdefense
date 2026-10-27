// Play Divi Games as an IronDivi wallet: the Browser Wallet extension, the Web Wallet, or the Telegram wallet.
//
// The wallet signs one session text (ARCHITECTURE.md §1.4). A key made by this page then plays as the wallet's
// address for a day, in this tab, with no more prompts. A session key can only play games and use the faucet, so
// a bridge withdrawal is signed by the wallet itself. From the second rules (25 Oct 2026 08:00 UTC) it may stake
// only GOLD, and at most 5000.00 GOLD over its life; past that the player signs in again for a new key. Without a wallet the page's guest key plays, as before.
//
//   const wallets = mountWallets({ chain, card, guestKey, onChange });
//   wallets.key   signs txs (the session key, or the guest key)
//   wallets.me    the address that plays (the wallet's address, or the guest key's)

import * as sdk from './divigames.js';

const { Key, CHAIN_ID, NETWORK, verifyMessage, recoverMessageSigner, addressFromPublicKey, isAddress, formatAmount, parseAmount } = sdk;

export const WEB_WALLET_ORIGIN = 'https://services.divi.domains';
export const WEB_WALLET_URL = `${WEB_WALLET_ORIGIN}/${NETWORK}/wallet/`;
export const TELEGRAM_BOT = 'divi_wallet_bot';
export const EXTENSION_URL = 'https://browser.irondivi.com/';

export const WALLETS = /** @type {const} */ ({
  extension: 'IronDivi Browser Wallet',
  web: 'IronDivi Web Wallet',
  telegram: 'IronDivi Telegram wallet',
});

const SESSION_STORE = 'dg.session';
// A session lasts a day and its key lives in this tab's sessionStorage, so a script that ever gets onto the page
// finds at most a day's key in the tab it ran in, never one left on disk for weeks.
const SESSION_SECS = 86400;
const TDIVI_DECIMALS = 8;

/** The text a wallet signs to let `key` play as it until `until` (unix seconds). Same as the chain's. */
export const sessionText =
  sdk.sessionText ??
  ((/** @type {string} */ key, /** @type {number} */ until) =>
    `Divi Games session: key ${key} may play as this address on ${CHAIN_ID} until ${new Date(until * 1000).toISOString().replace('.000Z', 'Z')}`);

// ---------- small helpers ----------

/** @param {string} tag @param {Record<string, any>} [props] @param {...(Node|string|null|undefined|false)} children */
function el(tag, props = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (k in n && typeof v !== 'string') /** @type {any} */ (n)[k] = v;
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children) if (c != null && c !== false) n.append(c);
  return n;
}

const errText = (/** @type {any} */ e) => (e && e.message) || String(e);
const short = (/** @type {string} */ a) => (a.length > 14 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);

function say(/** @type {HTMLElement} */ node, text = '', kind = 'info') {
  node.textContent = text;
  node.dataset.kind = kind;
  node.hidden = !text;
}

async function copy(/** @type {string} */ text, /** @type {HTMLButtonElement} */ btn) {
  try {
    await navigator.clipboard.writeText(text);
    const was = btn.textContent;
    btn.textContent = 'Copied';
    setTimeout(() => (btn.textContent = was), 1500);
  } catch {
    /* clipboard unavailable: the text is on screen */
  }
}

/** Where the session for `chain` is kept: a development node gets its own, so it never sees the real chain's session key. */
function storeKey(/** @type {sdk.Chain} */ chain) {
  return chain.local ? `${SESSION_STORE}@${chain.baseUrl}` : SESSION_STORE;
}

function load(/** @type {string} */ where) {
  try {
    localStorage.removeItem(where); // where sessions were kept before they moved to sessionStorage
    const s = JSON.parse(sessionStorage.getItem(where) || 'null');
    if (!s || !isAddress(s.owner, NETWORK) || !(s.wallet in WALLETS) || !(s.until > Date.now() / 1000 + 60)) return null;
    const key = Key.fromWif(s.wif);
    return key.network === NETWORK ? { owner: String(s.owner), key, until: Number(s.until), wallet: String(s.wallet) } : null;
  } catch {
    return null;
  }
}

function store(/** @type {string} */ where, /** @type {any} */ s) {
  try {
    if (s) sessionStorage.setItem(where, JSON.stringify({ owner: s.owner, wif: s.key.toWif(), until: s.until, wallet: s.wallet }));
    else sessionStorage.removeItem(where);
  } catch {
    /* storage blocked: the session lasts this visit */
  }
}

/** The testnet address that signed `text`, preferring the address the wallet named. Throws if `sig` is not a signature of it. */
function signerOf(/** @type {string} */ text, /** @type {string} */ sig, /** @type {string|undefined} */ named) {
  if (named && isAddress(named, NETWORK) && verifyMessage(named, text, sig)) return named;
  const addr = addressFromPublicKey(recoverMessageSigner(text, sig), NETWORK);
  if (!verifyMessage(addr, text, sig)) throw new Error('The signature does not match the message.');
  return addr;
}

// ---------- the three wallets ----------

/** The Browser Wallet's provider, or null if the extension does not appear within `ms`. */
function extensionProvider(ms = 1500) {
  const w = /** @type {any} */ (window);
  if (w.irondivi) return Promise.resolve(w.irondivi);
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(w.irondivi ?? null), ms);
    window.addEventListener('irondivi#initialized', () => (clearTimeout(t), resolve(w.irondivi)), { once: true });
  });
}

/**
 * A chain tx body goes through `signGameTx`, which the wallet shows as a transaction and takes only from this
 * site; from 0.0.5 its `signMessage` refuses tx bodies. Older wallets have only `signMessage`.
 */
async function signWithExtension(/** @type {string} */ text, tx = false) {
  const w = await extensionProvider();
  if (!w) throw Object.assign(new Error('The IronDivi Browser Wallet is not installed in this browser.'), { install: true });
  const { address } = await w.connect();
  const r = tx && typeof w.signGameTx === 'function' ? await w.signGameTx(text) : await w.signMessage(text);
  return { address: String(r?.address ?? address), sig: String(typeof r === 'string' ? r : r?.signature ?? '') };
}

/**
 * Ask the Web Wallet in a pop-up. It takes the request only once it is unlocked. A wallet that says so with
 * DIVI_WALLET_READY gets the request at once; for one that does not, the player presses "Send the request" after
 * unlocking. The request is never re-sent on a timer: older wallets reopen the panel and reset the address each time.
 * @param {string} text @param {(...n: (Node|string)[]) => void} show
 */
function signWithWebWallet(text, show) {
  const requestId = `dg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const popup = window.open(WEB_WALLET_URL, 'DiviWallet', 'popup,width=480,height=760');
  if (!popup) return Promise.reject(new Error('The browser blocked the wallet window. Allow pop-ups for this site and try again.'));
  return new Promise((resolve, reject) => {
    let done = false;
    let ready = false;
    const post = () => {
      try {
        popup.postMessage({ type: 'DIVI_SIGN_REQUEST', payload: { message: text, requestId } }, WEB_WALLET_ORIGIN);
      } catch {
        /* the window is gone; the close check below reports it */
      }
    };
    const send = el('button', { type: 'button', class: 'ghost small', onclick: () => (post(), popup.focus()) }, 'Send the request');
    show('Unlock the IronDivi Web Wallet in the new window, check the message and approve it. If the message does not appear after you unlock, press ', send, '.');
    const finish = (/** @type {Error|null} */ err, /** @type {any} */ val) => {
      if (done) return;
      done = true;
      clearInterval(tick);
      clearTimeout(timer);
      window.removeEventListener('message', onMessage);
      if (err) reject(err);
      else {
        try {
          popup.close();
        } catch {
          /* the wallet may close itself */
        }
        resolve(val);
      }
    };
    const onMessage = (/** @type {MessageEvent} */ ev) => {
      if (ev.origin !== WEB_WALLET_ORIGIN || ev.source !== popup) return;
      const d = ev.data;
      if (!d || typeof d !== 'object') return;
      if (d.type === 'DIVI_WALLET_READY') {
        if (!ready) post();
        ready = true;
        return show('Check the message in the IronDivi Web Wallet window and approve it.');
      }
      if (d.payload?.requestId !== requestId) return;
      if (d.type === 'DIVI_SIGN_RESPONSE') finish(null, { address: String(d.payload.address ?? ''), sig: String(d.payload.signature ?? '') });
      else if (d.type === 'DIVI_SIGN_CANCEL' && d.payload?.reason !== 'wallet_locked') finish(new Error('Signing was cancelled in the Web Wallet.'), null);
    };
    window.addEventListener('message', onMessage);
    const tick = setInterval(() => popup.closed && finish(new Error('The wallet window was closed before it signed.'), null), 1000);
    const timer = setTimeout(() => finish(new Error('The Web Wallet did not answer within 5 minutes.'), null), 5 * 60000);
  });
}

// ---------- the connector ----------

/**
 * Put the wallet controls in the page's wallet card.
 * @param {{chain: sdk.Chain, card: HTMLElement, guestKey: sdk.Key, onChange: (w: {key: sdk.Key, me: string}) => void}} opts
 */
export function mountWallets({ chain, card, guestKey, onChange }) {
  injectStyle();
  const where = storeKey(chain);
  let session = load(where);
  let guest = guestKey;
  let bridgeAddress = '';
  /** @type {((r: {address: string, sig: string}|'cancel'|null) => void)|null} */ let tgResolve = null;

  const msg = el('p', { class: 'msg', role: 'status', hidden: true });
  const status = (/** @type {string} */ t) => say(msg, t, 'info');
  const show = (/** @type {(Node|string)[]} */ ...n) => (msg.replaceChildren(...n), (msg.dataset.kind = 'info'), (msg.hidden = false));

  const walletBtn = (/** @type {keyof typeof WALLETS} */ id, label) =>
    el('button', { type: 'button', class: 'ghost', onclick: () => connect(id) }, label);
  const out = el(
    'div',
    { class: 'dgw-out' },
    el('span', { class: 'label' }, 'Play as your wallet'),
    walletBtn('extension', 'Browser Wallet'),
    walletBtn('web', 'Web Wallet'),
    walletBtn('telegram', 'Telegram'),
  );
  const inText = el('span', { class: 'dgw-who' });
  const inn = el('div', { class: 'dgw-in', hidden: true }, inText, el('button', { type: 'button', class: 'ghost small', onclick: disconnect }, 'Disconnect'));

  // Telegram: the player sends /sign to the bot, signs in the wallet it opens, and pastes the signature.
  const tgCmd = el('code', { class: 'dgw-cmd' });
  const tgPaste = /** @type {HTMLTextAreaElement} */ (el('textarea', { rows: 3, spellcheck: false, placeholder: 'Paste the signature from the wallet' }));
  const tg = el(
    'div',
    { class: 'dgw-tg', hidden: true },
    el('p', { class: 'note' }, 'In Telegram, send this to ', el('a', { href: `https://t.me/${TELEGRAM_BOT}`, target: '_blank', rel: 'noopener' }, `@${TELEGRAM_BOT}`), '. Tap its Sign in Wallet button, sign, tap Copy under the signature, and paste it here:'),
    el('div', { class: 'dgw-cmdrow' }, tgCmd, el('button', { type: 'button', class: 'ghost small', onclick: (/** @type {any} */ e) => copy(tgCmd.textContent ?? '', e.currentTarget) }, 'Copy')),
    tgPaste,
    el(
      'div',
      { class: 'dgw-cmdrow' },
      el('button', { type: 'button', onclick: () => tgResolve?.(parseTelegram()) }, 'Use this signature'),
      el('button', { type: 'button', class: 'ghost', onclick: () => tgResolve?.('cancel') }, 'Cancel'),
    ),
  );

  // The tDIVI bridge, shown only when the chain runs one and a wallet is connected.
  const tdivi = el('strong', {}, '…');
  const depAmount = /** @type {HTMLInputElement} */ (el('input', { inputmode: 'decimal', value: '10', autocomplete: 'off', 'aria-label': 'Deposit amount in tDIVI' }));
  const depWeb = /** @type {HTMLAnchorElement} */ (el('a', { class: 'btn ghost', target: '_blank', rel: 'noopener' }, 'Send from the Web Wallet'));
  const depTg = el('code', { class: 'dgw-cmd' });
  const depTo = el('code', { class: 'addr' });
  const wdAmount = /** @type {HTMLInputElement} */ (el('input', { inputmode: 'decimal', placeholder: 'Amount', autocomplete: 'off', 'aria-label': 'Withdraw amount in tDIVI' }));
  const wdTo = /** @type {HTMLInputElement} */ (el('input', { spellcheck: false, autocomplete: 'off', placeholder: 'Testnet address to pay', 'aria-label': 'Testnet address to pay' }));
  const wdBtn = /** @type {HTMLButtonElement} */ (el('button', { type: 'submit' }, 'Withdraw'));
  const bridgeMsg = el('p', { class: 'msg', role: 'status', hidden: true });
  const bridge = el(
    'details',
    { class: 'keybox dgw-bridge', hidden: true },
    el('summary', {}, 'tDIVI bridge · ', tdivi, ' tDIVI'),
    el('p', { class: 'note' }, 'Deposit testnet DIVI to get tDIVI here, 1 for 1, after 6 confirmations. The deposit carries your address as its memo (OP_RETURN), so it is credited to you whichever address pays it.'),
    el('div', { class: 'dgw-cmdrow' }, el('label', {}, 'Deposit ', depAmount, ' tDIVI'), depWeb),
    el('p', { class: 'note' }, 'Or in Telegram, send to ', el('a', { href: `https://t.me/${TELEGRAM_BOT}`, target: '_blank', rel: 'noopener' }, `@${TELEGRAM_BOT}`), ':'),
    el('div', { class: 'dgw-cmdrow' }, depTg, el('button', { type: 'button', class: 'ghost small', onclick: (/** @type {any} */ e) => copy(depTg.textContent ?? '', e.currentTarget) }, 'Copy')),
    el('p', { class: 'note' }, 'From any other wallet, send to ', depTo, ' with your address as the memo.'),
    el('form', { class: 'dgw-cmdrow', onsubmit: withdraw }, wdAmount, wdTo, wdBtn),
    el('p', { class: 'note' }, 'A withdrawal is signed by your wallet, not the play key. The operator pays queued withdrawals by hand.'),
    bridgeMsg,
  );
  depAmount.addEventListener('input', fillDeposit);

  const root = el('div', { class: 'dgw' }, out, inn, tg, msg, bridge);
  const keybox = card.querySelector('.keybox');
  card.insertBefore(root, keybox);

  const api = {
    get key() {
      return session ? session.key : guest;
    },
    get me() {
      return session ? session.owner : guest.address;
    },
    get wallet() {
      return session?.wallet ?? null;
    },
    /** The guest key changed (import): keep it for when no wallet is connected. */
    setGuestKey(/** @type {sdk.Key} */ k) {
      guest = k;
    },
    /** Refresh the tDIVI balance; call it with the page's own refresh. */
    refresh: refreshBridge,
  };

  function render() {
    out.hidden = !!session;
    inn.hidden = !session;
    if (keybox instanceof HTMLElement) keybox.hidden = !!session;
    if (session) {
      inText.replaceChildren(
        'Playing as ',
        el('code', { class: 'addr', title: session.owner }, short(session.owner)),
        ` with the ${WALLETS[/** @type {keyof typeof WALLETS} */ (session.wallet)]} until ${new Date(session.until * 1000).toLocaleDateString()}`,
      );
    }
    bridge.hidden = !(session && bridgeAddress);
    fillDeposit();
  }

  function changed() {
    render();
    onChange({ key: api.key, me: api.me });
    refreshBridge();
  }

  /**
   * Get `text` signed by the chosen wallet; `tx` says it is a chain tx body. Resolves to the signer's testnet
   * address and the signature.
   */
  async function sign(/** @type {string} */ wallet, /** @type {string} */ text, tx = false) {
    let r;
    if (wallet === 'extension') {
      status('Approve in the IronDivi Browser Wallet…');
      r = await signWithExtension(text, tx);
    } else if (wallet === 'web') r = await signWithWebWallet(text, show);
    else r = await signWithTelegram(text);
    return { address: signerOf(text, r.sig, r.address), sig: r.sig };
  }

  function signWithTelegram(/** @type {string} */ text) {
    tgCmd.textContent = `/sign ${NETWORK} ${text}`;
    tgPaste.value = '';
    tg.hidden = false;
    status('Waiting for the signature from Telegram…');
    tgPaste.focus();
    return new Promise((resolve, reject) => {
      tgResolve = (r) => {
        if (r === null) return; // the paste held no signature: parseTelegram said so; keep waiting
        tgResolve = null;
        tg.hidden = true;
        r === 'cancel' ? reject(new Error('Cancelled.')) : resolve(r);
      };
    });
  }

  /** Find the signature in the pasted reply: the base64 run that is a valid signature of the requested text. */
  function parseTelegram() {
    const text = (tgCmd.textContent ?? '').replace(`/sign ${NETWORK} `, '');
    for (const m of tgPaste.value.match(/[A-Za-z0-9+/]{86,88}={0,2}/g) ?? []) {
      try {
        return { address: addressFromPublicKey(recoverMessageSigner(text, m), NETWORK), sig: m };
      } catch {
        /* not this one */
      }
    }
    say(msg, 'No signature of this text found. Copy the signature from the wallet and paste it here.', 'error');
    return null;
  }

  async function connect(/** @type {keyof typeof WALLETS} */ wallet) {
    const buttons = /** @type {HTMLButtonElement[]} */ ([...out.querySelectorAll('button')]);
    buttons.forEach((b) => (b.disabled = true));
    try {
      const key = Key.generate(NETWORK);
      const until = Math.floor(Date.now() / 1000) + SESSION_SECS;
      const text = sessionText(key.address, until);
      const { address: owner, sig } = await sign(wallet, text);
      status('Signed. Starting your session on the chain…');
      const txid = await chain.send(key, { type: 'session', owner, until, sig });
      const receipt = await chain.waitForReceipt(txid);
      if (!receipt.ok) throw new Error(receipt.error || 'The chain refused the session.');
      session = { owner, key, until, wallet };
      store(where, session);
      say(msg, `Connected. You now play as ${short(owner)}.`, 'ok');
      changed();
    } catch (e) {
      const err = /** @type {any} */ (e);
      if (err?.install) {
        msg.replaceChildren(errText(e), ' ', el('a', { href: EXTENSION_URL, target: '_blank', rel: 'noopener' }, 'Install it'), ', then reload this page.');
        msg.dataset.kind = 'error';
        msg.hidden = false;
      } else say(msg, errText(e) === 'Cancelled.' ? '' : `Could not connect: ${errText(e)}`, 'error');
    } finally {
      buttons.forEach((b) => (b.disabled = false));
    }
  }

  async function disconnect() {
    const s = session;
    if (!s) return;
    session = null;
    store(where, null);
    say(msg, 'Disconnected. This browser plays with its guest key again.', 'ok');
    changed();
    try {
      await chain.send(s.key, { type: 'session_end' }); // end it on the chain too, so the key is worthless
    } catch {
      /* it expires on its own */
    }
  }

  // ---------- bridge ----------

  function fillDeposit() {
    if (!session || !bridgeAddress) return;
    const amount = depAmount.value.trim();
    const q = new URLSearchParams({ to: bridgeAddress, amount, op_return: session.owner });
    depWeb.href = `${WEB_WALLET_URL}?${q}`;
    depTg.textContent = `/send ${bridgeAddress} ${amount} ${session.owner}`;
    depTo.textContent = bridgeAddress;
    if (!wdTo.value) wdTo.value = session.owner;
  }

  async function refreshBridge() {
    if (!session || !bridgeAddress) return;
    try {
      const acct = await chain.account(session.owner);
      tdivi.textContent = formatAmount(String(acct?.balances?.TDIVI ?? '0'), TDIVI_DECIMALS);
    } catch {
      tdivi.textContent = '?';
    }
  }

  async function withdraw(/** @type {SubmitEvent} */ ev) {
    ev.preventDefault();
    const s = session;
    if (!s) return;
    wdBtn.disabled = true;
    try {
      const amount = parseAmount(wdAmount.value, TDIVI_DECIMALS);
      const to = wdTo.value.trim();
      if (!isAddress(to, NETWORK)) throw new Error(`Pay to a Divi ${NETWORK} address.`);
      // The owner signs this tx itself: a session key can never move funds.
      const owner = {
        address: s.owner,
        signMessage: async (/** @type {string} */ body) => {
          const r = await sign(s.wallet, body, true);
          if (r.address !== s.owner) throw new Error(`That was signed by ${short(r.address)}. Sign with ${short(s.owner)}, the address you play as.`);
          return r.sig;
        },
      };
      const txid = await chain.send(owner, { type: 'bridge', op: { kind: 'withdraw', amount, divi_address: to } });
      say(bridgeMsg, 'Sent. Waiting for the next block…');
      const receipt = await chain.waitForReceipt(txid);
      if (!receipt.ok) throw new Error(receipt.error || 'The withdrawal failed.');
      wdAmount.value = '';
      say(bridgeMsg, `Queued: ${formatAmount(amount, TDIVI_DECIMALS)} tDIVI to ${short(to)}. The operator pays it to that address on Divi testnet.`, 'ok');
      say(msg, '');
    } catch (e) {
      say(bridgeMsg, errText(e) === 'Cancelled.' ? '' : errText(e), 'error');
    } finally {
      wdBtn.disabled = false;
      refreshBridge();
    }
  }

  // ---------- start ----------

  render();
  if (chain.local) say(msg, `Development chain at ${chain.baseUrl}: wallet sessions here are separate from games.divi.domains.`, 'info');
  chain
    .info()
    .then((/** @type {any} */ info) => {
      const named = typeof info?.bridge_address === 'string' ? info.bridge_address : '';
      // Deposits go only to the pinned bridge: a chain naming another address could be someone else's node.
      bridgeAddress = chain.local || named === sdk.BRIDGE_ADDRESS ? named : '';
      if (named && !bridgeAddress) say(msg, 'This chain names an unknown bridge address, so deposits are turned off.', 'error');
      render();
      refreshBridge();
    })
    .catch(() => {});
  // A session ended elsewhere (revoked by the owner, or logged out in another tab) falls back to the guest key.
  if (session) {
    const s = session;
    chain
      .account(s.key.address)
      .then((/** @type {any} */ acct) => {
        if (!acct || !('session' in acct) || session !== s) return; // a chain without session keys: keep it
        const b = acct.session;
        if (!b || b.ended || b.owner !== s.owner) {
          session = null;
          store(where, null);
          say(msg, 'Your wallet session has ended. Connect again to play as your wallet.', 'info');
          changed();
        }
      })
      .catch(() => {});
  }
  return api;
}

let styled = false;
function injectStyle() {
  if (styled) return;
  styled = true;
  document.head.append(
    el(
      'style',
      {},
      `.dgw { margin-top: 12px; border-top: 1px solid var(--line); padding-top: 10px; }
.dgw-out, .dgw-in, .dgw-cmdrow { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.dgw-who { flex: 1 1 260px; color: var(--muted); font-size: 0.9rem; }
.dgw-tg { margin-top: 10px; display: grid; gap: 8px; }
.dgw-tg textarea { width: 100%; box-sizing: border-box; font: inherit; font-size: 0.85rem; padding: 8px; border-radius: 8px;
  border: 1px solid var(--line); background: var(--bg); color: var(--text); }
.dgw-cmd { flex: 1 1 260px; min-width: 0; overflow-wrap: anywhere; font-size: 0.8rem; padding: 6px 8px; border-radius: 6px;
  background: var(--bg); border: 1px solid var(--line); user-select: all; }
.dgw-bridge .dgw-cmdrow { margin: 8px 0; }
.dgw-bridge input { width: auto; flex: 1 1 140px; }
.dgw-bridge label input { width: 7em; margin: 0 4px; }
.dgw [hidden], .dgw-bridge[hidden] { display: none !important; }`,
    ),
  );
}
