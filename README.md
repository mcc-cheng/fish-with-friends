# Fish with Friends

An online version of **Fish** (also called Literature or Canadian Fish), the team card game where you ask
opponents for cards, keep track of who has what, and declare whole sets.

The site opens on a lobby: a list of public games to join or watch, a chat, and buttons to start a public
or a private game. Bots can fill empty seats, games are Elo-rated (the bots have a rating too), and each
browser has a profile with its statistics and every game it has finished. A finished game can be looked
back at move by move, with every hand face up and a note on each move.

## Run it

Needs Node 20 or newer.

```sh
npm install
npm start          # http://localhost:3000
```

`PORT` and `HOST` change where it listens, and `DATA_DIR` (default `./data`) is where ratings, finished
games and the games in progress are saved. `npm test` runs the tests.

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

Run a single instance: the rooms are held in one process's memory. Four things are written to disk:

- ratings (`data/ratings.json`);
- the list of finished games (`data/games.jsonl`);
- the full record of each one, its deal and every move (`data/games/<id>.json`);
- the rooms open right now, with any game in progress (`data/rooms/<CODE>.json`).

The last of these is what lets a restart or a redeploy carry on where it stopped. Each room is saved as it
changes and removed when it closes. A new process reads them back, and the players' browsers, which keep
trying to reconnect, land in their seats again: the same hands, the same log, the same time banks, with the
move in progress given its time afresh. Only the lobby chat is lost. A room's file holds its players' seat
tokens, so treat the folder as you would the server's memory.

On a host with a throwaway filesystem, point `DATA_DIR` at a persistent volume, or ratings, profiles,
reviews and the games in progress are all lost on every deploy.

## Finding your way around

| Page | What it is |
| --- | --- |
| `/` | The lobby: chat, the list of games (with "Your games" and the leaderboard as tabs), and the buttons to create a game. |
| `/ABCD` | A game, by its four-letter code. Opening the link joins it; there is no sign-up or name prompt. |
| `/profile` | Your name, statistics and game history, and the code for using the profile on another device. Also reached by clicking your name in the top bar. |
| `/game/<id>` | A finished game, played back move by move. |
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
- You **declare** a set by saying who holds each of its cards. The players you name must all be on one
  team: your own, or the other one. All of them right: your team wins the set, even if the other team
  held it. Anything wrong: the other team gets it. Either way the cards leave play.
- You can declare whenever your team has the turn, even if it is a teammate's turn and not yours.
- A player who runs out of cards hands the turn to the next teammate who has some. When a whole team is
  out of cards, the other team has to declare everything that's left.
- Moves can be timed. Each move has a fixed time; go over it and your **time bank** runs down, extra time
  that has to last you the whole game. When both are gone you lose the turn: it passes to the next
  opponent round the table who has cards. Bots are not timed.
- Most sets wins. With nine sets there are no ties.

The host picks the house rules in the lobby:

| Rule | Options |
| --- | --- |
| Deck | **Nine sets of six** (54 cards): low is 2–7, high is 9–A, and the 8s plus two jokers make the ninth set. **Nine sets of eight** (72 cards): the same deck stretched with a 0, 1, 11 and 12 in every suit and four jokers, so low is 0–7 and high is 9–A. It gives 8 players nine cards each. |
| Declaring | **On your team's turn** (anyone on the team that has the turn), **on your own turn** only, or **any time** by anyone. |
| Bot moves | **One at a time**: a bot waits until a player presses Next (or Space), so everyone can follow each move. **Automatic**: bots play by themselves after a short pause. |
| Question history | **Full log** for everyone, or the **last question only** as at a real table. |
| Time per move | **1 minute** unless changed: anything from 10 seconds to 5 minutes, or **no limit**. |
| Time bank | **2 minutes** per player unless changed: from 15 seconds to 10 minutes, or **none**. |

With bots moving one at a time, any seated player (or the host) can press Next, and each press lets the
bot make exactly one decision. If two people press at once, only one move happens.

Dropping out doesn't lose your seat: reloading, reconnecting, or opening the game again from the same
browser (it stays under "Your games" in the lobby) puts you back in it. If someone is gone for good, the
host can let a bot play their cards, or a spectator can take over the seat.

Every game has a chat of its own for the people in it: beside the teams while waiting for players, and on
a tab next to the game log once the game is on, with a count of what you haven't read. A short tone plays
when the turn comes to you, and a double beep when your clock is down to ten seconds; the speaker button
in the top bar switches them off.

Cards use a four-colour deck: spades black, hearts red, diamonds blue, clubs green. The page follows your
system's light or dark setting, and the button in the top corner switches between them.

## Ratings

Every player has an Elo rating, starting at 1000, shown beside their name in the lobby. The home page has
the leaderboard.

- **Who you are.** There are no accounts. Each browser keeps a random key, and the server stores your
  rating and your games under a hash of it. Clearing site data or switching browser starts a new record
  at 1000, and two people can have the same name on the leaderboard.
- **Another device.** To play as yourself on a second phone or computer, press **Get a code** on the
  profile page and type the code into the profile page of the other device. That browser then takes on
  the first one's key, and with it the name, rating and games. A code works once and lasts ten minutes.
  The key itself waits in the server's memory for that long and is never written to disk.
