// Rooms: who is in them, the lobby, and what each player is allowed to see.
//
// A "conn" is any object with send(message); the WebSocket layer in app.js
// supplies real ones and sets nothing else on them. This module adds
// conn.room and conn.member once the connection has joined a room.

import { randomUUID } from 'node:crypto';
import { sortCards } from '../shared/cards.js';
import { chooseMove } from './bot.js';
import { ask, createGame, declare, shuffle } from './game.js';

export const TEAM_MIN = 2;
export const TEAM_MAX = 4;
const ROOM_MAX = 16; // players plus spectators
const LOG_MAX = 300; // events sent to clients
const CODE_LETTERS = 'BCDFGHJKLMNPQRSTVWXZ'; // no vowels, so codes never spell words
const BOT_NAMES = ['Guppy', 'Minnow', 'Tetra', 'Koi', 'Pike', 'Trout', 'Perch', 'Bass'];
// The first value of each setting is its default.
const SETTING_VALUES = { deck: [54, 48], declare: ['turn', 'anytime'], history: ['full', 'last'] };

function cleanName(raw) {
  const name = String(raw ?? '').replace(/\s+/g, ' ').trim().slice(0, 20).trim();
  return name || 'Player';
}

function uniqueName(room, name) {
  const taken = new Set([...room.members.values()].map((m) => m.name.toLowerCase()));
  if (!taken.has(name.toLowerCase())) return name;
  for (let n = 2; ; n++) {
    if (!taken.has(`${name} ${n}`.toLowerCase())) return `${name} ${n}`;
  }
}

function timer(fn, ms) {
  const t = setTimeout(fn, ms);
  t.unref?.();
  return t;
}

export class Rooms {
  constructor(options = {}) {
    this.rooms = new Map();
    this.options = {
      botDelay: [1200, 2200], // ms a bot "thinks" before moving: [min, max]
      graceMs: 30_000, // how long a dropped connection keeps its place before others move on
      emptyTtlMs: 20 * 60_000, // how long a room with nobody connected survives
      maxRooms: 1000,
      rng: Math.random,
      ...options,
    };
  }

  // ---- entry points used by the transport ----

  handle(conn, msg) {
    if (!msg || typeof msg.t !== 'string') return;
    if (msg.t === 'create') return this.create(conn, msg);
    if (msg.t === 'join') return this.join(conn, msg);
    const { room, member } = conn;
    if (!room) return conn.send({ t: 'error', code: 'no-room', message: 'You are not in a room.' });
    if (msg.t === 'leave') return this.drop(conn, true);
    const error = this.act(room, member, msg);
    if (error) conn.send({ t: 'error', message: error });
    else this.broadcast(room);
  }

  disconnect(conn) {
    this.drop(conn, false);
  }

  close() {
    for (const room of [...this.rooms.values()]) this.destroy(room);
  }

  // ---- joining and leaving ----

  create(conn, msg) {
    if (this.rooms.size >= this.options.maxRooms) {
      return conn.send({ t: 'error', message: 'The server is full right now. Try again in a bit.' });
    }
    if (conn.room) this.drop(conn, true);
    let code;
    do {
      code = Array.from({ length: 4 }, () => CODE_LETTERS[Math.floor(Math.random() * CODE_LETTERS.length)]).join('');
    } while (this.rooms.has(code));
    const room = {
      code,
      members: new Map(),
      nextId: 1,
      hostId: null,
      settings: Object.fromEntries(Object.entries(SETTING_VALUES).map(([key, values]) => [key, values[0]])),
      game: null,
      botTimer: null,
      botKey: null,
      ttlTimer: null,
    };
    this.rooms.set(code, room);
    const member = this.addMember(room, { name: msg.name, team: 'A' });
    room.hostId = member.id;
    this.attach(conn, room, member);
    this.broadcast(room);
  }

