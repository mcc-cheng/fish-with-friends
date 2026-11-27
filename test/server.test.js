import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import WebSocket from 'ws';
import { createApp } from '../server/app.js';
import { BOT_ID, BOT_NAME, winnerGain } from '../server/ratings.js';
import { buildSets } from '../shared/cards.js';

let app;
let port;
const sockets = [];

before(async () => {
  // Bots move instantly and the grace period is short so the tests run fast. The tests
  // also click far faster than a person could, so the message limit is lifted here
  // and checked on its own below.
  app = createApp({ botDelay: [0, 0], graceMs: 150, lobbyDelayMs: 5, messagesPer10s: 100_000 });
  port = await app.listen(0, '127.0.0.1');
});

after(async () => {
  for (const ws of sockets) ws.terminate();
  await app.close();
});

/** A test client: collects messages and lets a test wait for the one it needs. */
async function connect(toPort = port) {
  const ws = new WebSocket(`ws://127.0.0.1:${toPort}/ws`);
  sockets.push(ws);
  const inbox = [];
  const waiting = [];
  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    inbox.push(msg);
    for (const w of [...waiting]) {
      if (w.match(msg)) {
        waiting.splice(waiting.indexOf(w), 1);
        w.resolve(msg);
      }
    }
  });
  await new Promise((resolve, reject) => ws.once('open', resolve).once('error', reject));
  const client = {
    ws,
    send: (msg) => ws.send(JSON.stringify(msg)),
    /** The next message that matches; `fresh: false` also accepts one that already arrived. */
    next(match, { fresh = true } = {}) {
      if (!fresh) {
        const seen = inbox.findLast(match);
        if (seen) return Promise.resolve(seen);
      }
      // Made here, not in the timer, so a timeout's stack trace points at the wait that was never answered.
      const timedOut = new Error('timed out waiting for a message');
      return new Promise((resolve, reject) => {
        const w = { match, resolve };
        waiting.push(w);
        setTimeout(() => {
          timedOut.message += `; last received: ${JSON.stringify(inbox.at(-1) ?? null).slice(0, 300)}`;
          reject(timedOut);
        }, 3000).unref();
      });
    },
    state: (match = () => true, options) => client.next((m) => m.t === 'state' && match(m), options),
    /**
     * Sends an action and returns the state it leads to, or the error if it is
     * refused. Broadcasts caused by other players can arrive first, so pass
     * `match` to say what the resulting state looks like.
     */
    act(msg, match = () => true) {
      const reply = client.next((m) => m.t === 'error' || (m.t === 'state' && match(m)));
      client.send(msg);
      return reply;
    },
    /** Sends an action that should be refused and returns the error. */
    fails(msg) {
      const reply = client.next((m) => m.t === 'error');
      client.send(msg);
      return reply;
    },
    close: () => new Promise((resolve) => ws.once('close', resolve).close()),
  };
  return client;
}

async function createRoom(name = 'Host', player, toPort) {
  const host = await connect(toPort);
  const joined = host.next((m) => m.t === 'joined');
  host.send({ t: 'create', name, player });
  const { code, token, id } = await joined;
  await host.state(() => true, { fresh: false });
  return { host, code, token, id };
}

async function joinRoom(code, name, token, player, toPort) {
  const client = await connect(toPort);
  const joined = client.next((m) => m.t === 'joined' || m.t === 'error');
  client.send({ t: 'join', code, name, token, player });
  const reply = await joined;
  if (reply.t === 'joined') await client.state(() => true, { fresh: false });
  return { client, reply };
}

test('serves the client and room links', async () => {
  const get = (path) => fetch(`http://127.0.0.1:${port}${path}`);
  const home = await get('/');
  assert.equal(home.status, 200);
  assert.match(await home.text(), /<div id="app">/);
  assert.equal((await get('/BCDF')).status, 200);
  assert.equal((await get('/bcdf')).status, 200);
  assert.equal((await get('/help')).status, 200);
  assert.equal((await get('/profile')).status, 200);
  assert.equal((await get('/game/0123456789abcdef')).status, 200, 'a finished game’s page');
  assert.equal((await get('/game/nope')).status, 404);
  assert.equal((await get('/nope')).status, 404, 'four letters with a vowel is not a game code');
  assert.match((await get('/shared/cards.js')).headers.get('content-type'), /javascript/);
  assert.equal((await get('/nope.js')).status, 404);
  assert.equal((await get('/shared/%2e%2e/package.json')).status, 404);
  assert.equal((await get('/%2e%2e/package.json')).status, 404);
});

test('lobby: joining, teams, bots, settings and host-only actions', async () => {
  const { host, code } = await createRoom('Ada');
  assert.match(code, /^[A-Z]{4}$/);

  const { client: guest } = await joinRoom(code.toLowerCase(), '  Grace   Hopper  ');
  let state = await host.state((s) => s.members.length === 2, { fresh: false });
  assert.deepEqual(state.members.map((m) => [m.name, m.team]), [['Ada', 'A'], ['Grace Hopper', 'B']]);
  assert.equal(state.phase, 'lobby');
  assert.equal(state.hostId, state.you);

  // Guests can't use host controls.
  await guest.fails({ t: 'start' });
  await guest.fails({ t: 'addBot', team: 'A' });
  await guest.fails({ t: 'settings', settings: { deck: 72 } });
  await guest.fails({ t: 'kick', id: state.you });

  // Uneven or too-small teams can't start.
  assert.match((await host.fails({ t: 'start' })).message, /at least 2/);
  await host.act({ t: 'addBot', team: 'A' }, (s) => s.members.length === 3);
  assert.match((await host.fails({ t: 'start' })).message, /same number/);

  await host.fails({ t: 'settings', settings: { deck: 48 } });
  await host.fails({ t: 'settings', settings: { constructor: 1 } });
  state = await host.act({ t: 'settings', settings: { deck: 72, history: 'last' } }, (s) => s.settings.deck === 72);
  assert.deepEqual(state.settings, { deck: 72, declare: 'team', history: 'last', botPace: 'step', moveTime: 60, timeBank: 120 });

  // Switching teams, and a full team refusing a fifth player.
  const teamA = (s) => s.members.filter((m) => m.team === 'A');
  state = await guest.act({ t: 'team', team: 'A' }, (s) => teamA(s).length === 3);
  assert.deepEqual(teamA(state).map((m) => m.name), ['Ada', 'Grace Hopper', 'Guppy']);
  await host.act({ t: 'addBot', team: 'A' }, (s) => teamA(s).length === 4);
  assert.match((await host.fails({ t: 'addBot', team: 'A' })).message, /full/);

  // Shuffling evens the teams out; removing a bot.
  state = await host.act({ t: 'shuffle' }, (s) => teamA(s).length === 2);
  assert.equal(state.members.filter((m) => m.team === 'B').length, 2);
  const bot = state.members.find((m) => m.bot);
  state = await host.act({ t: 'kick', id: bot.id }, (s) => s.members.length === 3);
  assert.ok(!state.members.some((m) => m.id === bot.id));

  const { reply } = await joinRoom('ZZZZ', 'Nobody');
  assert.equal(reply.code, 'no-room');
});

