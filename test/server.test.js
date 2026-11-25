import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import WebSocket from 'ws';
import { createApp } from '../server/app.js';
import { buildSets } from '../shared/cards.js';

let app;
let port;
const sockets = [];

before(async () => {
  // Bots move instantly and the grace period is short so the tests run fast.
  app = createApp({ botDelay: [0, 0], graceMs: 150 });
  port = await app.listen(0, '127.0.0.1');
});

after(async () => {
  for (const ws of sockets) ws.terminate();
  await app.close();
});

/** A test client: collects messages and lets a test wait for the one it needs. */
async function connect() {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
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
      return new Promise((resolve, reject) => {
        const w = { match, resolve };
        waiting.push(w);
        setTimeout(() => reject(new Error('timed out waiting for a message')), 3000).unref();
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

async function createRoom(name = 'Host') {
  const host = await connect();
  const joined = host.next((m) => m.t === 'joined');
  host.send({ t: 'create', name });
  const { code, token, id } = await joined;
  await host.state(() => true, { fresh: false });
  return { host, code, token, id };
}

async function joinRoom(code, name, token) {
  const client = await connect();
  const joined = client.next((m) => m.t === 'joined' || m.t === 'error');
  client.send({ t: 'join', code, name, token });
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
  assert.deepEqual(state.settings, { deck: 72, declare: 'turn', history: 'last' });

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

  // Bots play by themselves until it is a human's turn, so wait for things to settle.
  const settle = async (client) => {
    let state = await client.state(() => true, { fresh: false });
    for (;;) {
      const mover = state.members.find((m) => m.id === state.game.turn);
      if (state.phase !== 'playing' || !mover.bot) return state;
      state = await client.state((s) => s.game.log.length > state.game.log.length || s.phase !== 'playing');
    }
  };
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
