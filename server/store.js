// Rooms kept on disk, so that restarting the server doesn't end the games in progress.
//
// Each room is one JSON file, rooms/<CODE>.json, rewritten when the room changes
// and removed when the room is. The files are small and the writes synchronous,
// so whatever is on disk when the process stops is whole: a file is written
// beside the old one and then swapped in.
//
// A room's file holds what Rooms.snapshot() returns. That includes each player's
// seat token, which is what lets their browser back into its seat after the
// restart, so the folder is no more public than the server's memory was.

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const ROOM_FILE = /^([A-Z]{4})\.json$/;

export class RoomStore {
  /** @param {{ dir: string, maxAgeMs?: number }} options  Rooms untouched for longer than `maxAgeMs` are not brought back. */
  constructor({ dir, maxAgeMs = 24 * 60 * 60_000 }) {
    this.dir = dir;
    this.maxAgeMs = maxAgeMs;
  }

  file(code) {
    return path.join(this.dir, `${code}.json`);
  }

  write(code, snapshot) {
    try {
      mkdirSync(this.dir, { recursive: true });
      writeFileSync(`${this.file(code)}.tmp`, JSON.stringify(snapshot));
      renameSync(`${this.file(code)}.tmp`, this.file(code));
    } catch (error) {
      console.error(`Could not save room ${code}`, error);
    }
  }

  remove(code) {
    try {
      rmSync(this.file(code), { force: true });
    } catch (error) {
      console.error(`Could not remove the saved room ${code}`, error);
    }
  }

  /**
   * Every room saved by the process before this one. Rooms too old to be worth
   * bringing back are cleared away; a file that can't be read is left where it
   * is and skipped.
   */
  load() {
    if (!existsSync(this.dir)) return [];
    const rooms = [];
    for (const name of readdirSync(this.dir)) {
      const file = path.join(this.dir, name);
      try {
        if (name.endsWith('.tmp')) rmSync(file, { force: true }); // a write the last process never finished
        if (!ROOM_FILE.test(name)) continue;
        if (Date.now() - statSync(file).mtimeMs > this.maxAgeMs) rmSync(file, { force: true });
        else rooms.push(JSON.parse(readFileSync(file, 'utf8')));
      } catch (error) {
        console.error(`Could not read the saved room in ${file}`, error);
      }
    }
    return rooms;
  }
}