test('a game: private hands, asking, declaring, spectators', async () => {
  const { host, code } = await createRoom('Ada');
  const { client: guest } = await joinRoom(code, 'Grace');
  // Ada + bot against Grace + bot, with instant bots.
  await host.act({ t: 'addBot', team: 'A' }, (s) => s.members.length === 3);
  await host.act({ t: 'addBot', team: 'B' }, (s) => s.members.length === 4);
  await host.act({ t: 'settings', settings: { deck: 72 } }, (s) => s.settings.deck === 72);

  const guestStarted = guest.state((s) => s.phase === 'playing');
  host.send({ t: 'start' });
  await guestStarted;

  // Step the bots along until it is a human's turn.
  const settle = humanToMove;
  let mine = await settle(host);
  let theirs = await settle(guest);

  // Each player sees only their own hand, and the card counts add up.
  assert.equal(mine.game.hand.length, mine.members.find((m) => m.id === mine.you).cards);
  assert.equal(theirs.game.hand.length, theirs.members.find((m) => m.id === theirs.you).cards);
  assert.ok(!mine.game.hand.some((card) => theirs.game.hand.includes(card)));
  assert.equal(mine.members.reduce((n, m) => n + m.cards, 0), 72 - 8 * mine.game.sets.filter((s) => s.claimedBy).length);
  assert.ok(!JSON.stringify(mine).includes('token'));

  // Whoever isn't on turn is refused.
  if (mine.phase === 'playing') {
    const [mover, waiter] = mine.game.turn === mine.you ? [host, guest] : [guest, host];
    const moverState = mover === host ? mine : theirs;
    const foe = moverState.members.find((m) => m.team && m.team !== moverState.members.find((x) => x.id === moverState.you).team && m.cards > 0);
    assert.match((await waiter.fails({ t: 'ask', target: foe.id, card: '2S' })).message, /turn/);
    await mover.fails({ t: 'ask', target: moverState.you, card: '2S' });
    assert.match((await mover.fails({ t: 'ask', target: foe.id, card: moverState.game.hand[0] })).message, /already hold/);
  }

  // A spectator arriving mid-game sees the table but nobody's cards.
  const { client: watcher } = await joinRoom(code, 'Watcher');
  const watching = await watcher.state(() => true, { fresh: false });
  assert.equal(watching.members.find((m) => m.id === watching.you).team, null);
  assert.deepEqual(watching.game.hand, []);
  assert.match((await watcher.fails({ t: 'declare', set: 'LS', assignment: {} })).message, /watching/);

  // Play it out: each human declares sets (rightly or wrongly) whenever it is their turn.
  const finished = host.state((s) => s.phase === 'finished', { fresh: false }).catch(() => null);
  for (let guard = 0; guard < 40; guard++) {
    mine = await settle(host);
    if (mine.phase !== 'playing') break;
    const [client, state] = mine.game.turn === mine.you ? [host, mine] : [guest, await settle(guest)];
    if (state.phase !== 'playing' || state.game.turn !== state.you) continue;
    const open = state.game.sets.find((s) => !s.claimedBy);
    const reply = await client.act(
      { t: 'declare', set: open.id, assignment: allToMe(open.id, state.you) },
      (s) => s.game.sets.find((x) => x.id === open.id).claimedBy,
    );
    assert.equal(reply.t, 'state', reply.message);
  }
  const end = (await finished) ?? (await host.state((s) => s.phase === 'finished', { fresh: false }));
  assert.equal(end.game.score.A + end.game.score.B, 9);
  assert.ok(['A', 'B', 'tie'].includes(end.game.winner));
  assert.equal(end.members.filter((m) => m.cards > 0).length, 0);

  // Back to the lobby, where the spectator can take a team.
  const lobby = await host.act({ t: 'toLobby' }, (s) => s.phase === 'lobby');
  assert.equal(lobby.phase, 'lobby');
  assert.equal(lobby.game, null);
});

function allToMe(setId, me) {
  const set = buildSets(72).find((s) => s.id === setId);
  return Object.fromEntries(set.cards.map((card) => [card, me]));
}

test('declaring: any time your team has the turn, naming your team’s players or the other team’s', async () => {
  const { host, code } = await createRoom('Ada');
  const guests = [];
  for (const name of ['Bo', 'Cy', 'Di']) guests.push((await joinRoom(code, name)).client);
  const clients = [host, ...guests];
  const started = clients.map((client) => client.state((s) => s.phase === 'playing'));
  host.send({ t: 'start' });
  const views = await Promise.all(started);

  // Two a side and no bots, so the turn sits with one of the four until somebody asks.
  const teamOf = new Map(views[0].members.map((m) => [m.id, m.team]));
  const turnTeam = teamOf.get(views[0].game.turn);
  for (const view of views) assert.equal(view.game.canDeclare, teamOf.get(view.you) === turnTeam, 'only the team with the turn may declare');

  const at = (pick) => views.findIndex(pick);
  const mate = at((v) => teamOf.get(v.you) === turnTeam && v.you !== v.game.turn); // on the team, but not their own turn
  const foe = at((v) => teamOf.get(v.you) !== turnTeam);
  const others = views.filter((v) => teamOf.get(v.you) !== turnTeam).map((v) => v.you);
  const set = buildSets(54)[0];
  const all = (id) => Object.fromEntries(set.cards.map((card) => [card, id]));

  assert.match((await clients[foe].fails({ t: 'declare', set: set.id, assignment: all(views[foe].you) })).message, /your team has the turn/);
  const mixed = { ...all(others[0]), [set.cards[0]]: views[mate].you };
  assert.match((await clients[mate].fails({ t: 'declare', set: set.id, assignment: mixed })).message, /one team/);

  // The teammate calls the set as held by the other team. Right or wrong, it is a legal call.
  const reply = await clients[mate].act({ t: 'declare', set: set.id, assignment: all(others[0]) }, (s) => s.game.log.length === 1);
  assert.equal(reply.t, 'state', reply.message);
  const event = reply.game.log[0];
  assert.deepEqual([event.type, event.declarer, event.named], ['declare', views[mate].you, teamOf.get(others[0])]);
  assert.equal(event.team, event.correct ? turnTeam : teamOf.get(others[0]));
  assert.equal(reply.game.score[event.team], 1);
  assert.equal(reply.game.turn, views[0].game.turn, 'the turn stays with the player who had it');
});

test('the clock: time for each move, then the time bank, then the turn is lost', async () => {
  // Its own server, where a "second" lasts 30ms: 10 seconds a move is 300ms, and a 15 second bank is 450ms.
  const fast = createApp({ secondMs: 30, lobbyDelayMs: 5 });
  const fastPort = await fast.listen(0, '127.0.0.1');
  try {
    const { host } = await createRoom('Ada', undefined, fastPort);
    const code = (await host.state(() => true, { fresh: false })).code;
    const guests = [];
    for (const name of ['Bo', 'Cy', 'Di']) {
      const client = await connect(fastPort);
      client.send({ t: 'join', code, name });
      await client.state();
      guests.push(client);
    }
    const clients = [host, ...guests];

    // Only the lengths on offer can be chosen, and only before the game.
    await host.fails({ t: 'settings', settings: { moveTime: 7 } });
    await host.fails({ t: 'settings', settings: { timeBank: -1 } });
    const lobby = await host.act({ t: 'settings', settings: { moveTime: 10, timeBank: 15 } }, (s) => s.settings.moveTime === 10 && s.settings.timeBank === 15);
    assert.ok(lobby.members.every((m) => m.bank === null), 'no banks until a game starts');

    const started = clients.map((client) => client.state((s) => s.phase === 'playing'));
    host.send({ t: 'start' });
    const views = await Promise.all(started);
    const first = views[0].game.turn;
    const teamOf = new Map(views[0].members.map((m) => [m.id, m.team]));
    const clientOf = new Map(views.map((view, i) => [view.you, clients[i]]));

    // Everyone starts with a full bank, and the player to move is on the clock.
    assert.deepEqual(views[0].members.map((m) => m.bank), [450, 450, 450, 450]);
    const { clock } = views[0].game;
    assert.equal(clock.player, first);
    assert.ok(clock.move > 200 && clock.move <= 300, `move time left: ${clock.move}`);
    assert.equal(clock.bank, 450);

    // The first player thinks for 400ms: 100ms longer than a move allows, so it comes out of their bank.
    await pause(400);
    const mine = views.find((view) => view.you === first);
    const target = mine.members.find((m) => m.team !== teamOf.get(first) && m.cards > 0);
    const missing = buildSets(54).flatMap((set) => (set.cards.some((card) => mine.game.hand.includes(card)) ? set.cards.filter((card) => !mine.game.hand.includes(card)) : []))[0];
    const asked = await clientOf.get(first).act({ t: 'ask', target: target.id, card: missing }, (s) => s.game.log.length === 1);
    assert.equal(asked.t, 'state', asked.message);
    const bank = asked.members.find((m) => m.id === first).bank;
    assert.ok(bank < 450 && bank > 150, `bank after 100ms of overtime: ${bank}`);
    const others = asked.members.filter((m) => m.id !== first && m.id !== asked.game.clock.player);
    assert.ok(others.every((m) => m.bank === 450), 'nobody else has been charged');

    // Whoever is to move now does nothing at all: their move time and bank run out, and the turn passes.
    const idle = asked.game.turn;
    assert.equal(asked.game.clock.player, idle);
    const after = await host.state((s) => s.game.log.at(-1).type === 'timeout');
    const event = after.game.log.at(-1);
    assert.deepEqual([event.player, event.nextTurn], [idle, after.game.turn]);
    assert.notEqual(teamOf.get(after.game.turn), teamOf.get(idle), 'the turn goes to the other team');
    assert.equal(after.members.find((m) => m.id === idle).bank, 0);
    assert.equal(after.game.clock.player, after.game.turn, 'and the next player is on the clock');
    assert.equal(after.game.log.length, 2);
  } finally {
    await fast.close();
  }
});

