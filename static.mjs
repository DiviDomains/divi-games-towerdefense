#!/usr/bin/env node
// Makes a copy of this game that any plain file host can serve: IPFS, a Tor onion service's web server, a USB
// stick behind `python3 -m http.server`. Nothing runs on that host, so nothing passes /chain on as serve.mjs
// does: instead each page names the chain it plays on, and the site its links open, in two meta tags the SDK
// reads, and its links to its own files are made relative so it works under any path, such as /ipfs/<cid>/.
//
// Usage: npm run static                                   writes the copy to dist/
//        node static.mjs [--chain URL] [--site URL] [OUT]  writes it to OUT (default dist)
//
//   --chain   the chain API the game talks to      default https://games.divi.domains/chain
//   --site    where links to the leaderboard etc. go  default https://games.divi.domains
//
// The chain only answers pages from games.divi.domains and from your own computer (http://127.0.0.1 or
// localhost, any port), so open the copy from one of those, for example through a local IPFS gateway at
// http://127.0.0.1:8080/ipfs/<cid>/. Needs Node.js 20 or newer and nothing else.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, posix, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Where the copy plays and links to unless told otherwise: the public testnet. */
export const DEFAULTS = { chain: 'https://games.divi.domains/chain', site: 'https://games.divi.domains' };

/** The folders of a game that are the game itself; everything else here (the server, the readme) stays behind. */
const TREES = ['play', 'sdk', 'vendor', 'static'];

/** Every file under `root`'s game folders, as paths relative to `root` with forward slashes. */
function filesIn(root) {
  const found = [];
  const walk = (rel) => {
    for (const d of readdirSync(join(root, rel), { withFileTypes: true })) {
      if (d.name.startsWith('.')) continue;
      const p = posix.join(rel, d.name);
      if (d.isDirectory()) walk(p);
      else if (d.isFile()) found.push(p);
    }
  };
  for (const t of TREES) if (existsSync(join(root, t))) walk(t);
  return found.sort();
}

/** A path from the folder `from` to `to`, both relative to the copy's root. */
const relativeTo = (from, to) => posix.relative(from, to) + (to.endsWith('/') ? '/' : '');

/**
 * One page, made to work as a plain file at path `page` in the copy: the meta tags naming its chain and site,
 * links to files in the copy made relative, and links to the site's pages made absolute on `site`.
 * @param {string} html @param {string} page @param {Set<string>} files @param {{chain: string, site: string}} where
 */
export function staticPage(html, page, files, { chain, site }) {
  const dir = posix.dirname(page);
  const attr = (/** @type {string} */ v) => v.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  const metas = `\n  <meta name="divigames-chain" content="${attr(chain)}">\n  <meta name="divigames-site" content="${attr(site)}">`;
  if (!html.includes('<meta charset="utf-8">')) throw new Error(`${page}: no <meta charset="utf-8"> to put the chain after`);
  const base = site.replace(/\/+$/, '');
  return html
    .replace('<meta charset="utf-8">', (m) => m + metas)
    .replace(/\b(src|href)="\/(?!\/)([^"]*)"/g, (_, a, ref) => {
      const path = ref.split(/[?#]/)[0];
      return `${a}="${files.has(path) ? relativeTo(dir, path) + ref.slice(path.length) : `${base}/${ref}`}"`;
    });
}

/** Writes the plain-file copy of the game in `src` to `dest` (replacing it) and returns `dest`. */
export function makeStatic(src, dest, where = DEFAULTS) {
  for (const u of [where.chain, where.site]) {
    let url;
    try { url = new URL(u); } catch { url = null; }
    if (!url || !/^https?:$/.test(url.protocol) || url.username || url.password) {
      throw new Error(`not an http(s) address: ${u}`);
    }
  }
  const game = readdirSync(join(src, 'play'), { withFileTypes: true }).find((d) => d.isDirectory())?.name;
  if (!game) throw new Error(`${src}: no play/<game>/ folder`);
  const files = filesIn(src);
  const set = new Set(files);
  rmSync(dest, { recursive: true, force: true });
  for (const f of files) {
    mkdirSync(dirname(join(dest, f)), { recursive: true });
    if (f.endsWith('.html')) writeFileSync(join(dest, f), staticPage(readFileSync(join(src, f), 'utf8'), f, set, where));
    else cpSync(join(src, f), join(dest, f));
  }
  // The copy's own address opens the game, relatively, so it works under /ipfs/<cid>/ as well as at a root.
  writeFileSync(join(dest, 'index.html'), `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta http-equiv="refresh" content="0; url=play/${game}/">
  <title>Divi Games: ${game}</title>
</head>
<body><p><a href="play/${game}/">Play ${game}</a></p></body>
</html>
`);
  if (existsSync(join(src, 'LICENSE'))) cpSync(join(src, 'LICENSE'), join(dest, 'LICENSE'));
  return dest;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const where = { ...DEFAULTS };
  let out = 'dist';
  while (args.length) {
    const a = args.shift();
    if (a === '--chain' || a === '--site') where[a.slice(2)] = args.shift() ?? '';
    else if (a.startsWith('-')) {
      console.error('usage: node static.mjs [--chain URL] [--site URL] [OUT]');
      process.exit(2);
    } else out = a;
  }
  const root = dirname(fileURLToPath(import.meta.url));
  const dest = makeStatic(root, resolve(out), where);
  console.log(`Wrote ${relative(process.cwd(), dest) || '.'}: plays on ${where.chain}, links to ${where.site}`);
}
