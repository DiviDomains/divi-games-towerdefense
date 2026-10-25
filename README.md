# Tower defense · Divi Games

Build towers against waves. Your browser runs the simulation in WebAssembly, and the node replays the same code to check your score.

This is the game from [games.divi.domains/play/towerdefense](https://games.divi.domains/play/towerdefense/) as a folder
you can run on your own computer. It is only the page: the chain it plays on is the live Divi Games chain, so
you play against the same players, with the same testnet GOLD, as on the website.

## Run it

You need [Node.js](https://nodejs.org) 20 or newer and Git. Nothing else gets installed.

```sh
git clone https://github.com/DiviDomains/divi-games-towerdefense.git
cd divi-games-towerdefense
node serve.mjs
```

Open http://127.0.0.1:8080 and play. Press **Ctrl-C** in the terminal to stop.

## How it works

The game is a web page and a few JavaScript modules, run by your browser. A browser page may only talk to the
address it came from, so `serve.mjs` does two jobs on that one address:

- it serves the files in this folder, and
- it passes every request for `/chain/…` (and the live block feed) on to `https://games.divi.domains/chain/`.

Every move you make is a transaction signed in your browser and sent to the live chain. The chain checks the
rules, so a changed page can only ever send moves the chain accepts.

## Your play key

The page makes a **testnet play key** the first time you open it and keeps it in your browser. Browsers keep it
per address, so the key at `127.0.0.1:8080` is a new one, not the one you use on games.divi.domains. To play
with the same GOLD in both places, open **Play key** on the page, press **Show WIF** on one, and paste it into
the import box on the other. Treat the WIF like a password: anyone who has it can spend that key's GOLD.

New keys start with no GOLD: press the **faucet** button for some.

## Change it

| File | What it is |
|---|---|
| `play/towerdefense/index.html`, `app.js`, `style.css` | the game page |
| `play/brand.css` | the colours and fonts shared by every game |
| `sdk/divigames.js` | the client library: keys, signing, sending transactions, reading the chain |
| `vendor/` | the audited [@noble](https://paulmillr.com/noble/) cryptography libraries the SDK uses |
| `serve.mjs` | the small server above |

Edit a file and reload the page; there is no build step. The
[Build a game](https://games.divi.domains/learn/build-a-game) course explains the SDK and how a game talks to
the chain.

Links to the site's other pages (the leaderboard, your account, the other games) open on games.divi.domains.

## Options

```sh
PORT=9000 node serve.mjs         # another port
HOST=0.0.0.0 node serve.mjs      # let other computers on your home network open it
```

## When something goes wrong

- **"Port 8080 is in use"**: something else has that port. Pick another with `PORT=`.
- **"Could not reach https://games.divi.domains"**: your computer is offline, or the site is down.
- **No balance and the buttons fail**: open the address `serve.mjs` printed. Opening `index.html` as a file
  does not work, because the page needs `/chain` at its own address.

## Licence

MIT, apart from the parts listed in [LICENSE](LICENSE).