test('bots are never on the clock, and a game with no time limit has none', async () => {
  const { host } = await createRoom('Ada');
  for (const team of ['A', 'B', 'B']) host.send({ t: 'addBot', team });
  await host.state((s) => s.members.length === 4);
  let playing = host.state((s) => s.phase === 'playing');
  host.send({ t: 'start' });
  let state = await playing;
  for (let moves = 0; moves < 6 && state.phase === 'playing'; moves++) {
    const mover = state.members.find((m) => m.id === state.game.turn);
    // With the default limit, the clock runs for the person and stands still for the bots.
    assert.equal(state.game.clock?.player ?? null, mover.bot ? null : mover.id);
    assert.deepEqual(state.members.map((m) => m.bank), state.members.map((m) => (m.bot ? null : 120_000)));
    if (!mover.bot) break;
    state = await host.act({ t: 'next', at: state.game.position }, (s) => s.game.position > state.game.position);
  }

  // The same table again with the limit switched off.
  await host.act({ t: 'toLobby' }, (s) => s.phase === 'lobby');
  await host.act({ t: 'settings', settings: { moveTime: 0 } }, (s) => s.settings.moveTime === 0);
  playing = host.state((s) => s.phase === 'playing');
  host.send({ t: 'start' });
  state = await humanToMove(host);
  assert.equal((await playing).game.clock, null);
  assert.equal(state.game.clock, null);
  assert.ok(state.members.every((m) => m.bank === null));
});

test('reconnecting with a token restores the seat; a stranger can take over an abandoned one', async () => {
  const { host, code } = await createRoom('Ada');
  const { client: guest, reply } = await joinRoom(code, 'Grace');
  await host.act({ t: 'addBot', team: 'A' }, (s) => s.members.length === 3);
  await host.act({ t: 'addBot', team: 'B' }, (s) => s.members.length === 4);
  const started = guest.state((s) => s.phase === 'playing');
  host.send({ t: 'start' });
  const before = await started;

  // Grace drops and comes back with her token: same seat, same cards.
  const offline = host.state((s) => s.members.some((m) => m.id === reply.id && !m.online));
  await guest.close();
  await offline;
  const back = await joinRoom(code, 'ignored', reply.token);
  assert.equal(back.reply.id, reply.id);
  const restored = await back.client.state(() => true, { fresh: false });
  assert.equal(restored.members.find((m) => m.id === reply.id).name, 'Grace');
  assert.equal(restored.game.hand.length, restored.members.find((m) => m.id === reply.id).cards);
  assert.ok(before.game.hand.length > 0);

  // She leaves for good. The host covers her seat with a bot...
  back.client.send({ t: 'leave' });
  await host.state((s) => s.members.some((m) => m.id === reply.id && !m.online));
  const covered = await host.act({ t: 'botControl', id: reply.id, on: true }, (s) => s.members.find((m) => m.id === reply.id).auto);
  assert.equal(covered.members.find((m) => m.id === reply.id).auto, true);

  // ...until someone new claims it and plays her hand.
  const { client: sub } = await joinRoom(code, 'Linus');
  const seatTaken = sub.next((m) => m.t === 'joined');
  sub.send({ t: 'claimSeat', id: reply.id });
  assert.equal((await seatTaken).id, reply.id);
  const subState = await sub.state((s) => s.you === reply.id, { fresh: false });
  const seat = subState.members.find((m) => m.id === reply.id);
  assert.deepEqual([seat.name, seat.online, seat.auto], ['Linus', true, false]);
  assert.equal(subState.game.hand.length, seat.cards);
  assert.equal(subState.members.filter((m) => m.name === 'Linus').length, 1);
});

test('the host role moves on when the host stays away', async () => {
  const { host, code } = await createRoom('Ada');
  const { client: guest, reply } = await joinRoom(code, 'Grace');
  const promoted = guest.state((s) => s.hostId === reply.id);
  await host.close();
  const state = await promoted;
  assert.deepEqual(state.members.map((m) => m.name), ['Grace']);
});

/**
 * Gets past the bots: presses Next for each bot move (or waits, in an automatic
 * game) and resolves with the client's view once a human is to move or the game is over.
 */
async function humanToMove(client) {
  let state = await client.state(() => true, { fresh: false });
  // Another player may have seen the game start first: wait for this client's copy of it.
  if (!state.game) state = await client.state((s) => s.game);
  for (;;) {
    const mover = state.members.find((m) => m.id === state.game.turn);
    if (state.phase !== 'playing' || !mover.bot) return state;
    const moved = client.state((s) => s.game.position > state.game.position || s.phase !== 'playing');
    if (state.game.awaitingNext) client.send({ t: 'next', at: state.game.position });
    state = await moved;
  }
}

/** A question the client may legally put to a bot on the other team, from the client's own view. */
function legalAsk(state) {
  const me = state.members.find((m) => m.id === state.you);
  const target = state.members.find((m) => m.bot && m.team !== me.team && m.cards > 0);
  for (const set of buildSets(state.game.deck)) {
    const missing = set.cards.find((card) => !state.game.hand.includes(card));
    if (missing && set.cards.some((card) => state.game.hand.includes(card))) return { t: 'ask', target: target.id, card: missing };
  }
  throw new Error('no legal ask');
}

