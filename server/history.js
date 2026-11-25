// A record of every finished game, so players can look back at what they have played.
//
// On disk it is one JSON object per line, only ever appended to: a crash can at
// worst leave a damaged last line, which is skipped when the file is read back.
//
// A game is stored as
//   { startedAt, endedAt, deck, score: { A, B }, winner, rated,
//     players: [{ pid, name, team, bot, delta?, after? }] }
// where pid is the player's rating id (null for bots and guests) and delta/after
// are their Elo change and new rating if the game was rated.

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { appendFile } from 'node:fs/promises';
import path from 'node:path';

/** One game as the player `pid` experienced it: their side first, no ids. */
function seenBy(game, pid) {
  const me = game.players.find((p) => p.pid === pid);
  const theirs = me.team === 'A' ? 'B' : 'A';
  const names = (team) => game.players.filter((p) => p.team === team && p !== me).map((p) => p.name);
  return {
    endedAt: game.endedAt,
    minutes: Math.max(1, Math.round((game.endedAt - game.startedAt) / 60_000)),
    deck: game.deck,
    rated: game.rated,
    won: game.winner === me.team,
    score: [game.score[me.team], game.score[theirs]],
    mates: names(me.team),
    foes: names(theirs),
    delta: me.delta ?? null,
    after: me.after ?? null,
  };
}

export class History {
  /** @param {{ file?: string | null }} options  `file` is where games persist; leave it out to keep them in memory only. */
  constructor({ file = null } = {}) {
    this.file = file;
    this.count = 0; // every game ever finished
    this.byPlayer = new Map(); // player id -> their games, oldest first
    this.writing = Promise.resolve();
    if (file && existsSync(file)) {
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          this.index(JSON.parse(line));
        } catch {
          // A line cut short by a crash: leave it and carry on.
        }
      }
    }
  }

  index(game) {
    this.count += 1;
    for (const pid of new Set(game.players.map((p) => p.pid).filter(Boolean))) {
      if (!this.byPlayer.has(pid)) this.byPlayer.set(pid, []);
      this.byPlayer.get(pid).push(game);
    }
  }

  add(game) {
    this.index(game);
    if (!this.file) return;
    const line = `${JSON.stringify(game)}\n`;
    this.writing = this.writing
      .then(async () => {
        mkdirSync(path.dirname(this.file), { recursive: true });
        await appendFile(this.file, line);
      })
      .catch((error) => console.error('Could not save a game to the history', error));
  }

  /** A player's totals over everything they have played, and their most recent games, newest first. */
  forPlayer(pid, limit = 200) {
    const games = (this.byPlayer.get(pid) ?? []).map((game) => seenBy(game, pid));
    const wins = games.filter((game) => game.won).length;
    // Runs of wins: the longest ever, and the run the player is on now (negative for a run of losses).
    let run = 0;
    let bestStreak = 0;
    for (const game of games) {
      run = game.won ? Math.max(run, 0) + 1 : Math.min(run, 0) - 1;
      bestStreak = Math.max(bestStreak, run);
    }
    return {
      stats: {
        games: games.length,
        wins,
        losses: games.length - wins,
        rated: games.filter((game) => game.rated).length,
        setsWon: games.reduce((sum, game) => sum + game.score[0], 0),
        setsLost: games.reduce((sum, game) => sum + game.score[1], 0),
        streak: run,
        bestStreak,
      },
      games: games.reverse().slice(0, limit),
    };
  }
}
