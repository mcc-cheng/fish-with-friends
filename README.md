# Fish with Friends

An online version of **Fish** (also called Literature or Canadian Fish), the team card game where you ask
opponents for cards, keep track of who has what, and declare whole sets.

Create a room, send the link to your friends, pick teams and play. Bots can fill empty seats.

## Run it

Needs Node 20 or newer.

```sh
npm install
npm start          # http://localhost:3000
```

`PORT` and `HOST` change where it listens. `npm run dev` restarts the server when a file changes, and
`npm test` runs the tests.

To try it alone, open the room link in a few browser tabs (each tab is a separate player), or add bots in
the lobby.

### Playing with people outside your network

The server is one Node process that serves the page and a WebSocket at `/ws`. Put it anywhere that runs
Node and allows WebSockets (Render, Fly.io, Railway, a VPS), or expose your own machine with a tunnel such
as `cloudflared tunnel --url http://localhost:3000`.

Rooms live in memory, so run a single instance, and expect games to end if the server restarts.

## How the game works here

- 4, 6 or 8 players in two equal teams, seated alternately.
- The deck is split into nine **sets**: the low cards and the high cards of each suit, plus the four 8s
  with the jokers.
- On your turn you **ask** one opponent for one exact card. You must hold a card from the same set and
  can't ask for a card you already have. If they have it you take it and go again; if not, it's their turn.
- You **declare** a set by saying which teammate holds each of its cards. All of them right: your team
  wins the set. Anything wrong: the other team gets it. Either way the cards leave play.
- A player who runs out of cards hands the turn to the next teammate who has some. When a whole team is
  out of cards, the other team has to declare everything that's left.
- Most sets wins. With nine sets there are no ties.

The host picks the house rules in the lobby:

| Rule | Options |
| --- | --- |
| Deck | **Nine sets of six** (54 cards): low is 2–7, high is 9–A, and the 8s plus two jokers make the ninth set. **Nine sets of eight** (72 cards): the same deck stretched with a 0, 1, 11 and 12 in every suit and four jokers, so low is 0–7 and high is 9–A. It gives 8 players nine cards each. |
| Declaring | **On your turn** only, or **any time** by anyone. |
| Question history | **Full log** for everyone, or the **last question only** as at a real table. |

Dropping out doesn't lose your seat: reloading or reconnecting puts you back in it. If someone is gone for
good, the host can let a bot play their cards, or anyone who opens the room link can take over the seat.

## Code map

```
shared/cards.js   card and set definitions, used by server and browser
server/game.js    the rules: deal, ask, declare, turn passing, scoring (no networking)
server/bot.js     computer player; works only from its hand and the public log
server/rooms.js   rooms, lobby, reconnects, and the per-player view of a game
server/app.js     HTTP static files + WebSocket transport
server/index.js   entry point
public/           the browser client (plain ES modules, no build step)
test/             rules tests, bot self-play, and end-to-end tests over real WebSockets
```

The server is the only authority: clients send `ask` and `declare` messages, the server checks them
against the rules and sends each player a view containing only their own hand.
