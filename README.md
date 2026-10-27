# Tower defense · Divi Games

Build towers against waves. Your browser runs the simulation in WebAssembly, and the node replays the same code to check your score.

This is the game from [games.divi.domains/play/towerdefense](https://games.divi.domains/play/towerdefense/) as a folder
you can run on your own computer. It is only the page: the chain it plays on is the live Divi Games chain, so
you play against the same players, with the same testnet GOLD, as on the website.

## Run it

Pick one. Each needs only what it names; nothing else gets installed.

**With Node.js** ([Node.js](https://nodejs.org) 20 or newer, and Git):

```sh
git clone https://github.com/DiviDomains/divi-games-towerdefense.git
cd divi-games-towerdefense
npm start
```

Your browser opens at http://127.0.0.1:8083/play/towerdefense/. Press **Ctrl-C** in the terminal to stop.
(`node serve.mjs` does the same without opening the browser. `npm install` is not needed: there are no
dependencies.)

**With Docker** ([Docker](https://docs.docker.com/get-docker/) with Compose, and Git):

```sh
git clone https://github.com/DiviDomains/divi-games-towerdefense.git
cd divi-games-towerdefense
docker compose up --build
```

Open http://localhost:8083/play/towerdefense/. Press **Ctrl-C** to stop, or run it in the background with
`docker compose up --build -d` and stop it with `docker compose down`.

**All four games at once**: each game has its own port (tic-tac-toe 8081, blackjack 8082, tower defense 8083,
season market 8084), so they run side by side. The
[Run a game at home](https://games.divi.domains/learn/build-a-game/06-run-it-at-home) lesson has one
`compose.yaml` that starts all four.

## How it works

The game is a web page and a few JavaScript modules, run by your browser. A browser page may only talk to the
address it came from, so `serve.mjs` does two jobs on that one address:

- it serves the files in this folder, and
- it passes every request for `/chain/…` (and the live block feed) on to `https://games.divi.domains/chain/`.

Every move you make is a transaction signed in your browser and sent to the live chain. The chain checks the
rules, so a changed page can only ever send moves the chain accepts.

## Put it on IPFS, or any plain file host

`npm run static` (or `node static.mjs`) writes `dist/`: the game alone, with nothing to run. Each page names the
chain it plays on in a meta tag and its links are relative, so any host that serves files can serve it, under any
path. To publish it on IPFS:

```sh
npm run static
ipfs add -r --cid-version 1 -Q dist      # prints the folder's CID
```

and open `/ipfs/<CID>/` on your IPFS node's own gateway, the `http://127.0.0.1:…` address that `ipfs daemon` (or
IPFS Desktop) prints as "Gateway server listening". The chain only answers
pages from games.divi.domains and from your own computer (`127.0.0.1` or `localhost`), so a public gateway shows
the game but cannot play it. `--chain URL` points the copy at another chain, such as one you run yourself;
`--site URL` is where its links to the leaderboard and the other pages go. The
[Run every game four ways](https://games.divi.domains/learn/run-every-game) course covers IPFS and Tor step by
step.

## Your play key

The page makes a **testnet play key** the first time you open it and keeps it in your browser. Browsers keep it
**per address**, so `127.0.0.1:8083` gets a new key with no GOLD: not the one you use on
games.divi.domains, and not the one another game at home uses. Press **Get GOLD** for some, or keep one
identity everywhere in either of two ways:

- **Connect a wallet** (Browser Wallet, Web Wallet or Telegram) on each page: you play as your wallet's
  address wherever you open the game.
- **Import a key**: open **Play key** on the website, press **Show WIF**, and paste it into the import box on
  the page here. Treat the WIF like a password: anyone who has it can spend that key's GOLD.

`127.0.0.1` and `localhost` count as different addresses too, so stick to one.

## Change it

| File | What it is |
|---|---|
| `play/towerdefense/index.html`, `app.js`, `style.css` | the game page |
| `play/brand.css` | the colours and fonts shared by every game |
| `sdk/divigames.js` | the client library: keys, signing, sending transactions, reading the chain |
| `vendor/` | the audited [@noble](https://paulmillr.com/noble/) cryptography libraries the SDK uses |
| `serve.mjs` | the small server above |
| `static.mjs` | makes the plain-file copy in `dist/` |
| `Dockerfile`, `compose.yaml` | the Docker way to run it |

Edit a file and reload the page; there is no build step. (With Docker, run `docker compose up --build` again
after a change, since the image holds a copy of the folder.) The
[Build a game](https://games.divi.domains/learn/build-a-game) course explains the SDK and how a game talks to
the chain.

Links to the site's other pages (the leaderboard, your account, the other games) open on games.divi.domains.

## Options

```sh
PORT=9000 npm start              # another port
HOST=0.0.0.0 npm start           # let other computers on your home network open it
```

With Docker, change the `ports:` line in `compose.yaml` instead: `"9000:8083"` for another port, or drop
the `127.0.0.1:` for your home network. Only let your home network in on a network you trust.

## When something goes wrong

- **"Port 8083 is in use"**: the game is already running in another terminal, or something else has the
  port. Stop the other one, or pick another port with `PORT=`.
- **`npm start` does not open a browser**: open the address it printed yourself.
- **"Could not reach https://games.divi.domains"**: your computer is offline, or the site is down.
- **No balance and the buttons fail**: open the address `serve.mjs` printed. Opening `index.html` as a file
  does not work, because the page needs `/chain` at its own address.

## Licence

MIT, apart from the parts listed in [LICENSE](LICENSE).
