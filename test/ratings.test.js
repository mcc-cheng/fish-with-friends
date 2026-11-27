import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { BOT_ID, BOT_NAME, K_FACTOR, Ratings, START_RATING, expectedScore, playerId, winnerGain } from '../server/ratings.js';

const team = (...ids) => ids.map((id) => ({ id, name: id === BOT_ID ? 'Guppy' : id ? `Player ${id}` : 'Guest' }));

test('expected score follows the Elo curve', () => {
  assert.equal(expectedScore(1000, 1000), 0.5);
  assert.ok(Math.abs(expectedScore(1400, 1000) - 10 / 11) < 1e-9, '400 points ahead wins 10 times in 11');
  assert.ok(Math.abs(expectedScore(1200, 1000) + expectedScore(1000, 1200) - 1) < 1e-9, 'the two sides add up to one');
});

test('an upset is worth more than an expected win', () => {
  assert.equal(winnerGain(1000, 1000), K_FACTOR / 2);
  assert.ok(winnerGain(1000, 1300) > winnerGain(1000, 1000));
  assert.ok(winnerGain(1300, 1000) < winnerGain(1000, 1000));
  assert.equal(winnerGain(3000, 1000), 1, 'even a certain win moves the rating a point');
  assert.equal(winnerGain(1000, 1300) + winnerGain(1300, 1000), K_FACTOR, 'what the upset gains is what the favourite would have risked');
});

test('a player id is a stable hash of the browser secret', () => {
  const id = playerId('a'.repeat(32));
  assert.match(id, /^[0-9a-f]{24}$/);
  assert.equal(playerId('a'.repeat(32)), id);
  assert.notEqual(playerId('b'.repeat(32)), id);
  assert.ok(!id.includes('aaaa'));
  for (const bad of [undefined, null, 42, '', 'short', 'has spaces in it......', 'x'.repeat(65), { toString: () => 'a'.repeat(32) }]) {
    assert.equal(playerId(bad), null);
  }
});

test('a game between new players moves everyone by half of K', () => {
  const ratings = new Ratings();
  const changes = ratings.recordGame({ winners: team('a', 'b', 'c'), losers: team('d', 'e', 'f') });
  assert.equal(changes.length, 6);
  assert.deepEqual(changes[0], { id: 'a', name: 'Player a', before: 1000, after: 1016, delta: 16 });
  assert.deepEqual(changes[5], { id: 'f', name: 'Player f', before: 1000, after: 984, delta: -16 });
  assert.equal(changes.reduce((sum, c) => sum + c.delta, 0), 0, 'points only move between players');
  assert.deepEqual(ratings.profile('a'), { rating: 1016, games: 1, wins: 1, losses: 0, rank: 1 });
  assert.deepEqual(ratings.profile('f'), { rating: 984, games: 1, wins: 0, losses: 1, rank: 6 });
  assert.deepEqual(ratings.profile('stranger'), { rating: START_RATING, games: 0, wins: 0, losses: 0, rank: null });
});

test('teams are rated by their average, and guests count as the starting rating', () => {
  const ratings = new Ratings();
  // Lift "strong" well above the rest.
  for (let i = 0; i < 12; i++) ratings.recordGame({ winners: team('strong'), losers: team(`sparring${i}`) });
  const strong = ratings.rating('strong');
  assert.ok(strong > 1150);

  // strong + a guest, against two newcomers: the favourites win, so they gain less than 16.
  const expected = winnerGain((strong + START_RATING) / 2, START_RATING);
  const changes = ratings.recordGame({ winners: team('strong', null), losers: team('x', 'y') });
  assert.ok(expected < 16);
  assert.deepEqual(changes.map((c) => [c.id, c.delta]), [['strong', expected], ['x', -expected], ['y', -expected]]);
  assert.equal(ratings.players.has(null), false, 'guests get no record');

  // The same teams the other way round is an upset, worth more.
  const upset = ratings.recordGame({ winners: team('x', 'y'), losers: team('strong', null) });
  assert.ok(upset[0].delta > 16);
});

