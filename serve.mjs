#!/usr/bin/env node
// Serves this game on your own computer. It plays on the live Divi Games chain, against the same players as the
// website.
//
// Usage: node serve.mjs                 then open http://127.0.0.1:8080
//        PORT=9000 node serve.mjs       another port
//
// The page only talks to its own address, as on games.divi.domains: it asks this server for /chain/…, and the
// server passes those requests (and the live block feed) on to the real chain. Everything else is a file from
// this folder, so a change to the page needs only a browser reload. Needs Node.js 20 or newer and nothing else.
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { readdirSync, statSync, createReadStream } from 'node:fs';
import { dirname, extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
// The site and chain to play on. Only for testing this server; the pages trust games.divi.domains' sequencer.
const UPSTREAM = new URL(process.env.UPSTREAM || 'https://games.divi.domains');
const GAME = readdirSync(join(ROOT, 'play'), { withFileTypes: true }).find((d) => d.isDirectory()).name;
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.wasm': 'application/wasm',
};

/** Requests the live site answers: the chain API and the "your rank" line. */
const passed = (path) => path.startsWith('/chain/') || path === '/leaderboard/rank.json';

/** Headers for the live site: its own Host, and nothing that names this page or carries its cookies. */
function upstreamHeaders(headers) {
  const h = { ...headers, host: UPSTREAM.host };
  delete h.origin;
  delete h.referer;
  delete h.cookie;
  return h;
}

function forward(req, res) {
  const client = UPSTREAM.protocol === 'https:' ? https : http;
  const up = client.request(
    { hostname: UPSTREAM.hostname, port: UPSTREAM.port || undefined, path: req.url, method: req.method, headers: upstreamHeaders(req.headers) },
    (r) => {
      res.writeHead(r.statusCode, r.headers);
      r.pipe(res);
    },
  );
  up.on('error', (e) => {
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(`Could not reach ${UPSTREAM.origin}: ${e.message}\n`);
  });
  req.pipe(up);
}

/** The file under this folder a URL path names, or null. Hidden files and folders (.git) are never served. */
function fileFor(pathname) {
  let path;
  try {
    path = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (path.split('/').some((part) => part.startsWith('.'))) return null;
  const file = join(ROOT, normalize(path));
  if (file !== ROOT && !file.startsWith(ROOT + sep)) return null;
  try {
    const st = statSync(file);
    if (st.isFile()) return file;
    if (st.isDirectory() && statSync(join(file, 'index.html')).isFile()) return join(file, 'index.html');
  } catch { /* no such file */ }
  return null;
}

const redirect = (res, to) => res.writeHead(302, { location: to }).end();

const server = http.createServer((req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  if (passed(pathname)) return forward(req, res);
  if (pathname === '/' || pathname === '/play' || pathname === '/play/') return redirect(res, `/play/${GAME}/`);
  if (req.method !== 'GET' && req.method !== 'HEAD') return res.writeHead(405).end();
  const file = fileFor(pathname);
  if (file) {
    if (!pathname.endsWith('/') && file.endsWith(`${sep}index.html`) && !pathname.endsWith('.html')) return redirect(res, `${pathname}/`);
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
    return req.method === 'HEAD' ? res.end() : createReadStream(file).pipe(res);
  }
  // The site's other pages (leaderboard, explorer, the other games) open on the real site.
  if (!extname(pathname)) return redirect(res, new URL(req.url, UPSTREAM).href);
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Not found\n');
});

// The live block feed is a WebSocket at /chain/v1/ws: pass the upgrade through as it is.
server.on('upgrade', (req, sock, head) => {
  if (!passed(new URL(req.url, 'http://localhost').pathname)) return sock.destroy();
  const secure = UPSTREAM.protocol === 'https:';
  const port = Number(UPSTREAM.port) || (secure ? 443 : 80);
  const onConnect = () => {
    const lines = Object.entries(upstreamHeaders(req.headers)).map(([k, v]) => `${k}: ${v}`);
    up.write(`${req.method} ${req.url} HTTP/1.1\r\n${lines.join('\r\n')}\r\n\r\n`);
    up.write(head);
    sock.pipe(up).pipe(sock);
  };
  const up = secure
    ? tls.connect({ host: UPSTREAM.hostname, port, servername: UPSTREAM.hostname }, onConnect)
    : net.connect(port, UPSTREAM.hostname, onConnect);
  up.on('error', () => sock.destroy());
  sock.on('error', () => up.destroy());
});

const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 8080);
server.on('error', (e) => {
  console.error(e.code === 'EADDRINUSE' ? `Port ${port} is in use. Pick another: PORT=9000 node serve.mjs` : e.message);
  process.exit(1);
});
server.listen(port, host, () => {
  const at = `${host}:${server.address().port}`;
  console.log(`Playing ${GAME} on ${UPSTREAM.host}: open http://${at}/play/${GAME}/\nPress Ctrl-C to stop.`);
});
