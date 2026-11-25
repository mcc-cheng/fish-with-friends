# Fish with Friends

An online version of **Fish** (also called Literature or Canadian Fish), the team card game where you ask
opponents for cards, keep track of who has what, and declare whole sets.

The site opens on a lobby: a list of public games to join or watch, a chat, and buttons to start a public
or a private game. Bots can fill empty seats, games between people are Elo-rated, and each browser has a
profile with its statistics and every game it has finished.

## Run it

Needs Node 20 or newer.

```sh
npm install
npm start          # http://localhost:3000
```

`PORT` and `HOST` change where it listens, and `DATA_DIR` (default `./data`) is where ratings and the
record of finished games are saved. `npm test` runs the tests.

**While the code is changing, use `npm run dev` instead of `npm start`.** It restarts the server whenever
a server file changes. A server left running across an update keeps its old code in memory while serving
the new page files, and the two don't match. If that happens the site shows a yellow notice asking for a
restart: stop the server with Ctrl+C and start it again.

To try it alone, create a game and add bots. To be several players at once, open the game's link in more
tabs: while your first tab is connected, each extra tab joins as another player. (They share one profile,
so those games are practice games; use a second browser or a private window for separately rated players.)

### Playing with people outside your network

The server is one Node process that serves the page and a WebSocket at `/ws`. Put it anywhere that runs
Node and allows WebSockets (Render, Fly.io, Railway, a VPS), or expose your own machine with a tunnel such
as `cloudflared tunnel --url http://localhost:3000`.

Rooms and the lobby chat live in memory, so run a single instance, and expect games in progress to end if
the server restarts. Two things are written to disk: ratings (`data/ratings.json`) and finished games
(`data/games.jsonl`). On a host with a throwaway filesystem, point `DATA_DIR` at a persistent volume or
ratings and profiles reset on every deploy.

## Finding your way around

| Page | What it is |
| --- | --- |
| `/` | The lobby: chat, the list of games (with "Your games" and the leaderboard as tabs), and the buttons to create a game. |
| `/ABCD` | A game, by its four-letter code. Opening the link joins it; there is no sign-up or name prompt. |
| `/profile` | Your name, statistics and game history. Also reached by clicking your name in the top bar. |
| `/help` | The rules. Nothing is explained up front, on the assumption that players know the game. |

A **public** game is listed in the lobby for anyone to join, or to watch once it has started. A **private**
game is listed only for the people in it and is joined by its link or code. A new browser is given a
placeholder name ("Guest 1234"), which can be changed on the profile page.

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
| Bot moves | **One at a time**: a bot waits until a player presses Next (or Space), so everyone can follow each move. **Automatic**: bots play by themselves after a short pause. |
| Question history | **Full log** for everyone, or the **last question only** as at a real table. |

With bots moving one at a time, any seated player (or the host) can press Next, and each press lets the
bot make exactly one decision. If two people press at once, only one move happens.

Dropping out doesn't lose your seat: reloading, reconnecting, or opening the game again from the same
browser (it stays under "Your games" in the lobby) puts you back in it. If someone is gone for good, the
host can let a bot play their cards, or a spectator can take over the seat.

Cards use a four-colour deck: spades black, hearts red, diamonds blue, clubs green. The page follows your
system's light or dark setting, and the button in the top corner switches between them.

## Ratings

Every player has an Elo rating, starting at 1000, shown beside their name in the lobby. The home page has
the leaderboard.

- **Who you are.** There are no accounts. Each browser keeps a random key, and the server stores your
  rating and your games under a hash of it. Clearing site data or switching browser starts a new record
  at 1000, and two people can have the same name on the leaderboard.
- **Your profile.** Every game you finish is listed there, rated or not, with the score, who you played
  with and against, and the rating change. Games the host ends early are not recorded.
- **Which games count.** A game is rated when each team has at least one human player and nobody is in two
  seats (two tabs of one browser are the same player). Anything else is a practice game, and the lobby
  says which it will be. A game the host ends early changes nothing.
- **How much moves.** A team's rating is the average of its players, with bots counted as 1000. The
  winners' expected score is `1 / (1 + 10^((losers - winners) / 400))`, and every winner gains
  `32 x (1 - expected)` points, rounded, which every loser drops. Evenly matched teams move 16; beating a
  stronger team is worth more. The margin in sets doesn't matter.
- **Who gets the points.** Whoever was seated when the game started, even if they leave or someone takes
  over their seat.

Ratings rest on trust: anyone could open two browsers and feed one rating from the other. That is fine
among friends and not something to build a public ladder on.

## Code map

```
shared/cards.js   card and set definitions, used by server and browser
public/fonts/     Nunito, the typeface, bundled under the SIL Open Font Licence (licence alongside)
server/game.js    the rules: deal, ask, declare, turn passing, scoring (no networking)
server/bot.js     computer player; works only from its hand and the public log
server/ratings.js Elo arithmetic and the JSON file ratings are kept in
server/history.js the record of finished games, read back for profiles
server/rooms.js   rooms, the lobby and its chat, reconnects, and the per-player view of a game
server/app.js     HTTP static files + WebSocket transport
server/index.js   entry point
public/           the browser client (plain ES modules, no build step)
test/             rules, bot self-play, ratings, history, and end-to-end tests over real WebSockets
```

The server is the only authority: clients send `ask` and `declare` messages, the server checks them
against the rules and sends each player a view containing only their own hand.
