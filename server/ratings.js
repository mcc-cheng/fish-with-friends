// Elo ratings: the arithmetic, and a small store that keeps them in a JSON file.
//
// Fish is a team game, so a team is rated as the average of its players. The
// winners' expected score comes from the usual Elo curve, and every player on
// the winning team gains the same number of points that every loser drops.

import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const START_RATING = 1000; // also what bots and unidentified players count as
export const K_FACTOR = 32;

/** The share of wins a side rated `own` is expected to take from a side rated `other`. */
export function expectedScore(own, other) {
  return 1 / (1 + 10 ** ((other - own) / 400));
}

/** Points each winner gains (and each loser drops): more for an upset, fewer for a win that was expected. */
export function winnerGain(winners, losers, k = K_FACTOR) {
  return Math.max(1, Math.round(k * (1 - expectedScore(winners, losers))));
}

/**
 * A browser identifies its player with a random secret it keeps. Ratings are
 * stored under a hash of it, so the file never holds anything that could be
 * used to play as someone else.
 */
export function playerId(secret) {
  if (typeof secret !== 'string' || !/^[A-Za-z0-9_-]{16,64}$/.test(secret)) return null;
  return createHash('sha256').update(secret).digest('hex').slice(0, 24);
}

export class Ratings {
  /** @param {{ file?: string | null }} options  `file` is where ratings persist; leave it out to keep them in memory only. */
  constructor({ file = null } = {}) {
    this.file = file;
    this.players = new Map(); // player id -> { name, rating, games, wins, losses }
    this.writing = Promise.resolve();
    if (file) this.load();
  }

  load() {
    if (!existsSync(this.file)) return;
    try {
      const { players } = JSON.parse(readFileSync(this.file, 'utf8'));
      for (const [id, record] of Object.entries(players)) {
        if (Number.isFinite(record?.rating)) this.players.set(id, record);
      }
    } catch (error) {
      // A damaged file shouldn't stop the server, and shouldn't be overwritten either.
      const aside = `${this.file}.unreadable-${Date.now()}`;
      copyFileSync(this.file, aside);
      console.error(`Could not read ${this.file}. Kept a copy at ${aside} and started with no ratings.`, error);
    }
  }

  rating(id) {
    return this.players.get(id)?.rating ?? START_RATING;
  }

  /** One player's standing, whether or not they have played a rated game yet. */
  profile(id) {
    const record = this.players.get(id);
    if (!record) return { rating: START_RATING, games: 0, wins: 0, losses: 0, rank: null };
    const { rating, games, wins, losses } = record;
    return { rating, games, wins, losses, rank: this.ranked().findIndex(([other]) => other === id) + 1 };
  }

  ranked() {
    return [...this.players].sort(([, a], [, b]) => b.rating - a.rating || b.games - a.games);
  }

  /** The top players, with `you` marking the row that belongs to `viewerId`. */
  leaderboard(limit = 20, viewerId = null) {
    return this.ranked()
      .slice(0, limit)
      .map(([id, { name, rating, games, wins, losses }], i) => ({ rank: i + 1, name, rating, games, wins, losses, you: id === viewerId }));
  }

  /**
   * Applies one finished game. `winners` and `losers` list each team's players
   * as { id, name }; a null id is a bot or a guest, who counts toward the
   * team's average at the starting rating but has no rating of their own.
   * Returns the change for every rated player.
   */
  recordGame({ winners, losers }) {
    const average = (team) => team.reduce((sum, player) => sum + (player.id ? this.rating(player.id) : START_RATING), 0) / team.length;
    const gain = winnerGain(average(winners), average(losers));
    const changes = [];
    const apply = (player, delta, won) => {
      if (!player.id) return;
      const record = this.players.get(player.id) ?? { name: player.name, rating: START_RATING, games: 0, wins: 0, losses: 0 };
      const before = record.rating;
      record.name = player.name;
      record.rating = before + delta;
      record.games += 1;
      record[won ? 'wins' : 'losses'] += 1;
      this.players.set(player.id, record);
      changes.push({ id: player.id, name: player.name, before, after: record.rating, delta });
    };
    for (const player of winners) apply(player, gain, true);
    for (const player of losers) apply(player, -gain, false);
    this.save();
    return changes;
  }

  /** Writes the file in the background: one write at a time, and never a half-written file. */
  save() {
    if (!this.file) return;
    const body = JSON.stringify({ version: 1, players: Object.fromEntries(this.players) }, null, 2);
    this.writing = this.writing
      .then(async () => {
        mkdirSync(path.dirname(this.file), { recursive: true });
        await writeFile(`${this.file}.tmp`, body);
        await rename(`${this.file}.tmp`, this.file);
      })
      .catch((error) => console.error('Could not save ratings', error));
  }
}
