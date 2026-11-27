// A record of every finished game, so players can look back at what they have played.
//
// On disk it is one JSON object per line, only ever appended to: a crash can at
// worst leave a damaged last line, which is skipped when the file is read back.
//
// A game is stored as
//   { id?, startedAt, endedAt, deck, score: { A, B }, winner, rated,
//     players: [{ pid, name, team, bot, delta?, after? }] }
// where pid is the player's rating id (null for bots and guests) and delta/after
// are their Elo change and new rating if the game was rated.
//
// A game with an id also has a full record, the deal and every move, so that it
// can be played back and analysed. Those are bigger and rarely wanted, so each
// is a file of its own, games/<id>.json beside the list, read when asked for.

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const GAME_ID = /^[0-9a-f]{16}$/;
const RECORDS_IN_MEMORY = 200; // how many full records are kept when there is no folder to put them in

/** One game as the player `pid` experienced it: their side first, no ids. */
function seenBy(game, pid) {
  const me = game.players.find((p) => p.pid === pid);
  const theirs = me.team === 'A' ? 'B' : 'A';
  const names = (team) => game.players.filter((p) => p.team === team && p !== me).map((p) => p.name);
  return {
    id: game.id ?? null, // set if the game can be played back
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
    this.records = new Map(); // game id -> full record, used only when nothing is kept on disk
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

  recordFile(id) {
    return path.join(path.dirname(this.file), 'games', `${id}.json`);
  }

  /** Adds a finished game. `record` is its full record, kept under the game's id. */
  add(game, record = null) {
    this.index(game);
    if (!this.file) {
      if (record) {
        this.records.set(game.id, record);
        if (this.records.size > RECORDS_IN_MEMORY) this.records.delete(this.records.keys().next().value);
      }
      return;
    }
    const line = `${JSON.stringify(game)}\n`;
    this.writing = this.writing
      .then(async () => {
        mkdirSync(path.dirname(this.file), { recursive: true });
        if (record) {
          mkdirSync(path.dirname(this.recordFile(game.id)), { recursive: true });
          await writeFile(this.recordFile(game.id), JSON.stringify(record));
        }
        await appendFile(this.file, line);
      })
      .catch((error) => console.error('Could not save a game to the history', error));
  }

  /** The full record of one game, or null if there is none under that id. */
  async record(id) {
    if (typeof id !== 'string' || !GAME_ID.test(id)) return null;
    if (!this.file) return this.records.get(id) ?? null;
    await this.writing; // a game that has only just finished may still be on its way to the disk
    try {
      return JSON.parse(await readFile(this.recordFile(id), 'utf8'));
    } catch {
      return null;
    }
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