- **Your profile.** Every game you finish is listed there, rated or not, with the score, who you played
  with and against, the rating change, and a link to its review. Games the host ends early are not recorded.
- **Which games count.** Every game is rated, against people or bots, unless the same player is in two
  seats (two tabs of one browser are the same player) or nobody playing has a rating to play for. Those
  are practice games, and the lobby says which it will be. A game the host ends early changes nothing.
- **How much moves.** A team's rating is the average of its players. The winners' expected score is
  `1 / (1 + 10^((losers - winners) / 400))`, and every winner gains `32 x (1 - expected)` points, rounded,
  which every loser drops. Evenly matched teams move 16; beating a stronger team is worth more. The
  margin in sets doesn't matter.
- **The bots.** Every bot runs the same program, so the bots share one rating. It is shown beside each
  bot, counts as that bot's rating in its team's average, and has a row on the leaderboard. After a rated
  game it moves once, however many seats the bots filled: by the full amount if they were all on one
  team, and by the balance of their seats if they were on both (one seat on the winning team and two on
  the losing team loses a third). The same number on each team cancels out.
- **Who gets the points.** Whoever was seated when the game started, even if they leave or someone takes
  over their seat.

Ratings rest on trust: anyone could open two browsers and feed one rating from the other. That is fine
among friends and not something to build a public ladder on.

## Looking back at a game

When a game ends, **Review the game** opens it at `/game/<id>`: a page anyone with the link can see, since
a finished game has no secrets. It shows every hand at every move, the move made, and a note on it. Step
with the buttons, the arrow keys, the slider, or by clicking a move in the list.

The notes say what the player could have known when they moved, from their own cards and the questions
asked up to then, never from the hidden hands:

- a question is a **sure thing** if the card was certain to be there, one that **couldn't work** if it was
  known to be elsewhere, and a guess otherwise, with a mention of any sure card that was passed up;
- a declaration says how many of the set's cards the declarer could place.

**Seen by** puts you in one player's seat. Their own hand is whole, everyone else's shows only the cards
that player could place, and under the table is a grid for every set: a row for each player and a column
for each card, marked as *has it*, *can't have it* or *might have it*, with a "1+" beside anyone known to
hold at least one card of the set because they asked for one. A tick box adds where the unplaced cards
really were. This is the same working-out the notes use (`deduce` in `shared/deduce.js`): it follows who
was asked for what and does not count cards, so a sharper player could sometimes know more.

A table under the hands counts these up for each player. The notes come from `analyse(record)` in
`server/analysis.js`, which takes a game's record (`recordOf` in `server/game.js`: the seats, the deal, who
played first and the log) and returns one note per move. That function is the place to plug in a stronger
judge of the moves.

## Code map

```
shared/cards.js   card and set definitions, used by server and browser
shared/deduce.js  what one player can be sure of from their hand and the questions asked; used by the
                  bots, the review's notes, and the review's view from a seat
public/fonts/     Roboto, the typeface, bundled under the SIL Open Font Licence (licence alongside)
server/game.js    the rules: deal, ask, declare, turn passing, scoring (no networking)
server/bot.js     computer player; works only from its hand and the public log
server/analysis.js notes on a finished game: what each player could have known at each move
server/ratings.js Elo arithmetic and the JSON file ratings are kept in
server/history.js the record of finished games, read back for profiles and reviews
server/rooms.js   rooms, the lobby, the chats, reconnects, and the per-player view of a game
server/store.js   the files rooms are saved in, so that a restart carries on with them
server/app.js     HTTP static files + WebSocket transport
server/index.js   entry point
public/           the browser client (plain ES modules, no build step)
test/             rules, bot self-play, ratings, history, analysis, and end-to-end tests over real WebSockets
e2e/              checks that drive a real browser through the site
```

The server is the only authority: clients send `ask` and `declare` messages, the server checks them
against the rules and sends each player a view containing only their own hand.

## Tests

`npm test` runs the rules, the bots, ratings, history, analysis, and the server over real WebSockets. It
needs nothing but Node and takes a few seconds.

`npm run test:browser` drives a real browser through the site and takes a minute or two. It needs
Playwright, installed once with `npm install --save-dev playwright-core`, and Google Chrome on the machine.

| Check | What it goes through |
| --- | --- |
| `e2e/fit.mjs` | The game page at seven window sizes and ten states, with both decks: nothing scrolls but the log. |
| `e2e/declare.mjs` | Declaring on a teammate's turn and from the other team's hands, then a whole game played out. |
| `e2e/clock.mjs` | Setting the clock, the countdown, the time bank, losing the turn, and the tones. |
| `e2e/review.mjs` | A game against bots, its rating changes, and its review: stepping, notes, and the view from a seat. |
| `e2e/room.mjs` | The room's chat, a server restart in the middle of a game, and moving a profile with a code. |

`BROWSER=webkit` (after `npx playwright-core install webkit`) runs them in the engine Safari uses,
`THEME=dark` in the dark theme, and `SHOTS=some/folder` saves screenshots along the way.
