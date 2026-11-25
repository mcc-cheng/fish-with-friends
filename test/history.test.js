import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { History } from '../server/history.js';

/** A finished 2-v-2 game: ann and a bot (team A) against bob and cy (team B). */
function game({ winner = 'A', rated = true, endedAt = 600_000 } = {}) {
  const delta = (team) => (rated ? (team === winner ? 16 : -16) : undefined);
  const player = (pid, name, team) => {
    const change = pid && rated ? { delta: delta(team), after: 1000 + delta(team) } : {};
    return { pid, name, team, bot: !pid, ...change };
  };
  return {
    startedAt: endedAt - 480_000,
    endedAt,
    deck: 54,
    score: winner === 'A' ? { A: 6, B: 3 } : { A: 4, B: 5 },
    winner,
    rated,
    players: [player('ann', 'Ann', 'A'), player(null, 'Guppy', 'A'), player('bob', 'Bob', 'B'), player('cy', 'Cy', 'B')],
  };
}

test('each player sees a game from their own side', () => {
  const history = new History();
  history.add(game({ winner: 'A' }));
  assert.equal(history.count, 1);

  const ann = history.forPlayer('ann');
  assert.deepEqual(ann.stats, { games: 1, wins: 1, losses: 0, rated: 1, setsWon: 6, setsLost: 3, streak: 1, bestStreak: 1 });
  assert.deepEqual(ann.games, [
    { endedAt: 600_000, minutes: 8, deck: 54, rated: true, won: true, score: [6, 3], mates: ['Guppy'], foes: ['Bob', 'Cy'], delta: 16, after: 1016 },
  ]);

  const bob = history.forPlayer('bob');
  assert.deepEqual(bob.stats, { games: 1, wins: 0, losses: 1, rated: 1, setsWon: 3, setsLost: 6, streak: -1, bestStreak: 0 });
  assert.deepEqual(bob.games[0], { ...ann.games[0], won: false, score: [3, 6], mates: ['Cy'], foes: ['Ann', 'Guppy'], delta: -16, after: 984 });
  assert.ok(!JSON.stringify(ann).includes('bob'), 'other players’ ids stay private');

  assert.deepEqual(history.forPlayer('nobody'), { stats: { games: 0, wins: 0, losses: 0, rated: 0, setsWon: 0, setsLost: 0, streak: 0, bestStreak: 0 }, games: [] });
});

test('totals cover everything, the list is newest first and capped', () => {
  const history = new History();
  for (let i = 1; i <= 5; i++) history.add(game({ winner: i % 2 ? 'A' : 'B', rated: i !== 3, endedAt: i * 1_000_000 }));
  const ann = history.forPlayer('ann', 2);
  // Ann won games 1, 3 and 5 (6-3 each) and lost 2 and 4 (4-5 each).
  assert.deepEqual(ann.stats, { games: 5, wins: 3, losses: 2, rated: 4, setsWon: 26, setsLost: 19, streak: 1, bestStreak: 1 });
  // Bob, on the other side, has just lost; add two wins in a row and his run turns round.
  assert.equal(history.forPlayer('bob').stats.streak, -1);
  history.add(game({ winner: 'B', endedAt: 6_000_000 }));
  history.add(game({ winner: 'B', endedAt: 7_000_000 }));
  assert.deepEqual([history.forPlayer('bob').stats.streak, history.forPlayer('bob').stats.bestStreak], [2, 2]);
  assert.deepEqual([history.forPlayer('ann').stats.streak, history.forPlayer('ann').stats.bestStreak], [-2, 1]);
  assert.deepEqual(ann.games.map((g) => g.endedAt), [5_000_000, 4_000_000]);
  // A practice game moved no rating.
  const practice = history.forPlayer('ann').games.find((g) => !g.rated);
  assert.deepEqual([practice.delta, practice.after], [null, null]);
});

test('games survive a restart, even past a line damaged by a crash', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'fish-history-'));
  try {
    const file = path.join(dir, 'nested', 'games.jsonl');
    const first = new History({ file });
    first.add(game({ winner: 'A', endedAt: 1_000_000 }));
    first.add(game({ winner: 'B', endedAt: 2_000_000 }));
    await first.writing;
    assert.equal(readFileSync(file, 'utf8').trim().split('\n').length, 2);

    appendFileSync(file, '{"startedAt": 12, "players": [\n'); // a write that never finished
    const second = new History({ file });
    assert.equal(second.count, 2);
    assert.deepEqual(second.forPlayer('cy'), first.forPlayer('cy'));

    // New games still append after the damaged line.
    second.add(game({ winner: 'A', endedAt: 3_000_000 }));
    await second.writing;
    assert.equal(new History({ file }).forPlayer('ann').stats.games, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