/** Has the human ask bots until a question fails, which hands the turn to a bot. */
async function untilBotToMove(client) {
  let state = await client.state(() => true, { fresh: false });
  for (let guard = 0; guard < 60; guard++) {
    if (state.game.turn !== state.you) return state;
    const before = state.game.position;
    state = await client.act(legalAsk(state), (s) => s.game.position > before);
    assert.equal(state.t, 'state', state.message);
  }
  throw new Error('the turn never reached a bot');
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('bots wait for a player to press Next, and take one decision per press', async () => {
  const { host, code } = await createRoom('Ada');
  await host.act({ t: 'addBot', team: 'A' }, (s) => s.members.length === 2);
  await host.act({ t: 'addBot', team: 'B' }, (s) => s.members.length === 3);
  const lobby = await host.act({ t: 'addBot', team: 'B' }, (s) => s.members.length === 4);
  assert.equal(lobby.settings.botPace, 'step', 'stepping is the default');

  const started = host.state((s) => s.phase === 'playing');
  host.send({ t: 'start' });
  await started;
  let state = await untilBotToMove(host);
  assert.equal(state.game.awaitingNext, true);

  // Nothing happens until someone asks for it.
  const at = state.game.position;
  await pause(120);
  state = await host.state(() => true, { fresh: false });
  assert.equal(state.game.position, at);

  // A spectator can't step the game.
  const { client: watcher } = await joinRoom(code, 'Watcher');
  assert.match((await watcher.fails({ t: 'next', at })).message, /Only players/);

  // A press for some other moment in the game is quietly ignored.
  state = await host.act({ t: 'next', at: at - 1 });
  assert.equal(state.t, 'state');
  assert.equal(state.game.position, at);
  state = await host.act({ t: 'next' });
  assert.equal(state.game.position, at);

  // One press, one decision. Two presses for the same move (two players clicking at once) still make one.
  const moved = host.state((s) => s.game.position > at);
  host.send({ t: 'next', at });
  host.send({ t: 'next', at });
  state = await moved;
  assert.equal(state.game.position, at + 1);
  await pause(60);
  state = await host.state(() => true, { fresh: false });
  assert.equal(state.game.position, at + 1);
  assert.equal(state.game.log.at(-1).seq, at + 1);

  // On a human's turn there is nothing to step.
  state = await humanToMove(host);
  if (state.phase === 'playing') {
    assert.equal(state.game.awaitingNext, false);
    assert.match((await host.fails({ t: 'next', at: state.game.position })).message, /No bot/);
  }
});

test('with the automatic rule, bots play on their own', async () => {
  // Its own server, whose bots take a moment to move: long enough to see that
  // a Next press is refused while one is about to play.
  const slow = createApp({ botDelay: [150, 150] });
  const slowPort = await slow.listen(0, '127.0.0.1');
  try {
    const { host } = await createRoom('Ada', undefined, slowPort);
    await host.act({ t: 'addBot', team: 'A' }, (s) => s.members.length === 2);
    await host.act({ t: 'addBot', team: 'B' }, (s) => s.members.length === 3);
    await host.act({ t: 'addBot', team: 'B' }, (s) => s.members.length === 4);
    await host.act({ t: 'settings', settings: { botPace: 'auto' } }, (s) => s.settings.botPace === 'auto');
    const started = host.state((s) => s.phase === 'playing');
    host.send({ t: 'start' });

    // A bot is about to move: either one starts, or the human asks until a question fails.
    let state = await started;
    if (state.game.turn === state.you) state = await untilBotToMove(host);
    assert.equal(state.game.awaitingNext, false);
    const at = state.game.position;
    assert.match((await host.fails({ t: 'next', at })).message, /No bot/);
    // ...and then the bot moves without being asked.
    const moved = await host.state((s) => s.game?.position > at, { fresh: false });
    assert.ok(moved.game.position > at);
  } finally {
    await slow.close();
  }
});

/** Plays a started game to its end: bots move by themselves, and each human declares a set whenever it is their turn. */
async function playToEnd(clients) {
  const byId = new Map();
  for (const client of clients) byId.set((await client.state(() => true, { fresh: false })).you, client);
  for (let guard = 0; guard < 80; guard++) {
    const seen = await humanToMove(clients[0]);
    if (seen.phase !== 'playing') return seen;
    const mover = byId.get(seen.game.turn);
    // The mover's own connection can be a message behind the first client's: wait for it to catch up.
    let state = await mover.state(() => true, { fresh: false });
    while (!state.game || state.game.position < seen.game.position) state = await mover.state(() => true);
    if (state.phase !== 'playing' || state.game.turn !== state.you) continue;
    const open = buildSets(state.game.deck).find((set) => !state.game.sets.find((s) => s.id === set.id).claimedBy);
    const reply = await mover.act(
      { t: 'declare', set: open.id, assignment: Object.fromEntries(open.cards.map((card) => [card, state.you])) },
      (s) => s.game.sets.find((x) => x.id === open.id).claimedBy,
    );
    assert.equal(reply.t, 'state', reply.message);
  }
  throw new Error('the game did not finish');
}

async function ratingsFor(client, player) {
  const reply = client.next((m) => m.t === 'ratings');
  client.send({ t: 'hello', player });
  return reply;
}

/** What a browser would generate and keep as its player key. */
const secret = () => randomUUID().replaceAll('-', '');

test('a game with a human on each team moves their Elo ratings', async () => {
  const ada = secret();
  const grace = secret();
  const { host, code } = await createRoom('Ada', ada);
  const { client: guest } = await joinRoom(code, 'Grace', undefined, grace);

  // New players start at 1000, shown to everyone in the lobby; each bot shows the rating the bots share.
  const bots = app.rooms.ratings.rating(BOT_ID);
  await host.act({ t: 'addBot', team: 'A' }, (s) => s.members.length === 3);
  const lobby = await host.act({ t: 'addBot', team: 'B' }, (s) => s.members.length === 4);
  assert.deepEqual(lobby.members.map((m) => m.rating), [1000, 1000, bots, bots]);
  assert.equal(lobby.unrated, null);
  assert.ok(!JSON.stringify(lobby).includes(ada), 'the secret never comes back out');

  const started = guest.state((s) => s.phase === 'playing');
  host.send({ t: 'start' });
  await started;
  const end = await playToEnd([host, guest]);
  const hostView = await host.state((s) => s.phase === 'finished' && s.game.ratingChanges, { fresh: false });
  const guestView = await guest.state((s) => s.phase === 'finished' && s.game.ratingChanges, { fresh: false });

  // The human on the winning team gains 16 and the other loses 16; each sees their own row marked.
  // A bot on each team cancels out, so the bots' rating is not in the list.
  const winnerName = end.game.winner === 'A' ? 'Ada' : 'Grace';
  const sorted = [...hostView.game.ratingChanges].sort((a, b) => b.delta - a.delta);
  assert.deepEqual(sorted.map(({ name, before, after, delta }) => [name, before, after, delta]), [
    [winnerName, 1000, 1016, 16],
    [winnerName === 'Ada' ? 'Grace' : 'Ada', 1000, 984, -16],
  ]);
  assert.equal(hostView.game.ratingChanges.find((c) => c.you).name, 'Ada');
  assert.equal(guestView.game.ratingChanges.find((c) => c.you).name, 'Grace');
  assert.equal(hostView.members.find((m) => m.name === winnerName).rating, 1016);
  assert.equal(app.rooms.ratings.rating(BOT_ID), bots);

  // The leaderboard and each player's own standing reflect it.
  const board = await ratingsFor(guest, grace);
  assert.equal(board.me.games, 1);
  assert.equal(board.me.rating, winnerName === 'Grace' ? 1016 : 984);
  assert.equal(board.top.find((row) => row.you).name, 'Grace');
  assert.deepEqual(board.top.map((row) => [row.rank, row.name, row.rating]), [
    [1, winnerName, 1016],
    [2, winnerName === 'Ada' ? 'Grace' : 'Ada', 984],
  ]);

  // A rematch is rated again, from the new ratings; one ended early by the host changes nothing.
  const again = guest.state((s) => s.phase === 'playing');
  host.send({ t: 'start' });
  await again;
  await host.act({ t: 'toLobby' }, (s) => s.phase === 'lobby');
  assert.equal((await ratingsFor(guest, grace)).me.games, 1);
});

test('a game against bots is rated, and moves the rating the bots share', async () => {
  const solo = secret();
  const { host } = await createRoom('Solo', solo);
  await host.act({ t: 'addBot', team: 'A' }, (s) => s.members.length === 2);
  await host.act({ t: 'addBot', team: 'B' }, (s) => s.members.length === 3);
  const lobby = await host.act({ t: 'addBot', team: 'B' }, (s) => s.members.length === 4);
  assert.equal(lobby.unrated, null);
  const bots = app.rooms.ratings.rating(BOT_ID);

  const started = host.state((s) => s.phase === 'playing');
  host.send({ t: 'start' });
  await started;
  const end = await playToEnd([host]);

  // Solo and a bot played two bots. Solo moves by the full amount; the bots had one seat on
  // Solo's team and two on the other, so they move a third as far, the other way.
  const won = end.game.winner === 'A';
  const gain = won ? winnerGain((1000 + bots) / 2, bots) : winnerGain(bots, (1000 + bots) / 2);
  const share = Math.max(1, Math.round(gain / 3));
  const row = (c) => [c.name, c.delta, c.after, c.team, c.bot, c.you];
  assert.equal(end.game.ratingChanges.length, 2);
  assert.deepEqual(row(end.game.ratingChanges.find((c) => c.you)), ['Solo', won ? gain : -gain, 1000 + (won ? gain : -gain), 'A', false, true]);
  assert.deepEqual(row(end.game.ratingChanges.find((c) => c.bot)), [BOT_NAME, won ? -share : share, bots + (won ? -share : share), null, true, false]);
  assert.deepEqual(end.members.filter((m) => m.bot).map((m) => m.rating), Array(3).fill(bots + (won ? -share : share)), 'every bot shows it');

  // Both are on the leaderboard, the bots' row marked as theirs.
  const board = await ratingsFor(host, solo);
  assert.equal(board.me.games, 1);
  assert.deepEqual(board.top.filter((r) => r.bot).map((r) => [r.name, r.rating]), [[BOT_NAME, bots + (won ? -share : share)]]);
  assert.equal(board.top.find((r) => r.you).bot, undefined);
});

test('practice games leave ratings alone: one player in two seats, or nobody with a rating', async () => {
  const solo = secret();
  const { host, code } = await createRoom('Solo', solo);
  await host.act({ t: 'addBot', team: 'A' }, (s) => s.members.length === 2);
  await host.act({ t: 'addBot', team: 'B' }, (s) => s.members.length === 3);

  // A second tab of the same browser (same secret) joins the other team.
  const { client: twin } = await joinRoom(code, 'Solo again', undefined, solo);
  const two = await twin.act({ t: 'team', team: 'B' }, (s) => s.members.find((m) => m.id === s.you).team === 'B');
  assert.equal(two.unrated, 'same-player');
  const before = [app.rooms.ratings.rating(BOT_ID), (await ratingsFor(host, solo)).me];
  const started = twin.state((s) => s.phase === 'playing');
  host.send({ t: 'start' });
  assert.equal((await started).unrated, 'same-player');
  const end = await playToEnd([host, twin]);
  assert.equal(end.game.ratingChanges, null);
  assert.deepEqual([app.rooms.ratings.rating(BOT_ID), (await ratingsFor(host, solo)).me], before);

  // A guest whose browser sent no secret has no rating, and a game of guests and bots has nobody to rate.
  const { host: guest } = await createRoom('Guest');
  await guest.act({ t: 'addBot', team: 'A' }, (s) => s.members.length === 2);
  await guest.act({ t: 'addBot', team: 'B' }, (s) => s.members.length === 3);
  const alone = await guest.act({ t: 'addBot', team: 'B' }, (s) => s.members.length === 4);
  assert.equal(alone.unrated, 'no-humans');
  assert.equal(alone.members.find((m) => m.id === alone.you).rating, null);
  assert.equal((await ratingsFor(guest, undefined)).me, null);
  assert.equal((await ratingsFor(guest, 'too-short')).me, null);
});

test('a finished game can be looked back at: its record, and a note on every move', async () => {
  const { host } = await createRoom('Ada');
  await host.act({ t: 'addBot', team: 'A' }, (s) => s.members.length === 2);
  await host.act({ t: 'addBot', team: 'B' }, (s) => s.members.length === 3);
  await host.act({ t: 'addBot', team: 'B' }, (s) => s.members.length === 4);
  const started = host.state((s) => s.phase === 'playing');
  host.send({ t: 'start' });
  const first = await started;
  assert.equal(first.game.reviewId, null, 'nothing to look back at until it is over');
  const end = await playToEnd([host]);
  const id = end.game.reviewId;
  assert.match(id, /^[0-9a-f]{16}$/);

  const asked = host.next((m) => m.t === 'review');
  host.send({ t: 'review', id });
  const { record, analysis } = await asked;
  assert.deepEqual([record.id, record.deck, record.winner, record.score, record.rated], [id, 54, end.game.winner, end.game.score, false]);
  assert.deepEqual(record.seats.map((seat) => seat.id), end.game.seats);
  assert.deepEqual(record.seats.map((seat) => [seat.name, seat.bot]).sort(), [['Ada', false], ['Guppy', true], ['Minnow', true], ['Tetra', true]]);
  // The deal is every card once, the first hand is the one Ada was dealt, and the log is the whole game.
  assert.deepEqual(Object.values(record.deal).flat().sort(), buildSets(54).flatMap((set) => set.cards).sort());
  if (first.game.position === 0) assert.deepEqual(record.deal[first.you], first.game.hand);
  assert.equal(record.firstTurn, record.log[0].asker ?? record.log[0].declarer ?? record.log[0].player);
  assert.equal(record.log.length, end.game.position);
  assert.ok(!JSON.stringify(record).includes('pid'), 'no rating ids in what is sent out');

  // One note for each move, and totals for each seat that add up to the log.
  assert.equal(analysis.moves.length, record.log.length);
  const asks = record.log.filter((e) => e.type === 'ask');
  assert.equal(Object.values(analysis.players).reduce((sum, p) => sum + p.asks, 0), asks.length);
  assert.equal(Object.values(analysis.players).reduce((sum, p) => sum + p.hits, 0), asks.filter((e) => e.success).length);
  assert.equal(Object.values(analysis.players).reduce((sum, p) => sum + p.declared + p.misdeclared, 0), 9);
  assert.deepEqual(Object.keys(analysis.players).sort(), [...end.game.seats].sort());

  // Anyone may look, not only the players; a game that isn't there is said to be missing.
  const stranger = await connect();
  const theirs = stranger.next((m) => m.t === 'review');
  stranger.send({ t: 'review', id });
  assert.deepEqual((await theirs).record, record);
  for (const bad of ['0123456789abcdef', '../ratings', undefined]) {
    const reply = stranger.next((m) => m.t === 'review');
    stranger.send({ t: 'review', id: bad });
    assert.deepEqual(await reply, { t: 'review', id: String(bad ?? ''), missing: true });
  }
});

test('a connection that sends too much is told so, never just ignored', async () => {
  const strict = createApp({ messagesPer10s: 5 });
  const strictPort = await strict.listen(0, '127.0.0.1');
  const ws = new WebSocket(`ws://127.0.0.1:${strictPort}/ws`);
  try {
    await new Promise((resolve, reject) => ws.once('open', resolve).once('error', reject));
    const replies = [];
    const done = new Promise((resolve) => {
      ws.on('message', (data) => {
        replies.push(JSON.parse(data.toString()));
        if (replies.length === 8) resolve();
      });
    });
    for (let i = 0; i < 8; i++) ws.send(JSON.stringify({ t: 'profile' }));
    await done;
    // Every message gets an answer: five are served, and the rest are refused in words.
    assert.deepEqual(replies.map((m) => m.t), ['profile', 'profile', 'profile', 'profile', 'profile', 'error', 'error', 'error']);
    assert.match(replies.at(-1).message, /too fast/);
  } finally {
    ws.terminate();
    await strict.close();
  }
});

/** Someone sitting in the lobby: connects, says hello, and resolves with the client and the first lobby snapshot. */
async function enterLobby(name, player, toPort) {
  const client = await connect(toPort);
  const first = client.next((m) => m.t === 'lobby');
  client.send({ t: 'hello', name, player });
  return { client, lobby: await first };
}

const lobbyWith = (client, match) => client.next((m) => m.t === 'lobby' && match(m), { fresh: false });

test('the lobby lists public games as they change, and keeps private ones to their players', async () => {
  const { client: watcher, lobby } = await enterLobby('Watcher', secret());
  assert.ok(Array.isArray(lobby.games) && Array.isArray(lobby.chat));
  assert.ok(lobby.online >= 1);

  // A public game appears for everyone in the lobby...
  const bobKey = secret();
  const { host: bob, code } = await createRoom('Bob', bobKey);
  const row = (m, c = code) => m.games.find((g) => g.code === c);
  let seen = await lobbyWith(watcher, (m) => row(m));
  const { createdAt, hue, ...rest } = row(seen);
  assert.deepEqual(rest, { code, host: 'Bob', players: 1, deck: 54, status: 'waiting', private: false });
  assert.ok(Date.now() - createdAt < 5000 && hue >= 0 && hue < 360);

  // ...and follows it: more players, a different deck, the game starting.
  await bob.act({ t: 'addBot', team: 'A' }, (s) => s.members.length === 2);
  await bob.act({ t: 'addBot', team: 'B' }, (s) => s.members.length === 3);
  await bob.act({ t: 'addBot', team: 'B' }, (s) => s.members.length === 4);
  await bob.act({ t: 'settings', settings: { deck: 72 } }, (s) => s.settings.deck === 72);
  seen = await lobbyWith(watcher, (m) => row(m)?.players === 4 && row(m).deck === 72);
  bob.send({ t: 'start' });
  seen = await lobbyWith(watcher, (m) => row(m)?.status === 'playing');

  // A private game is listed only for the people in it, under "your games".
  const carolKey = secret();
  const carol = await connect();
  const made = carol.next((m) => m.t === 'joined');
  carol.send({ t: 'create', name: 'Carol', player: carolKey, public: false });
  const secretCode = (await made).code;
  const carolState = await carol.state(() => true, { fresh: false });
  assert.equal(carolState.public, false);
  await pause(40);
  const latest = await watcher.next((m) => m.t === 'lobby', { fresh: false });
  assert.equal(row(latest, secretCode), undefined);
  assert.equal(latest.yours.length, 0);
  const { lobby: carolsLobby } = await enterLobby('Carol', carolKey); // Carol's second tab
  assert.equal(row(carolsLobby, secretCode), undefined);
  assert.deepEqual(carolsLobby.yours.map((g) => [g.code, g.private]), [[secretCode, true]]);

  // When everyone has left a game it drops off the list.
  bob.send({ t: 'leave' });
  await lobbyWith(watcher, (m) => !row(m));
  // Bob is back in the lobby himself now, and it is still one of his games.
  const bobsLobby = await bob.next((m) => m.t === 'lobby' && m.yours.some((g) => g.code === code));
  assert.equal(bobsLobby.yours.find((g) => g.code === code).status, 'playing');
});

test('lobby chat reaches the people in the lobby, with a backlog for newcomers', async () => {
  const { client: ann } = await enterLobby('Ann', secret());
  const { client: ben } = await enterLobby('Ben', secret());
  const { host: inGame } = await createRoom('Busy', secret());

  const heardByBen = ben.next((m) => m.t === 'chat');
  const heardByAnn = ann.next((m) => m.t === 'chat');
  ann.send({ t: 'chat', text: '  anyone   for a game?  ' });
  const message = await heardByBen;
  assert.equal(message.message.text, 'anyone for a game?');
  assert.equal(message.message.name, 'Ann');
  assert.deepEqual((await heardByAnn).message, message.message);
  assert.ok(message.message.hue >= 0 && message.message.hue < 360 && message.message.at <= Date.now());

  // Too fast or empty: nothing is posted.
  assert.match((await ann.fails({ t: 'chat', text: 'and again' })).message, /One message at a time/);
  ben.send({ t: 'chat', text: '   ' });
  // Long messages are cut, and a renamed player speaks under the new name.
  const long = ann.next((m) => m.t === 'chat' && m.message.name === 'Benedict');
  ben.send({ t: 'chat', name: 'Benedict', text: 'x'.repeat(500) });
  assert.equal((await long).message.text.length, 240);

  // Someone arriving later gets what was said. People in a game heard none of it.
  const { lobby } = await enterLobby('Late', secret());
  assert.deepEqual(lobby.chat.slice(-2).map((m) => [m.name, m.text.slice(0, 18)]), [['Ann', 'anyone for a game?'], ['Benedict', 'x'.repeat(18)]]);
  await pause(30);
  assert.equal(await Promise.race([inGame.next((m) => m.t === 'chat', { fresh: false }), pause(20).then(() => 'nothing')]), 'nothing');
});

test('a profile holds the player’s games and totals, rated or not', async () => {
  const ada = secret();
  const grace = secret();
  const { client: watcher, lobby } = await enterLobby('Watcher');
  const profileOf = async (client, player) => {
    const reply = client.next((m) => m.t === 'profile');
    client.send({ t: 'profile', player });
    return reply;
  };
  assert.deepEqual(await profileOf(watcher), { t: 'profile', me: null, stats: null, games: [] });

  // A rated game: Ada and a bot against Grace and a bot.
  const { host, code } = await createRoom('Ada', ada);
  const { client: guest } = await joinRoom(code, 'Grace', undefined, grace);
  await host.act({ t: 'addBot', team: 'A' }, (s) => s.members.length === 3);
  await host.act({ t: 'addBot', team: 'B' }, (s) => s.members.length === 4);
  const started = guest.state((s) => s.phase === 'playing');
  host.send({ t: 'start' });
  await started;
  const end = await playToEnd([host, guest]);
  const adaWon = end.game.winner === 'A';

  let mine = await profileOf(host, ada);
  const { A, B } = end.game.score;
  assert.deepEqual(mine.stats, { games: 1, wins: adaWon ? 1 : 0, losses: adaWon ? 0 : 1, rated: 1, setsWon: A, setsLost: B, streak: adaWon ? 1 : -1, bestStreak: adaWon ? 1 : 0 });
  assert.equal(mine.me.rating, adaWon ? 1016 : 984);
  const [game] = mine.games;
  assert.deepEqual(
    // (seats are shuffled, so the order of names isn't fixed)
    { ...game, id: null, endedAt: null, minutes: null, foes: [...game.foes].sort() },
    {
      id: null,
      endedAt: null,
      minutes: null,
      deck: 54,
      rated: true,
      won: adaWon,
      score: [end.game.score.A, end.game.score.B],
      mates: ['Guppy'],
      foes: ['Grace', 'Minnow'],
      delta: adaWon ? 16 : -16,
      after: adaWon ? 1016 : 984,
    },
  );
  assert.ok(Date.now() - game.endedAt < 5000 && game.minutes >= 1);
  assert.equal(game.id, end.game.reviewId, 'each game in the list leads to its review');
  const theirs = await profileOf(guest, grace);
  assert.deepEqual([theirs.games[0].won, theirs.games[0].score, theirs.games[0].mates], [!adaWon, [end.game.score.B, end.game.score.A], ['Minnow']]);

  // The lobby's count of games played went up.
  const after = await lobbyWith(watcher, (m) => m.played > lobby.played);
  assert.equal(after.played, lobby.played + 1);

  // A practice game (Ada against herself, from a second tab) is remembered too, but moves no rating.
  await host.act({ t: 'toLobby' }, (s) => s.phase === 'lobby');
  guest.send({ t: 'leave' });
  await host.state((s) => s.members.length === 3);
  const { client: twin } = await joinRoom(code, 'Ada too', undefined, ada);
  await twin.act({ t: 'team', team: 'B' }, (s) => s.members.find((m) => m.id === s.you).team === 'B');
  const again = twin.state((s) => s.phase === 'playing');
  host.send({ t: 'start' });
  await again;
  await playToEnd([host, twin]);
  mine = await profileOf(host, ada);
  assert.deepEqual([mine.stats.games, mine.stats.rated, mine.games.length], [2, 1, 2]);
  assert.deepEqual([mine.games[0].rated, mine.games[0].delta, mine.games[0].after], [false, null, null]);
  assert.equal(mine.me.games, 1, 'the rating still counts one rated game');
});

test('the same browser gets its seat back in a new tab, without a session token', async () => {
  const key = secret();
  const { host, code } = await createRoom('Ada');
  const { client: guest, reply } = await joinRoom(code, 'Grace', undefined, key);
  await host.act({ t: 'addBot', team: 'A' }, (s) => s.members.length === 3);
  await host.act({ t: 'addBot', team: 'B' }, (s) => s.members.length === 4);
  const started = guest.state((s) => s.phase === 'playing');
  host.send({ t: 'start' });
  const hand = (await started).game.hand;

  // While Grace's first tab is connected, a second tab is somebody new (here, a spectator)...
  const { client: second, reply: other } = await joinRoom(code, 'Grace', undefined, key);
  assert.notEqual(other.id, reply.id);
  await second.close();

  // ...but once she has dropped out, coming back from the same browser is coming back to her seat.
  const gone = host.state((s) => s.members.some((m) => m.id === reply.id && !m.online));
  await guest.close();
  await gone;
  const { client: back, reply: again } = await joinRoom(code, 'Grace', undefined, key);
  assert.equal(again.id, reply.id);
  const restored = await back.state(() => true, { fresh: false });
  assert.deepEqual(restored.game.hand, hand, 'and to the cards she was holding');
  assert.equal(restored.members.find((m) => m.id === reply.id).online, true);
});

test('the people in a room have a chat of their own, which the lobby does not hear', async () => {
  const { client: outside } = await enterLobby('Outside', secret());
  const { host, code } = await createRoom('Ada', secret());
  const { client: guest } = await joinRoom(code, 'Grace', undefined, secret());
  await guest.act({ t: 'team', team: null }, (s) => s.members.find((m) => m.id === s.you).team === null);

  const heard = [host, guest].map((client) => client.next((m) => m.t === 'chat'));
  host.send({ t: 'chat', text: '  shall we   start? ' });
  const [mine, theirs] = await Promise.all(heard);
  assert.deepEqual(mine, theirs);
  assert.equal(mine.room, code);
  assert.deepEqual({ ...mine.message, at: null }, { id: 1, name: 'Ada', team: 'A', text: 'shall we start?', at: null });

  // Someone watching speaks under no team, and the same limits apply as in the lobby.
  const reply = host.next((m) => m.t === 'chat');
  guest.send({ t: 'chat', text: 'y'.repeat(400) });
  const { message } = await reply;
  assert.deepEqual([message.id, message.name, message.team, message.text.length], [2, 'Grace', null, 240]);
  assert.match((await guest.fails({ t: 'chat', text: 'and again' })).message, /One message at a time/);

  // A newcomer is handed what was said before they arrived. The lobby heard nothing.
  const late = await joinRoom(code, 'Late');
  assert.deepEqual(late.reply.chat.map((m) => [m.name, m.text.slice(0, 5)]), [['Ada', 'shall'], ['Grace', 'yyyyy']]);
  assert.equal(await Promise.race([outside.next((m) => m.t === 'chat', { fresh: false }), pause(30).then(() => 'nothing')]), 'nothing');
});

test('a profile moves to another device with a code that works once', async () => {
  const [ada, phone] = [secret(), secret()];
  const { client: desk } = await enterLobby('Ada', ada);
  const { client: mobile } = await enterLobby('Guest 1234', phone);
  const codeFor = async (client, player) => {
    const reply = client.next((m) => m.t === 'linkCode' || m.t === 'error');
    client.send({ t: 'linkCode', player });
    return reply;
  };
  const use = async (client, code) => {
    const reply = client.next((m) => m.t === 'linked' || m.t === 'error');
    client.send({ t: 'linkUse', code });
    return reply;
  };

  const { code, minutes } = await codeFor(desk, ada);
  assert.match(code, /^[BCDFGHJKLMNPQRSTVWXZ2-9]{8}$/);
  assert.equal(minutes, 10);

  // The browser that made the code can't use it, and a wrong one is refused.
  assert.match((await use(desk, code)).message, /from this browser/);
  assert.match((await use(mobile, 'BCDF2345')).message, /isn’t right/);
  // Typed the way a person would, on the other device: it is given the first one's key, and its name.
  assert.deepEqual(await use(mobile, ` ${code.slice(0, 4).toLowerCase()}-${code.slice(4)} `), { t: 'linked', player: ada, name: 'Ada' });
  // With that key the phone is the same player: the same rating record.
  assert.deepEqual((await ratingsFor(mobile, ada)).me, (await ratingsFor(desk, ada)).me);
  // The code is spent.
  const { client: third } = await enterLobby('Third', secret());
  assert.match((await use(third, code)).message, /isn’t right/);

  // A new code replaces the one before it. A browser with no key has nothing to share.
  const first = (await codeFor(desk, ada)).code;
  const second = (await codeFor(desk, ada)).code;
  assert.notEqual(first, second);
  assert.match((await use(third, first)).message, /isn’t right/);
  assert.equal((await use(third, second)).player, ada);
  const { client: guest } = await enterLobby('Guest');
  assert.match((await codeFor(guest)).message, /no profile to share/);

  // Guessing gets a connection nowhere: after a few wrong codes it has to wait.
  const { client: guesser } = await enterLobby('Guesser', secret());
  const live = (await codeFor(desk, ada)).code;
  for (let i = 0; i < 5; i++) assert.match((await use(guesser, `BCDF234${i + 2}`)).message, /isn’t right/);
  assert.match((await use(guesser, live)).message, /Too many wrong codes/);
});

test('a code for moving a profile runs out', async () => {
  const brief = createApp({ linkTtlMs: 40, lobbyDelayMs: 5 });
  const briefPort = await brief.listen(0, '127.0.0.1');
  try {
    const ada = secret();
    const { client: desk } = await enterLobby('Ada', ada, briefPort);
    const { client: mobile } = await enterLobby('Phone', secret(), briefPort);
    const made = desk.next((m) => m.t === 'linkCode');
    desk.send({ t: 'linkCode', player: ada });
    const { code } = await made;
    await pause(80);
    assert.match((await mobile.fails({ t: 'linkUse', code })).message, /run out/);
  } finally {
    await brief.close();
  }
});

/** A folder for a server's data that is cleared away when the test ends. */
function tempDataDir(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'fish-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('restarting the server carries on with the games in progress', async (t) => {
  const dataDir = tempDataDir(t);
  // A "second" of the clock lasts 20ms here: 3 minutes a move is 3.6s, and a 5 minute bank is 6s.
  const options = { dataDir, botDelay: [0, 0], graceMs: 150, lobbyDelayMs: 5, saveDelayMs: 5, secondMs: 20, messagesPer10s: 100_000 };
  const [ada, grace] = [secret(), secret()];
  let server = createApp(options);
  let at = await server.listen(0, '127.0.0.1');
  t.after(() => server.close());

  // Ada and a bot against Grace and a bot, with house rules that aren't the defaults.
  const { host, code, token, id } = await createRoom('Ada', ada, at);
  const { client: guest, reply: graceSeat } = await joinRoom(code, 'Grace', undefined, grace, at);
  await host.act({ t: 'addBot', team: 'A' }, (s) => s.members.length === 3);
  await host.act({ t: 'addBot', team: 'B' }, (s) => s.members.length === 4);
  await host.act({ t: 'settings', settings: { deck: 72, declare: 'anytime', moveTime: 180, timeBank: 300 } }, (s) => s.settings.timeBank === 300);
  const started = guest.state((s) => s.phase === 'playing');
  host.send({ t: 'start' });
  await started;

  // A few moves in: whoever of the two is to move declares a set to themselves, twice over.
  const clients = new Map([[id, host], [graceSeat.id, guest]]);
  for (let moves = 0; moves < 2; moves++) {
    const seen = await humanToMove(host);
    const mover = clients.get(seen.game.turn);
    let state = await mover.state(() => true, { fresh: false });
    while (state.game.position < seen.game.position) state = await mover.state();
    const open = state.game.sets.find((set) => !set.claimedBy);
    await mover.act({ t: 'declare', set: open.id, assignment: allToMe(open.id, state.you) }, (s) => s.game.sets.find((x) => x.id === open.id).claimedBy);
  }
  const said = host.next((m) => m.t === 'chat');
  guest.send({ t: 'chat', text: 'back in a second' });
  await said;
  await humanToMove(host);
  const before = { ada: await host.state(() => true, { fresh: false }), grace: await guest.state(() => true, { fresh: false }) };
  assert.equal(before.ada.game.position, before.grace.game.position);
  assert.ok(before.ada.game.position >= 2 && before.ada.phase === 'playing');

  // ---- the server stops, and a new one starts on the same folder
  await server.close();
  assert.ok(existsSync(path.join(dataDir, 'rooms', `${code}.json`)), 'the room is on disk');
  server = createApp(options);
  at = await server.listen(0, '127.0.0.1');

  // Ada's browser reconnects with the token it kept, and finds the game as it was.
  const back = await joinRoom(code, 'Ada', token, ada, at);
  assert.equal(back.reply.id, id);
  assert.deepEqual(back.reply.chat.map((m) => [m.name, m.text]), [['Grace', 'back in a second']]);
  const mine = await back.client.state(() => true, { fresh: false });
  const table = (state) => ({
    members: state.members.map((m) => ({ ...m, online: null, bank: null })),
    game: { ...state.game, clock: null },
    settings: state.settings,
    hostId: state.hostId,
    public: state.public,
    unrated: state.unrated,
  });
  assert.deepEqual(table(mine), table(before.ada), 'the same hand, the same log, the same turn, the same rules');
  assert.deepEqual(mine.members.map((m) => [m.name, m.online]).sort(), [['Ada', true], ['Grace', false], ['Guppy', true], ['Minnow', true]]);
  // Time banks are as they were; the player to move gets their move time afresh.
  assert.deepEqual(mine.members.map((m) => m.bank), before.ada.members.map((m) => m.bank));
  assert.equal(mine.game.clock.player, mine.game.turn);
  assert.ok(mine.game.clock.move > 3000, `a fresh move's time: ${mine.game.clock.move}`);

  // Grace comes back from the same browser, with no token: her seat, her cards.
  const hers = await joinRoom(code, 'Grace', undefined, grace, at);
  assert.equal(hers.reply.id, graceSeat.id);
  assert.deepEqual((await hers.client.state(() => true, { fresh: false })).game.hand, before.grace.game.hand);

  // They play it out. It is rated (the two bots, one a side, cancel out), and counted once.
  const end = await playToEnd([back.client, hers.client]);
  assert.deepEqual(end.game.ratingChanges.map((change) => change.name).sort(), ['Ada', 'Grace']);
  const profile = async (client) => {
    const reply = client.next((m) => m.t === 'profile');
    client.send({ t: 'profile' });
    return reply;
  };
  assert.equal((await profile(back.client)).stats.games, 1);

  // ---- another restart, after the end: the result is still on the table, and nothing is counted again
  await server.close();
  server = createApp(options);
  at = await server.listen(0, '127.0.0.1');
  const later = await joinRoom(code, 'Ada', token, ada, at);
  const result = await later.client.state(() => true, { fresh: false });
  assert.equal(result.phase, 'finished');
  assert.deepEqual([result.game.winner, result.game.score, result.game.reviewId], [end.game.winner, end.game.score, end.game.reviewId]);
  assert.deepEqual(result.game.ratingChanges, end.game.ratingChanges);
  const again = await profile(later.client);
  assert.deepEqual([again.stats.games, again.me.games], [1, 1]);
  // The finished game's review survived too, in the history.
  const asked = later.client.next((m) => m.t === 'review');
  later.client.send({ t: 'review', id: result.game.reviewId });
  assert.equal((await asked).record.log.length, result.game.position);
});

