import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildSets, setIdOf, sortCards } from '../shared/cards.js';
import { chooseMove } from '../server/bot.js';
import { ask, askableCards, createGame, declare } from '../server/game.js';

/** A small seeded generator so failures are reproducible. */
function seeded(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const seats = (n) => Array.from({ length: n }, (_, i) => ({ id: `p${i}`, team: i % 2 === 0 ? 'A' : 'B' }));

/** A game with hands chosen by the test: `hands` maps player id -> card ids. */
function rigged(hands, { deck = 48, turn = 'p0', declareAnytime = false, players = 4 } = {}) {
  const game = createGame({ seats: seats(players), deck, declareAnytime, rng: seeded(1) });
  for (const hand of game.hands.values()) hand.clear();
  const dealt = new Set();
  for (const [id, cards] of Object.entries(hands)) {
    for (const card of cards) {
      game.hands.get(id).add(card);
      dealt.add(card);
    }
  }
  // Sets that nobody was given are treated as already claimed, so short games can end.
  for (const set of game.sets) {
    if (!set.cards.some((card) => dealt.has(card))) set.claimedBy = 'A';
  }
  game.turn = turn;
  return game;
}

const LOW_SPADES = ['2S', '3S', '4S', '5S', '6S', '7S'];
const HIGH_HEARTS = ['9H', '10H', 'JH', 'QH', 'KH', 'AH'];

test('the decks split into sets of six', () => {
  const small = buildSets(48);
  const big = buildSets(54);
  assert.equal(small.length, 8);
  assert.equal(big.length, 9);
  for (const set of big) {
    assert.equal(set.cards.length, 6);
    for (const card of set.cards) assert.equal(setIdOf(card), set.id);
  }
  assert.equal(new Set(big.flatMap((s) => s.cards)).size, 54);
  assert.ok(!small.flatMap((s) => s.cards).some((card) => card.startsWith('8') || card.endsWith('J')));
  assert.deepEqual(sortCards(['AS', 'RJ', '2S', '9S', '8C']), ['2S', '9S', 'AS', '8C', 'RJ']);
});

test('dealing gives out every card and keeps the teams level', () => {
  for (const deck of [48, 54]) {
    for (const players of [4, 6, 8]) {
      const game = createGame({ seats: seats(players), deck, rng: seeded(deck + players) });
      const sizes = game.seats.map((seat) => game.hands.get(seat.id).size);
      assert.equal(sizes.reduce((a, b) => a + b), deck);
      assert.ok(Math.max(...sizes) - Math.min(...sizes) <= 1, 'hands differ by at most one card');
      const total = (team) => game.seats.filter((s) => s.team === team).reduce((n, s) => n + game.hands.get(s.id).size, 0);
      assert.equal(total('A'), total('B'));
      assert.equal(new Set([...game.hands.values()].flatMap((h) => [...h])).size, deck);
    }
  }
});

test('a successful ask moves the card and keeps the turn', () => {
  const game = rigged({ p0: ['2S'], p1: ['3S', '4S'], p2: ['5S', '6S'], p3: ['7S'] });
  const result = ask(game, 'p0', 'p1', '3S');
  assert.equal(result.ok, true);
  assert.equal(result.event.success, true);
  assert.deepEqual([...game.hands.get('p0')].sort(), ['2S', '3S']);
  assert.deepEqual([...game.hands.get('p1')], ['4S']);
  assert.equal(game.turn, 'p0');
});

test('a failed ask passes the turn to the player who was asked', () => {
  const game = rigged({ p0: ['2S'], p1: ['3S', '4S'], p2: ['5S', '6S'], p3: ['7S'] });
  const result = ask(game, 'p0', 'p1', '7S');
  assert.equal(result.event.success, false);
  assert.equal(game.turn, 'p1');
  assert.deepEqual([...game.hands.get('p0')], ['2S']);
});

test('illegal asks are refused and change nothing', () => {
  const game = rigged({ p0: ['2S', '9H'], p1: ['3S'], p2: ['4S', '5S', '6S'], p3: ['7S', '10H'], p4: [], p5: ['JH'] }, { players: 6 });
  const refused = (...args) => {
    const result = ask(game, ...args);
    assert.equal(result.ok, false, `expected ${args} to be refused`);
    assert.equal(typeof result.error, 'string');
  };
  refused('p1', 'p0', '2S'); // not their turn
  refused('p0', 'p2', '4S'); // a teammate
  refused('p0', 'p0', '3S'); // themselves
  refused('p0', 'nobody', '3S');
  refused('p0', 'p1', '2S'); // already holds it
  refused('p0', 'p1', '9D'); // holds nothing from that set
  refused('p0', 'p1', '8S'); // not in the 48-card deck
  refused('p0', 'p1', 'nonsense');
  assert.equal(game.turn, 'p0');
  assert.equal(game.log.length, 0);

  // p4 (a teammate here) aside, an opponent with no cards can't be asked.
  const empty = rigged({ p0: ['2S'], p1: [], p2: ['3S'], p3: ['4S', '5S', '6S', '7S'] });
  assert.equal(ask(empty, 'p0', 'p1', '4S').ok, false);
  assert.equal(ask(empty, 'p0', 'p3', '4S').ok, true);
});

test('a correct declaration scores the set for the declaring team', () => {
  const game = rigged({ p0: ['2S', '3S', '9H'], p2: ['4S', '5S', '6S', '7S'], p1: ['10H'], p3: ['JH', 'QH', 'KH', 'AH'] });
  const assignment = { '2S': 'p0', '3S': 'p0', '4S': 'p2', '5S': 'p2', '6S': 'p2', '7S': 'p2' };
  const result = declare(game, 'p0', 'LS', assignment);
  assert.equal(result.ok, true);
  assert.equal(result.event.correct, true);
  assert.equal(result.event.team, 'A');
  assert.equal(game.score.A, 1);
  assert.equal(game.sets.find((s) => s.id === 'LS').claimedBy, 'A');
  assert.deepEqual([...game.hands.get('p0')], ['9H']);
  assert.equal(game.hands.get('p2').size, 0);
  assert.equal(game.turn, 'p0');
  assert.equal(game.phase, 'playing');
});

test('naming the wrong teammate hands the set to the other team', () => {
  const game = rigged({ p0: ['2S', '3S', '9H'], p2: ['4S', '5S', '6S', '7S'], p1: ['10H'], p3: ['JH'] });
  const assignment = { '2S': 'p0', '3S': 'p0', '4S': 'p0', '5S': 'p2', '6S': 'p2', '7S': 'p2' };
  const result = declare(game, 'p0', 'LS', assignment);
  assert.equal(result.event.correct, false);
  assert.equal(result.event.team, 'B');
  assert.equal(result.event.actual['4S'], 'p2');
  assert.equal(game.score.B, 1);
  assert.ok(![...game.hands.values()].some((hand) => LOW_SPADES.some((card) => hand.has(card))), 'the set leaves play');
});

test('declaring a set the opponents hold part of gives it to them', () => {
  const game = rigged({ p0: ['2S', '3S', '9H'], p2: ['4S', '5S', '6S'], p1: ['7S', '10H'], p3: ['JH'] });
  const assignment = { '2S': 'p0', '3S': 'p0', '4S': 'p2', '5S': 'p2', '6S': 'p2', '7S': 'p2' };
  const result = declare(game, 'p0', 'LS', assignment);
  assert.equal(result.event.correct, false);
  assert.equal(game.score.B, 1);
  assert.deepEqual([...game.hands.get('p1')], ['10H']);
});

test('declarations must be complete, in-team, and for an open set', () => {
  const game = rigged({ p0: ['2S', '3S', '9H'], p2: ['4S', '5S', '6S', '7S'], p1: ['10H'], p3: ['JH'] });
  const good = { '2S': 'p0', '3S': 'p0', '4S': 'p2', '5S': 'p2', '6S': 'p2', '7S': 'p2' };
  assert.equal(declare(game, 'p0', 'LS', { ...good, '7S': undefined }).ok, false);
  assert.equal(declare(game, 'p0', 'LS', { ...good, '7S': 'p1' }).ok, false);
  assert.equal(declare(game, 'p0', 'LS', null).ok, false);
  assert.equal(declare(game, 'p0', 'nope', good).ok, false);
  assert.equal(declare(game, 'p0', 'HD', good).ok, false); // already claimed
  assert.equal(declare(game, 'p2', 'LS', good).ok, false); // not p2's turn
  assert.equal(declare(game, 'watcher', 'LS', good).ok, false);
  assert.equal(game.log.length, 0);
});

test('the "declare any time" rule lets a teammate declare out of turn', () => {
  const hands = { p0: ['2S', '3S', '9H'], p2: ['4S', '5S', '6S', '7S'], p1: ['10H'], p3: ['JH'] };
  const assignment = { '2S': 'p0', '3S': 'p0', '4S': 'p2', '5S': 'p2', '6S': 'p2', '7S': 'p2' };
  const game = rigged(hands, { declareAnytime: true, turn: 'p1' });
  assert.equal(declare(game, 'p2', 'LS', assignment).ok, true);
  assert.equal(game.score.A, 1);
  assert.equal(game.turn, 'p1', 'the turn stays where it was');
});

test('a player left with no cards passes the turn to a teammate, then to the opponents', () => {
  // p0 declares away their whole hand; p2 is next on their team with cards.
  const toMate = rigged({ p0: LOW_SPADES, p2: ['9H'], p1: ['10H'], p3: ['JH'] });
  declare(toMate, 'p0', 'LS', Object.fromEntries(LOW_SPADES.map((c) => [c, 'p0'])));
  assert.equal(toMate.turn, 'p2');

  // Nobody on p0's team has cards afterwards, so the other team plays on.
  const toFoes = rigged({ p0: LOW_SPADES, p1: ['9H'], p3: ['10H', 'JH', 'QH', 'KH', 'AH'] });
  const result = declare(toFoes, 'p0', 'LS', Object.fromEntries(LOW_SPADES.map((c) => [c, 'p0'])));
  assert.equal(toFoes.turn, 'p1');
  assert.equal(result.event.nextTurn, 'p1');
  // With nobody left to ask, that team can only declare.
  assert.equal(ask(toFoes, 'p1', 'p0', '10H').ok, false);
});

test('the game ends when the last set is claimed', () => {
  const game = rigged({ p0: LOW_SPADES, p1: HIGH_HEARTS });
  game.sets.forEach((set) => {
    if (set.claimedBy) set.claimedBy = null;
  });
  // Leave just two sets open, with the score level.
  for (const set of game.sets) if (set.id !== 'LS' && set.id !== 'HH') set.claimedBy = 'B';
  game.score = { A: 2, B: 3 };
  declare(game, 'p0', 'LS', Object.fromEntries(LOW_SPADES.map((c) => [c, 'p0'])));
  assert.equal(game.phase, 'playing');
  assert.equal(game.turn, 'p1');
  const last = declare(game, 'p1', 'HH', Object.fromEntries(HIGH_HEARTS.map((c) => [c, 'p3'])));
  assert.equal(last.event.correct, false);
  assert.equal(game.phase, 'finished');
  assert.equal(game.turn, null);
  assert.deepEqual(game.score, { A: 4, B: 3 });
  assert.equal(game.winner, 'A');
  assert.equal(ask(game, 'p0', 'p1', '2S').ok, false);
  assert.equal(declare(game, 'p0', 'LS', {}).ok, false);
});

function checkInvariants(game) {
  const inHands = [...game.hands.values()].flatMap((hand) => [...hand]);
  const open = game.sets.filter((set) => !set.claimedBy).flatMap((set) => set.cards);
  assert.deepEqual(sortCards(inHands), sortCards(open), 'cards in hands are exactly the unclaimed sets');
  assert.equal(game.score.A + game.score.B, game.sets.filter((set) => set.claimedBy).length);
  if (game.phase === 'playing') assert.ok(game.hands.get(game.turn).size > 0, 'the player to move has cards');
  else assert.equal(open.length, 0);
}

test('random legal play always reaches the end with the cards accounted for', () => {
  for (let seed = 1; seed <= 60; seed++) {
    const rng = seeded(seed);
    const players = [4, 6, 8][seed % 3];
    const game = createGame({ seats: seats(players), deck: seed % 2 ? 54 : 48, declareAnytime: seed % 4 === 0, rng });
    const pick = (items) => items[Math.floor(rng() * items.length)];
    for (let moves = 0; game.phase === 'playing'; moves++) {
      assert.ok(moves < 20_000, `seed ${seed} did not finish`);
      const me = game.seats.find((seat) => seat.id === game.turn);
      const foes = game.seats.filter((seat) => seat.team !== me.team && game.hands.get(seat.id).size > 0);
      const cards = askableCards(game, me.id);
      if (foes.length > 0 && cards.length > 0 && rng() < 0.97) {
        assert.equal(ask(game, me.id, pick(foes).id, pick(cards)).ok, true);
      } else {
        const set = pick(game.sets.filter((s) => !s.claimedBy));
        const mates = game.seats.filter((seat) => seat.team === me.team);
        const declarer = game.declareAnytime ? pick(game.seats) : me;
        const team = declarer === me ? mates : game.seats.filter((seat) => seat.team === declarer.team);
        assert.equal(declare(game, declarer.id, set.id, Object.fromEntries(set.cards.map((c) => [c, pick(team).id]))).ok, true);
      }
      checkInvariants(game);
    }
    assert.ok(['A', 'B', 'tie'].includes(game.winner));
  }
});

test('bots only make legal moves and always finish a game', () => {
  let correct = 0;
  let declarations = 0;
  for (let seed = 1; seed <= 150; seed++) {
    const rng = seeded(seed * 7919);
    const players = [4, 6, 8][seed % 3];
    const game = createGame({ seats: seats(players), deck: seed % 2 ? 54 : 48, rng });
    for (let moves = 0; game.phase === 'playing'; moves++) {
      assert.ok(moves < 5000, `seed ${seed} did not finish`);
      const move = chooseMove(game, game.turn, rng);
      const result =
        move.type === 'ask' ? ask(game, game.turn, move.target, move.card) : declare(game, game.turn, move.set, move.assignment);
      assert.equal(result.ok, true, `seed ${seed}: ${JSON.stringify(move)} -> ${result.error}`);
      if (move.type === 'declare') {
        declarations++;
        if (result.event.correct) correct++;
      }
      checkInvariants(game);
    }
  }
  // Bots mostly declare from certainty, so the bulk of their declarations should be right.
  assert.ok(correct / declarations > 0.8, `only ${correct}/${declarations} bot declarations were correct`);
});