  join(conn, msg) {
    const code = String(msg.code ?? '').toUpperCase();
    const room = this.rooms.get(code);
    if (!room) return conn.send({ t: 'error', code: 'no-room', message: "That room doesn't exist any more." });
    // A token from an earlier connection puts the player back in their old place.
    let member = typeof msg.token === 'string' ? [...room.members.values()].find((m) => m.token === msg.token) : null;
    if (conn.room && conn.member !== member) this.drop(conn, true);
    if (!member) {
      if (room.members.size >= ROOM_MAX) return conn.send({ t: 'error', message: 'That room is full.' });
      // Arriving mid-game means watching; in the lobby you land on the smaller team.
      member = this.addMember(room, { name: msg.name, team: room.game ? null : this.openTeam(room) });
    }
    this.attach(conn, room, member);
    this.pickHost(room);
    this.broadcast(room);
  }

  addMember(room, { name, team = null, isBot = false }) {
    const member = {
      id: `p${room.nextId++}`,
      token: isBot ? null : randomUUID(),
      name: uniqueName(room, cleanName(name)),
      team,
      isBot,
      connected: isBot,
      gone: false, // disconnected for longer than the grace period, or left on purpose
      botControlled: false, // a human seat the host has handed to a bot
      conn: null,
      graceTimer: null,
    };
    room.members.set(member.id, member);
    return member;
  }

  attach(conn, room, member) {
    if (member.conn && member.conn !== conn) {
      // The same player opened the game somewhere else; the newest connection wins.
      const old = member.conn;
      old.room = old.member = null;
      old.send({ t: 'replaced' });
    }
    clearTimeout(member.graceTimer);
    clearTimeout(room.ttlTimer);
    Object.assign(member, { conn, connected: true, gone: false, botControlled: false });
    conn.room = room;
    conn.member = member;
    conn.send({ t: 'joined', code: room.code, id: member.id, token: member.token });
  }

  /** The connection is going away: `left` if the player chose to leave, false if it just dropped. */
  drop(conn, left) {
    const { room, member } = conn;
    if (!room) return;
    conn.room = conn.member = null;
    member.conn = null;
    member.connected = false;
    if (left) {
      member.gone = true;
      // Someone holding cards keeps their seat so the game can go on without them.
      if (!this.seated(room, member)) this.remove(room, member);
    } else {
      member.graceTimer = timer(() => {
        if (member.connected || room.members.get(member.id) !== member) return;
        member.gone = true;
        if (!this.seated(room, member)) this.remove(room, member);
        this.pickHost(room);
        this.broadcast(room);
      }, this.options.graceMs);
    }
    this.pickHost(room);
    this.broadcast(room);
    if (![...room.members.values()].some((m) => m.connected && !m.isBot)) {
      clearTimeout(room.ttlTimer);
      room.ttlTimer = timer(() => this.destroy(room), this.options.emptyTtlMs);
    }
  }

  remove(room, member) {
    clearTimeout(member.graceTimer);
    room.members.delete(member.id);
    if (member.conn) member.conn.room = member.conn.member = null;
    member.conn = null;
  }

  destroy(room) {
    clearTimeout(room.botTimer);
    clearTimeout(room.ttlTimer);
    for (const member of room.members.values()) {
      clearTimeout(member.graceTimer);
      if (member.conn) member.conn.room = member.conn.member = null;
    }
    this.rooms.delete(room.code);
  }

  /** Hands the host role on once the host has really gone. */
  pickHost(room) {
    const host = room.members.get(room.hostId);
    if (host && (host.connected || !host.gone)) return;
    const next = [...room.members.values()].find((m) => m.connected && !m.isBot);
    if (next) room.hostId = next.id;
  }

  team(room, team) {
    return [...room.members.values()].filter((m) => m.team === team);
  }

  openTeam(room) {
    const a = this.team(room, 'A').length;
    const b = this.team(room, 'B').length;
    if (a >= TEAM_MAX && b >= TEAM_MAX) return null;
    return a <= b ? 'A' : 'B';
  }

  seated(room, member) {
    return room.game?.hands.has(member.id) ?? false;
  }

  // ---- everything a member of a room can do ----

