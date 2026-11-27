import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyse } from '../server/analysis.js';
import { chooseMove } from '../server/bot.js';
import { ask, askableCards, canDeclare, createGame, declare, recordOf, replay, timeout } from '../server/game.js';

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

/**
 * A finished game. The even seats play as the bots do; the odd seats ask at
 * random, so the record holds good questions, hopeless ones, guesses, wrong
 * declarations and the odd timeout.
 */
function played(seed) {
  const rng = seeded(seed);
  const pick = (items) => items[Math.floor(rng() * items.length)];
  const game = createGame({ seats: seats([4, 6, 8][seed % 3]), deck: seed % 2 ? 54 : 72, declareRule: ['team', 'turn', 'anytime'][seed % 3], rng });
  for (let moves = 0; game.phase === 'playing'; moves++) {
    assert.ok(moves < 20_000, `seed ${seed} did not finish`);
    const me = game.seats.find((seat) => seat.id === game.turn);
    const foes = game.seats.filter((seat) => seat.team !== me.team && game.hands.get(seat.id).size > 0);
    const cards = askableCards(game, me.id);
    if (rng() < 0.02 && timeout(game, me.id).ok) continue;
    if (me.team === 'B' && foes.length > 0 && cards.length > 0 && rng() < 0.9) {
      ask(game, me.id, pick(foes).id, pick(cards));
    } else if (me.team === 'B' && rng() < 0.3) {
      // A declaration from anyone the rule allows, naming one team's players at random.
      const set = pick(game.sets.filter((s) => !s.claimedBy));
      const side = pick(['A', 'B']);
      const named = game.seats.filter((seat) => seat.team === side);
      declare(game, pick(game.seats.filter((seat) => canDeclare(game, seat.id))).id, set.id, Object.fromEntries(set.cards.map((c) => [c, pick(named).id])));
    } else {
      const move = chooseMove(game, me.id, rng);
      if (move.type === 'ask') ask(game, me.id, move.target, move.card);
      else declare(game, me.id, move.set, move.assignment);
    }
  }
  return game;
}

test('a record plays back to exactly the game it came from', () => {
  for (let seed = 1; seed <= 40; seed++) {
    const game = played(seed);
    const record = JSON.parse(JSON.stringify(recordOf(game))); // as it comes back off the disk
    let visited = 0;
    const again = replay(record, (at, event, i) => {
      assert.equal(i, visited++);
      assert.equal(at.log.length, i, 'the visitor sees the game before the move');
      assert.equal(event, record.log[i]);
    });
    assert.equal(visited, game.log.length);
    assert.deepEqual(again.log, game.log);
    assert.deepEqual([again.score, again.winner, again.phase, again.turn], [game.score, game.winner, 'finished', null]);
    assert.deepEqual(again.sets.map((set) => set.claimedBy), game.sets.map((set) => set.claimedBy));
  }
});