test('the bots share one rating, which moves with the seats they won and lost', () => {
  const ratings = new Ratings();
  assert.equal(ratings.rating(BOT_ID), START_RATING);

  // Bots alone against a player: the full amount, once, however many seats they filled.
  let changes = ratings.recordGame({ winners: team(BOT_ID, BOT_ID), losers: team('ann', 'bea') });
  assert.deepEqual(changes[0], { id: BOT_ID, name: BOT_NAME, before: 1000, after: 1016, delta: 16 });
  assert.deepEqual(ratings.profile(BOT_ID), { rating: 1016, games: 1, wins: 1, losses: 0, rank: 1 });

  // A bot counts as the bots' rating in its team's average: once the bots have
  // climbed, a newcomer with a bot beside them is the favourite against two newcomers.
  for (let i = 0; i < 6; i++) ratings.recordGame({ winners: team(BOT_ID), losers: team(`sparring${i}`) });
  const gain = winnerGain((1000 + ratings.rating(BOT_ID)) / 2, 1000);
  assert.ok(gain < 16);
  changes = ratings.recordGame({ winners: team('cy', BOT_ID), losers: team('dee', 'eve') });
  assert.deepEqual(changes.map((c) => [c.id, c.delta]), [['cy', gain], [BOT_ID, gain], ['dee', -gain], ['eve', -gain]]);

  // On both teams, the bots move by the balance of their seats: here one won and two lost, a third of the loss.
  const before = ratings.rating(BOT_ID);
  const stake = winnerGain((1000 + before) / 2, before);
  changes = ratings.recordGame({ winners: team('fay', BOT_ID), losers: team(BOT_ID, BOT_ID) });
  assert.deepEqual(changes.map((c) => [c.id, c.delta]), [['fay', stake], [BOT_ID, -Math.round(stake / 3)]]);
  assert.equal(ratings.profile(BOT_ID).losses, 1);

  // The same number on each side tells nothing about the bots: no change, and no game counted.
  const games = ratings.profile(BOT_ID).games;
  changes = ratings.recordGame({ winners: team('gil', BOT_ID), losers: team('hal', BOT_ID) });
  assert.deepEqual(changes.map((c) => [c.id, c.delta]), [['gil', 16], ['hal', -16]]);
  assert.equal(ratings.profile(BOT_ID).games, games);

  // Their row on the leaderboard is marked, and carries their own name, not a bot's.
  const row = ratings.leaderboard().find((r) => r.bot);
  assert.deepEqual([row.name, row.rating, row.you], [BOT_NAME, ratings.rating(BOT_ID), false]);
  assert.equal(ratings.leaderboard().filter((r) => r.bot).length, 1);
});

test('the leaderboard is ordered by rating and marks the viewer', () => {
  const ratings = new Ratings();
  ratings.recordGame({ winners: team('ann'), losers: team('bob') });
  ratings.recordGame({ winners: team('ann'), losers: team('cy') });
  // ann has won twice; cy lost to a stronger ann than bob did, so cy dropped a point less.
  const board = ratings.leaderboard(2, 'cy');
  assert.deepEqual(board.map((row) => [row.rank, row.name, row.you]), [[1, 'Player ann', false], [2, 'Player cy', true]]);
  assert.equal(ratings.profile('bob').rank, 3);
  assert.ok(!('id' in board[0]), 'player ids are not handed out');
  assert.deepEqual(board[0], { rank: 1, name: 'Player ann', rating: ratings.rating('ann'), games: 2, wins: 2, losses: 0, you: false });
  assert.equal(ratings.leaderboard(20).length, 3);
});

test('ratings survive a restart, and a damaged file is kept rather than overwritten', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'fish-ratings-'));
  try {
    const file = path.join(dir, 'nested', 'ratings.json');
    const first = new Ratings({ file });
    first.recordGame({ winners: team('ann'), losers: team('bob') });
    first.recordGame({ winners: team('ann'), losers: team('bob') });
    await first.writing;

    const second = new Ratings({ file });
    assert.deepEqual(second.profile('ann'), first.profile('ann'));
    assert.deepEqual(second.leaderboard(), first.leaderboard());
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).players.ann.name, 'Player ann');
    assert.deepEqual(readdirSync(path.dirname(file)), ['ratings.json'], 'no temporary files left behind');

    writeFileSync(file, '{ not json');
    const third = new Ratings({ file });
    assert.equal(third.leaderboard().length, 0);
    assert.ok(readdirSync(path.dirname(file)).some((name) => name.startsWith('ratings.json.unreadable-')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
