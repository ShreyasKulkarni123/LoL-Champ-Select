# Champ Select Remote

Do champ select from your phone when you're away from your computer. You can:

- **accept the ready check** when a match is found
- see **both teams' picks**, your teammates' hovers, and **ally and enemy bans**, with the phase timer
- browse **your unlocked champions** (owned plus free rotation), search them, **hover** one, and **lock in** or **ban**

<p>
  <img src="docs/ready-check.png" width="220" alt="Ready check screen">
  <img src="docs/ban.png" width="220" alt="Ban phase">
  <img src="docs/pick.png" width="220" alt="Pick phase">
</p>

<sub>These screenshots come from the built-in mock client, so champion icons are coloured placeholders. With the real client you get the real icons.</sub>

## How it works

```
 ┌──────────────┐    Wi-Fi / LAN     ┌────────────────────┐   localhost    ┌───────────────┐
 │  Phone app   │ ◀───────────────▶  │ Companion (your PC)│ ◀────────────▶ │ League Client │
 │ (Expo / RN)  │  WebSocket + token │  Node.js           │   LCU API      │               │
 └──────────────┘                    └────────────────────┘                └───────────────┘
```

Riot's public web API ([developer.riotgames.com](https://developer.riotgames.com)) **does not expose champ select**.
Champ select lives only in the League Client's local API (the "LCU" API). That API listens on `127.0.0.1` with a
random port and password, so your phone can't reach it directly.

That's why the project has two parts:

| Folder | What it is |
|---|---|
| [`companion/`](companion) | A small Node.js program that runs on the same PC as League. It finds the client's port and password, subscribes to champ select / ready check / gameflow events over the client's WebSocket, and re-serves a simplified live state to your phone. Commands from the phone (hover, lock in, ban, accept) become LCU calls. Champion icons are proxied from the client too. |
| [`mobile/`](mobile) | An Expo (React Native) app for iOS and Android. You pair it with the companion once (scan a QR code), and from then on it follows the client: lobby → queue → ready check → champ select → in game. |

## Quick start

### 1. Run the companion on your PC

Requires [Node.js](https://nodejs.org) 22 or newer.

```bash
cd companion
npm install
npm start
```

It prints a QR code plus a host, port and pairing code. Leave it running. It finds the League Client on its own,
whether you start League before or after it. The first time, Windows may ask whether Node.js can use the network:
allow it on **private networks** so the phone can connect.

Options: `npm start -- --port 9000`, `--lockfile "<path to League>/lockfile"` if detection fails, and
`--reset-token` to un-pair every phone.

### 2. Run the app on your phone

```bash
cd mobile
npm install
npx expo start
```

Scan the Expo QR code with **Expo Go** ([iOS](https://apps.apple.com/app/expo-go/id982107779) /
[Android](https://play.google.com/store/apps/details?id=host.exp.exponent)). In the app, tap **Scan QR code** and scan
the companion's QR code, or type the host, port and code by hand. The phone needs to be on the same Wi-Fi as the PC.

To install the app for real, without Expo Go, build it with EAS: `npx eas-cli@latest build -p android` (or `-p ios`).
Change `bundleIdentifier` and `package` in `mobile/app.json` first.

### Try it without League running

The companion includes a fake League Client. It runs lobby → queue → ready check → a ranked-style draft with bot
teammates and enemies, and loops forever:

```bash
cd companion
npm run dev:mock                 # mock client and companion together
npm run dev:mock -- --speed 3    # everything 3x faster
```

Pair the phone with it the same way. Your own turns wait for you, just like the real thing.

## Using it away from home

The phone talks to your PC directly. If you're on the same Wi-Fi (couch, kitchen, bathroom), it just works.
To use it from somewhere else, put both devices on a private VPN such as [Tailscale](https://tailscale.com). Then pair
using the PC's Tailscale IP (`100.x.y.z`); the companion lists it under "other addresses". **Don't port-forward the
companion to the internet.**

## Security

- The companion only accepts connections that present the pairing code, which is a random 144-bit token stored in
  `~/.lol-champ-select/config.json`. Anyone on your network who has the code can control your champ select. Use
  `--reset-token` if it leaks.
- Traffic between phone and PC is plain `ws://` on your LAN, so only use it on networks you trust (or over Tailscale,
  which encrypts it).
- The companion only ever talks to the League Client on `127.0.0.1`.

## Development

```bash
cd companion && npm test          # unit tests plus an end-to-end draft against the mock client
cd companion && npm run typecheck
cd mobile && npm run typecheck
```

The phone ↔ companion messages are defined in `companion/src/protocol.ts`, and `mobile/src/protocol.ts` is a copy of
it. Keep the two in sync.

LCU endpoints used:

| Purpose | Endpoint |
|---|---|
| Live updates | WAMP subscribe to `OnJsonApiEvent_lol-champ-select_v1_session`, `…_lol-gameflow_v1_gameflow-phase`, `…_lol-matchmaking_v1_ready-check` |
| Champ select state | `GET /lol-champ-select/v1/session` |
| Unlocked / bannable champions | `GET /lol-champ-select/v1/pickable-champion-ids`, `GET /lol-champ-select/v1/bannable-champion-ids` |
| Hover / lock in / ban | `PATCH /lol-champ-select/v1/session/actions/{id}` with `{ championId }` or `{ championId, completed: true }` |
| Ready check | `POST /lol-matchmaking/v1/ready-check/accept` and `/decline` |
| Champion names and icons | `/lol-game-data/assets/v1/champion-summary.json`, `/lol-game-data/assets/v1/champion-icons/{id}.png` |
| Teammate names | `GET /lol-summoner/v2/summoners/puuid/{puuid}` |

## Not included yet

Ideas for later: rune page and summoner spell editing, bench swaps in ARAM, pick-order and position trades, and push
notifications while the app is in the background. For now, keep the app open (it keeps the screen awake during queue
and champ select, and vibrates when it's your turn).

## Disclaimer

The LCU API is unofficial and undocumented. Riot can change it at any time, and it can break with a client patch.
This tool only does what you tap; it never picks or bans for you on its own. Even so, read
[Riot's third-party tool policies](https://developer.riotgames.com/policies/general) and use it at your own risk.

Champ Select Remote isn't endorsed by Riot Games and doesn't reflect the views or opinions of Riot Games or anyone
officially involved in producing or managing Riot Games properties. Riot Games, and all associated properties are
trademarks or registered trademarks of Riot Games, Inc.