test('a record that could not have been played is refused', () => {
  const record = recordOf(played(3));
  const i = record.log.findIndex((event) => event.type === 'ask');
  record.log[i] = { ...record.log[i], asker: record.log[i].target, target: record.log[i].asker };
  assert.throws(() => replay(record), /can't be played/);
});

test('the notes are never wrong about what a player could have known', () => {
  const seen = { sure: 0, dead: 0, guess: 0, declare: 0, offered: 0 };
  for (let seed = 1; seed <= 120; seed++) {
    const game = played(seed);
    const record = recordOf(game);
    const { moves, players } = analyse(record);
    assert.equal(moves.length, record.log.length);

    const teamOf = new Map(record.seats.map((seat) => [seat.id, seat.team]));
    replay(record, (at, event, i) => {
      const note = moves[i];
      const holderOf = (card) => [...at.hands].find(([, hand]) => hand.has(card))[0];
      if (event.type === 'timeout') return assert.equal(note, null);
      seen[note.kind] += 1;
      if (event.type === 'declare') {
        assert.equal(note.kind, 'declare');
        assert.ok(note.known >= 0 && note.known <= note.of && note.of === (record.deck === 54 ? 6 : 8));
        return;
      }
      const where = `seed ${seed}, move ${i + 1}`;
      // Certain to be there: it was. Certain not to be: it wasn't, and if a holder was named, they had it.
      if (note.kind === 'sure') assert.equal(event.success, true, where);
      if (note.kind === 'dead') {
        assert.equal(event.success, false, where);
        if (note.holder) assert.equal(note.holder, holderOf(event.card), where);
      }
      if (note.kind === 'guess') assert.ok(note.places >= 2, where);
      // Any sure card on offer really was with that opponent, and was one the asker could ask for.
      for (const { card, from } of note.sure ?? []) {
        seen.offered += 1;
        assert.equal(holderOf(card), from, where);
        assert.notEqual(teamOf.get(from), teamOf.get(event.asker), where);
        assert.ok(askableCards(at, event.asker).includes(card), where);
      }
      assert.ok(!note.sure || note.kind !== 'sure');
    });

    // The totals are the log, counted.
    const count = (test) => record.log.filter(test).length;
    for (const { id } of record.seats) {
      const t = players[id];
      assert.equal(t.asks, count((e) => e.type === 'ask' && e.asker === id));
      assert.equal(t.hits, count((e) => e.type === 'ask' && e.asker === id && e.success));
      assert.equal(t.lost, count((e) => e.type === 'ask' && e.target === id && e.success));
      assert.equal(t.declared, count((e) => e.type === 'declare' && e.declarer === id && e.correct));
      assert.equal(t.misdeclared, count((e) => e.type === 'declare' && e.declarer === id && !e.correct));
      assert.equal(t.timeouts, count((e) => e.type === 'timeout' && e.player === id));
      assert.equal(t.sure, moves.filter((note, i) => note?.kind === 'sure' && record.log[i].asker === id).length);
      assert.equal(t.dead, moves.filter((note, i) => note?.kind === 'dead' && record.log[i].asker === id).length);
    }
  }
  // Every kind of note turned up, so every kind was checked.
  for (const [kind, n] of Object.entries(seen)) assert.ok(n > 20, `only ${n} notes of kind "${kind}"`);
});

test('a note says what the asker could have known, in a game small enough to follow', () => {
  // p0 and p2 against p1 and p3. p0 asks p1 for a card and misses; p1 asks p0 back and misses.
  const game = createGame({ seats: seats(4), deck: 54, rng: seeded(5) });
  const hands = { p0: ['2S', '9H'], p1: ['3S', '10H'], p2: ['4S', '5S', '7S', 'JH'], p3: ['6S', 'QH', 'KH', 'AH'] };
  for (const [id, hand] of game.hands) {
    hand.clear();
    for (const card of hands[id]) hand.add(card);
  }
  for (const set of game.sets) if (!['LS', 'HH'].includes(set.id)) set.claimedBy = 'A';
  Object.assign(game, { turn: 'p0', firstTurn: 'p0', deal: hands });
  const record = recordOf(game);
  record.log = [
    { type: 'ask', asker: 'p0', target: 'p1', card: '6S' }, // a guess: nothing is known yet
    { type: 'ask', asker: 'p1', target: 'p0', card: '6S' }, // can't work: p0 just asked for it
    { type: 'ask', asker: 'p0', target: 'p1', card: '6S' }, // can't work: p1 was shown not to have it
    { type: 'ask', asker: 'p1', target: 'p2', card: '4S' }, // a guess, and it comes off
    { type: 'ask', asker: 'p1', target: 'p2', card: '5S' }, // another
    { type: 'ask', asker: 'p1', target: 'p2', card: '2S' }, // misses: the turn goes to p2
    { type: 'ask', asker: 'p2', target: 'p1', card: '4S' }, // sure: everyone saw p1 take it
    { type: 'ask', asker: 'p2', target: 'p3', card: 'QH' }, // a guess, though there were spades for the taking
  ];
  // (With replay refusing anything illegal, the outcomes are worked out by the rules, not written in.)
  const outcomes = [];
  const moves = [];
  const full = { ...record, log: [] };
  for (const event of record.log) {
    const at = replay(full);
    const result = ask(at, event.asker, event.target, event.card);
    assert.equal(result.ok, true, JSON.stringify(event));
    full.log.push(result.event);
    outcomes.push(result.event.success);
  }
  moves.push(...analyse(full).moves);
  assert.deepEqual(outcomes, [false, false, false, true, true, false, true, true]);
  assert.deepEqual(moves[0], { kind: 'guess', places: 3 });
  assert.deepEqual(moves[1], { kind: 'dead', holder: null });
  assert.deepEqual(moves[2], { kind: 'dead', holder: null });
  assert.deepEqual(moves[3], { kind: 'guess', places: 3 });
  assert.deepEqual(moves[6], { kind: 'sure' });
  // Two cards were certain: the 5 p1 was seen to take, and the 6, which everyone but p3 has been shown not to hold.
  assert.deepEqual(moves[7], { kind: 'guess', places: 3, sure: [{ card: '5S', from: 'p1' }, { card: '6S', from: 'p3' }] });
});