  /** Performs one action. Returns an error message to show the sender, or nothing on success. */
  act(room, me, msg) {
    const isHost = room.hostId === me.id;
    const game = room.game;
    const rng = this.options.rng;

    switch (msg.t) {
      case 'team': {
        if (game) return 'Teams can only be changed in the lobby.';
        const team = msg.team ?? null;
        if (team !== null && team !== 'A' && team !== 'B') return 'Unknown team.';
        if (team && team !== me.team && this.team(room, team).length >= TEAM_MAX) return 'That team is full.';
        me.team = team;
        return;
      }

      case 'settings': {
        if (!isHost) return 'Only the host can change the settings.';
        if (game) return 'Settings can only be changed in the lobby.';
        const next = { ...room.settings };
        for (const [key, value] of Object.entries(msg.settings ?? {})) {
          if (!Object.hasOwn(SETTING_VALUES, key) || !SETTING_VALUES[key].includes(value)) return 'Unknown setting.';
          next[key] = value;
        }
        room.settings = next;
        return;
      }

      case 'addBot': {
        if (!isHost) return 'Only the host can add bots.';
        if (game) return 'Bots can only be added in the lobby.';
        if (msg.team !== 'A' && msg.team !== 'B') return 'Unknown team.';
        if (this.team(room, msg.team).length >= TEAM_MAX) return 'That team is full.';
        if (room.members.size >= ROOM_MAX) return 'The room is full.';
        const taken = new Set([...room.members.values()].map((m) => m.name));
        this.addMember(room, { name: BOT_NAMES.find((n) => !taken.has(n)) ?? 'Bot', team: msg.team, isBot: true });
        return;
      }

      case 'kick': {
        if (!isHost) return 'Only the host can remove players.';
        const target = room.members.get(msg.id);
        if (!target || target === me) return "You can't remove that player.";
        if (this.seated(room, target)) return 'Players in a game can only be removed back in the lobby.';
        target.conn?.send({ t: 'kicked' });
        this.remove(room, target);
        return;
      }

      case 'shuffle': {
        if (!isHost) return 'Only the host can shuffle the teams.';
        if (game) return 'Teams can only be changed in the lobby.';
        const players = shuffle([...room.members.values()].filter((m) => m.team), rng);
        players.forEach((m, i) => {
          m.team = i % 2 === 0 ? 'A' : 'B';
        });
        return;
      }

      case 'start': {
        if (!isHost) return 'Only the host can start the game.';
        if (game?.phase === 'playing') return 'A game is already under way.';
        const a = shuffle(this.team(room, 'A'), rng);
        const b = shuffle(this.team(room, 'B'), rng);
        if (a.length !== b.length) return 'Both teams need the same number of players.';
        if (a.length < TEAM_MIN) return `Each team needs at least ${TEAM_MIN} players.`;
        // Seats alternate teams around the table.
        const [first, second] = rng() < 0.5 ? [a, b] : [b, a];
        room.game = createGame({
          seats: first.flatMap((m, i) => [m, second[i]]),
          deck: room.settings.deck,
          declareAnytime: room.settings.declare === 'anytime',
          rng,
        });
        return;
      }

      case 'ask': {
        if (!game) return 'There is no game in progress.';
        if (!this.seated(room, me)) return 'You are watching this game.';
        const result = ask(game, me.id, msg.target, msg.card);
        return result.ok ? undefined : result.error;
      }

      case 'declare': {
        if (!game) return 'There is no game in progress.';
        if (!this.seated(room, me)) return 'You are watching this game.';
        const result = declare(game, me.id, msg.set, msg.assignment);
        return result.ok ? undefined : result.error;
      }

      case 'claimSeat': {
        // A spectator takes over a seat whose player has dropped out. This is also
        // how someone gets back in after losing their session (new device, closed tab).
        const seat = room.members.get(msg.id);
        if (!game || this.seated(room, me)) return 'You already have a seat.';
        if (!seat || !this.seated(room, seat) || seat.isBot || seat.connected) return "That seat isn't free.";
        const { conn, token, name } = me;
        const wasHost = isHost;
        this.remove(room, me);
        seat.token = token;
        seat.name = uniqueName({ members: new Map([...room.members].filter(([id]) => id !== seat.id)) }, name);
        if (wasHost) room.hostId = seat.id;
        this.attach(conn, room, seat);
        return;
      }

      case 'botControl': {
        if (!isHost) return 'Only the host can do that.';
        const seat = room.members.get(msg.id);
        if (game?.phase !== 'playing' || !seat || !this.seated(room, seat) || seat.isBot || seat.connected) {
          return 'Only an offline player can be covered by a bot.';
        }
        seat.botControlled = Boolean(msg.on);
        return;
      }

      case 'toLobby': {
        if (!isHost) return 'Only the host can end the game.';
        if (!game) return;
        clearTimeout(room.botTimer);
        room.botTimer = room.botKey = null;
        room.game = null;
        for (const m of [...room.members.values()]) {
          m.botControlled = false;
          if (!m.isBot && !m.connected) this.remove(room, m);
        }
        return;
      }

      default:
        return 'Unknown action.';
    }
  }