test('a room waiting for players survives a restart, and a room that is over leaves nothing behind', async (t) => {
  const dataDir = tempDataDir(t);
  const options = { dataDir, graceMs: 60, emptyTtlMs: 120, lobbyDelayMs: 5, saveDelayMs: 5 };
  const ada = secret();
  let server = createApp(options);
  let at = await server.listen(0, '127.0.0.1');
  t.after(() => server.close());
  const file = (code) => path.join(dataDir, 'rooms', `${code}.json`);

  const { host, code, token, id } = await createRoom('Ada', ada, at);
  await host.act({ t: 'addBot', team: 'B' }, (s) => s.members.length === 2);
  await host.act({ t: 'settings', settings: { history: 'last' } }, (s) => s.settings.history === 'last');
  await pause(30);
  assert.equal(JSON.parse(readFileSync(file(code), 'utf8')).members.length, 2, 'saved as it changes, without waiting for a shutdown');

  // Files the new server can make nothing of are passed over: damaged, or from a version it doesn't know.
  writeFileSync(file('BCDF'), '{"version": 1, "code": "BCDF", "mem');
  writeFileSync(file('GHJK'), JSON.stringify({ version: 99, code: 'GHJK' }));
  mkdirSync(path.join(dataDir, 'rooms', 'not-a-room'));
  await server.close();
  const complaints = t.mock.method(console, 'error', () => {});
  server = createApp(options);
  complaints.mock.restore();
  assert.equal(complaints.mock.callCount(), 2, 'each unusable file is reported');
  at = await server.listen(0, '127.0.0.1');
  for (const lost of ['BCDF', 'GHJK']) {
    assert.equal((await joinRoom(lost, 'Nobody', undefined, undefined, at)).reply.code, 'no-room');
    rmSync(file(lost));
  }

  // The waiting room is back: its teams, its rules, and Ada as host.
  const back = await joinRoom(code, 'Ada', token, ada, at);
  const lobby = await back.client.state(() => true, { fresh: false });
  assert.deepEqual([back.reply.id, lobby.phase, lobby.hostId, lobby.settings.history], [id, 'lobby', id, 'last']);
  assert.deepEqual(lobby.members.map((m) => [m.name, m.team, m.bot]), [['Ada', 'A', false], ['Guppy', 'B', true]]);
  // New players are numbered on from where the room left off.
  const { reply: newcomer } = await joinRoom(code, 'Grace', undefined, undefined, at);
  assert.equal(newcomer.id, 'p3');

  // Everyone leaves; once the empty room is cleared away, so is its file.
  await server.close();
  server = createApp(options);
  at = await server.listen(0, '127.0.0.1');
  assert.ok(existsSync(file(code)));
  await pause(250);
  assert.ok(!existsSync(file(code)), 'a room nobody came back to is removed, file and all');
  assert.equal((await joinRoom(code, 'Ada', token, ada, at)).reply.code, 'no-room');
});