  // ---- what clients see ----

  broadcast(room) {
    if (this.rooms.get(room.code) !== room) return;
    const log = this.visibleLog(room);
    for (const member of room.members.values()) member.conn?.send(this.view(room, member, log));
    this.scheduleBot(room);
  }

  visibleLog(room) {
    const game = room.game;
    if (!game) return [];
    let log = game.log;
    if (room.settings.history === 'last' && game.phase === 'playing') {
      // Table rules: only the latest question is on show, plus anything declared since.
      const lastAsk = log.findLastIndex((event) => event.type === 'ask');
      log = log.slice(Math.max(lastAsk, 0));
    }
    return log.slice(-LOG_MAX);
  }

  /** The room as one member may see it: everyone's card counts, but only their own hand. */
  view(room, member, log = this.visibleLog(room)) {
    const game = room.game;
    return {
      t: 'state',
      code: room.code,
      phase: game ? game.phase : 'lobby',
      hostId: room.hostId,
      you: member.id,
      settings: room.settings,
      members: [...room.members.values()].map((m) => ({
        id: m.id,
        name: m.name,
        team: m.team,
        bot: m.isBot,
        online: m.connected,
        auto: m.botControlled,
        cards: game?.hands.get(m.id)?.size ?? null,
      })),
      game: game && {
        deck: game.deck,
        declareAnytime: game.declareAnytime,
        seats: game.seats.map((seat) => seat.id),
        turn: game.turn,
        score: game.score,
        sets: game.sets.map((set) => ({ id: set.id, claimedBy: set.claimedBy })),
        winner: game.winner,
        hand: sortCards([...(game.hands.get(member.id) ?? [])]),
        log,
      },
    };
  }

  // ---- bots ----

  scheduleBot(room) {
    const game = room.game;
    const mover = game?.phase === 'playing' ? room.members.get(game.turn) : null;
    if (!mover || !(mover.isBot || mover.botControlled)) {
      clearTimeout(room.botTimer);
      room.botTimer = room.botKey = null;
      return;
    }
    // One pending move per position, however many broadcasts happen meanwhile.
    const key = `${mover.id}:${game.log.length}`;
    if (room.botTimer && room.botKey === key) return;
    clearTimeout(room.botTimer);
    const [min, max] = this.options.botDelay;
    room.botKey = key;
    room.botTimer = timer(() => {
      room.botTimer = room.botKey = null;
      this.playBot(room, mover.id);
    }, min + Math.random() * (max - min));
  }

  playBot(room, id) {
    const game = room.game;
    if (game?.phase !== 'playing' || game.turn !== id) return;
    let result;
    try {
      const move = chooseMove(game, id, this.options.rng);
      result = move.type === 'ask' ? ask(game, id, move.target, move.card) : declare(game, id, move.set, move.assignment);
    } catch (error) {
      console.error('bot move failed', error);
    }
    if (!result?.ok) {
      // Never leave the table stuck on a bot: a declaration is always legal on your turn.
      const set = game.sets.find((s) => !s.claimedBy);
      declare(game, id, set.id, Object.fromEntries(set.cards.map((card) => [card, id])));
    }
    this.broadcast(room);
  }
}
