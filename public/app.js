// The browser client. The server owns the game; this file draws whatever state
// it sends and turns clicks into messages. There is no build step: render()
// rebuilds a DOM tree from `state` and morph() patches the live page to match.

import { buildSets, cardInfo, setIdOf, sortCards } from '/shared/cards.js';
import { deduce } from '/shared/deduce.js';

const TEAM_NAMES = { A: 'Orange', B: 'Purple' };
const other = (team) => (team === 'A' ? 'B' : 'A');
const cls = (...names) => names.filter(Boolean).join(' ');

const SETTINGS = [
  {
    key: 'deck',
    label: 'Deck',
    options: [
      [54, 'Nine sets of six', '54 cards. Each suit splits into low (2–7) and high (9–A); the 8s and two jokers make the ninth set.'],
      [72, 'Nine sets of eight', '72 cards. Every suit gains a 0, 1, 11 and 12, and there are four jokers. Gives 8 players nine cards each.'],
    ],
  },
  {
    key: 'declare',
    label: 'Declaring',
    options: [
      ['team', 'On your team’s turn', 'Anyone on the team that has the turn may declare.'],
      ['turn', 'On your own turn', 'Only the player whose turn it is may declare.'],
      ['anytime', 'Any time', 'Anyone may declare at any moment.'],
    ],
  },
  {
    key: 'botPace',
    label: 'Bot moves',
    options: [
      ['step', 'One at a time', 'A bot waits until a player presses Next, so everyone can follow each move.'],
      ['auto', 'Automatic', 'Bots play by themselves after a short pause.'],
    ],
  },
  {
    key: 'history',
    label: 'Question history',
    options: [
      ['full', 'Full log', 'Everyone can scroll back through every question.'],
      ['last', 'Last question only', 'Like at a real table: remember the rest yourself.'],
    ],
  },
];

// The clock's two settings, in seconds; 0 switches that part off.
const CLOCK_SETTINGS = [
  { key: 'moveTime', label: 'Time per move', none: 'No limit', values: [0, 10, 15, 20, 30, 45, 60, 90, 120, 180, 300] },
  { key: 'timeBank', label: 'Time bank', none: 'None', values: [0, 15, 30, 60, 120, 180, 300, 600] },
];

/** A length of time in words: "45 seconds", "2 minutes", "1 min 30 s". */
function duration(seconds) {
  if (seconds < 60) return `${seconds} seconds`;
  if (seconds % 60) return `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
  return seconds === 60 ? '1 minute' : `${seconds / 60} minutes`;
}

// ---------------------------------------------------------------- storage

function load(storage, key) {
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

function save(storage, key, value) {
  try {
    if (value == null) storage.removeItem(key);
    else storage.setItem(key, value);
  } catch {
    // Storage can be unavailable (private windows); the game still works without it.
  }
}

// The seat token lives in sessionStorage: it survives a reload, and two tabs in
// one browser can be two different players.
const sessionKey = (code) => `fish:room:${code}`;

function loadSession(code) {
  try {
    return JSON.parse(load(sessionStorage, sessionKey(code)));
  } catch {
    return null;
  }
}

/**
 * A random secret this browser keeps for good; the server rates the player it
 * stands for. Clearing site data, or using another browser, starts a new rating.
 */
function playerKey() {
  let key = load(localStorage, 'fish:player');
  if (!key) {
    key = Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, '0')).join('');
    save(localStorage, 'fish:player', key);
    if (load(localStorage, 'fish:player') !== key) return undefined; // storage is off: play as an unrated guest
  }
  return key;
}

const PLAYER = playerKey();

/** The name other players see. A new browser gets a placeholder, which can be changed on the profile page. */
function playerName() {
  let name = load(localStorage, 'fish:name');
  if (!name) {
    name = `Guest ${1000 + Math.floor(Math.random() * 9000)}`;
    save(localStorage, 'fish:name', name);
  }
  return name;
}

// ---------------------------------------------------------------- theme
// index.html sets <html data-theme> before the first paint: the saved choice, or else the system's.

const currentTheme = () => (document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  // Keep the phone's browser chrome the same colour as the page.
  document.querySelector('meta[name="theme-color"]').content = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
}

function themeButton() {
  const next = currentTheme() === 'dark' ? 'light' : 'dark';
  return h(
    'button',
    {
      class: 'icon-btn',
      title: `Switch to the ${next} theme`,
      'aria-label': `Switch to the ${next} theme`,
      onclick: () => {
        save(localStorage, 'fish:theme', next);
        applyTheme(next);
        render();
      },
    },
    icon(next === 'dark' ? 'moon' : 'sun'),
  );
}

// ---------------------------------------------------------------- sound
// Two short tones, made here so there is no file to fetch: one when the turn
// comes to you, one when your clock is nearly out. A browser only lets a page
// make sound once it has been clicked or typed in, so the first of either in a
// game wakes the audio up.

const SOUNDS = {
  turn: [[659, 0.16], [880, 0.3]], // each note is [pitch in Hz, length in seconds]
  hurry: [[440, 0.11], [440, 0.11]],
};
let sound = load(localStorage, 'fish:sound') !== 'off';
let audio = null;

function wakeAudio() {
  if (!sound || !state.code) return;
  try {
    audio ??= new (window.AudioContext ?? window.webkitAudioContext)();
    if (audio.state !== 'running') audio.resume().catch(() => {});
  } catch {
    // No sound in this browser; everything else works without it.
  }
}

function play(notes) {
  if (!sound || audio?.state !== 'running') return;
  let at = audio.currentTime + 0.02;
  for (const [pitch, length] of notes) {
    const tone = audio.createOscillator();
    const volume = audio.createGain();
    tone.frequency.value = pitch;
    volume.gain.setValueAtTime(0.0001, at);
    volume.gain.exponentialRampToValueAtTime(0.14, at + 0.015);
    volume.gain.exponentialRampToValueAtTime(0.0001, at + length);
    tone.connect(volume).connect(audio.destination);
    tone.start(at);
    tone.stop(at + length + 0.02);
    at += length * 0.75;
  }
}

function soundButton() {
  const label = sound ? 'Turn the sounds off' : 'Turn the sounds on';
  return h(
    'button',
    {
      class: 'icon-btn',
      title: `${label}: a tone when it is your turn, and when your clock is nearly out`,
      'aria-label': label,
      'aria-pressed': String(sound),
      onclick: () => {
        sound = !sound;
        save(localStorage, 'fish:sound', sound ? null : 'off');
        // Switching them on plays one, so you know what to listen for.
        wakeAudio();
        if (sound) audio?.resume().then(() => play(SOUNDS.turn), () => {});
        render();
      },
    },
    icon(sound ? 'sound' : 'mute'),
  );
}

// ---------------------------------------------------------------- state

// Room codes have no vowels, so a page like "/help" is never mistaken for one.
const ROOM_PATH = /^\/([BCDFGHJKLMNPQRSTVWXZ]{4})$/i;
const PAGES = { '/help': 'help', '/profile': 'profile' };
const REVIEW_PATH = /^\/game\/([0-9a-f]{16})$/; // a finished game, looked back at

const state = {
  status: 'connecting', // connecting | open | closed
  view: null, // the latest room state from the server
  code: (location.pathname.match(ROOM_PATH)?.[1] ?? '').toUpperCase() || null, // the room we are in, or on our way into
  page: PAGES[location.pathname] ?? (REVIEW_PATH.test(location.pathname) ? 'review' : 'lobby'), // the screen to show when not in a room: lobby | help | profile | review
  reviewId: location.pathname.match(REVIEW_PATH)?.[1] ?? null,
  review: null, // { id, record, analysis, frames } once it arrives, or { id, missing: true }
  reviewStep: 0, // 0 is the deal; k is the position in which move k was made
  reviewSeat: null, // the seat whose view of the game is shown, or null for every hand face up
  reviewTruth: false, // in a seat's view: also show where the cards they couldn't place really were
  name: playerName(),
  busy: false,
  lobby: null, // { games, yours, online, played }: what the lobby lists
  lobbyTab: 'games', // games | yours | top
  chat: [], // lobby chat messages
  chatDraft: '',
  roomChat: [], // what has been said in the room we are in
  chatUnread: 0, // ...and how much of it arrived while the game log was showing
  sideTab: 'log', // beside the game: log | chat
  linkCode: null, // { code, minutes }: a code for using this profile on another device
  linkDraft: '',
  profile: null, // { me, stats, games }: this player's record, once asked for
  nameDraft: null, // the name being edited on the profile page
  codeDraft: '',
  tab: 'ask',
  askCard: null,
  askTarget: null,
  declOpen: false,
  clockAt: 0, // when the latest state arrived, by this page's own clock: the countdown runs from here
  declSet: null,
  declSide: 'mine', // whose players the declaration names: 'mine' (your team) or 'theirs'
  declAssign: {},
  fresh: new Set(), // cards that arrived in the latest update, so they can be animated in
  ratings: null, // { me, top }: this player's Elo standing and the leaderboard
  stale: false, // the server is running older code than this page was written for
  toast: null,
  flashed: 0,
};

// ---------------------------------------------------------------- network

let ws = null;
let retries = 0;
let toastTimer = null;

function connect() {
  state.status = retries ? 'closed' : 'connecting';
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  ws.onopen = () => {
    retries = 0;
    state.status = 'open';
    send({ t: 'hello', player: PLAYER, name: state.name }); // says who we are; the answer is the lobby
    // A room link, or a room we were in before the connection dropped: go (back) in.
    if (state.code) send({ t: 'join', code: state.code, name: state.name, token: loadSession(state.code)?.token, player: PLAYER });
    else if (state.page === 'profile') send({ t: 'profile' });
    else if (state.page === 'review' && !state.review) send({ t: 'review', id: state.reviewId });
    render();
  };
  ws.onmessage = (event) => receive(JSON.parse(event.data));
  ws.onclose = () => {
    state.status = 'closed';
    state.busy = false;
    render();
    setTimeout(connect, Math.min(5000, 400 * 2 ** retries++));
  };
}

function send(msg) {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
    return true;
  }
  toast('Not connected. Trying again…', 'bad');
  return false;
}

function receive(msg) {
  switch (msg.t) {
    case 'joined':
      state.code = msg.code;
      state.roomChat = msg.chat ?? [];
      save(sessionStorage, sessionKey(msg.code), JSON.stringify({ token: msg.token }));
      if (location.pathname !== `/${msg.code}`) history.pushState(null, '', `/${msg.code}`);
      break;
    case 'state': {
      // Anything in the new hand that wasn't in the old one was just dealt or won.
      const before = state.view ? (state.view.game?.hand ?? []) : null;
      state.fresh = new Set(before && msg.game ? msg.game.hand.filter((card) => !before.includes(card)) : []);
      const myTurn = (view) => view?.phase === 'playing' && view.game.turn === view.you;
      if (myTurn(msg) && !myTurn(state.view)) play(SOUNDS.turn);
      if (!msg.game) state.chatUnread = 0; // between games the chat is in full view
      state.view = msg;
      state.clockAt = performance.now();
      state.stale = Boolean(msg.stale);
      state.busy = false;
      reconcile();
      break;
    }
    case 'ratings':
      state.ratings = { me: msg.me, top: msg.top };
      break;
    case 'lobby':
      state.lobby = { games: msg.games, yours: msg.yours, online: msg.online, played: msg.played };
      state.stale = Boolean(msg.stale);
      state.ratings = { me: msg.me, top: msg.top };
      if (msg.chat) state.chat = msg.chat;
      break;
    case 'chat':
      if (!msg.room) state.chat = [...state.chat, msg.message].slice(-200);
      else if (msg.room === state.code) {
        state.roomChat = [...state.roomChat, msg.message].slice(-200);
        // In a game the chat shares its panel with the log: count what arrives while the log is showing.
        if (state.view?.game && state.sideTab !== 'chat') {
          state.chatUnread += 1;
          // On a phone that count is far down the page, so what was said is shown where it will be seen.
          const tabs = document.querySelector('.log-tabs')?.getBoundingClientRect();
          if (!tabs || tabs.top >= innerHeight || tabs.bottom <= 0) toast(`${msg.message.name}: ${msg.message.text}`.slice(0, 120));
        }
      }
      break;
    case 'profile':
      state.profile = { me: msg.me, stats: msg.stats, games: msg.games };
      break;
    case 'linkCode':
      state.linkCode = { code: msg.code, minutes: msg.minutes };
      break;
    case 'linked':
      // The other device's key becomes this browser's: from the next load on, it is the same player.
      save(localStorage, 'fish:player', msg.player);
      if (load(localStorage, 'fish:player') !== msg.player) {
        toast('This browser is blocking storage, so it can’t keep the profile.', 'bad');
        break;
      }
      if (msg.name) save(localStorage, 'fish:name', msg.name);
      save(sessionStorage, 'fish:linked', '1');
      location.reload();
      return;
    case 'review':
      if (msg.id !== state.reviewId) break;
      state.review = msg.missing ? { id: msg.id, missing: true } : { id: msg.id, record: msg.record, analysis: msg.analysis, frames: reviewFrames(msg.record) };
      state.reviewStep = 0;
      break;
    case 'error':
      state.busy = false;
      if (msg.code === 'no-room' && !state.code) {
        // We weren't in a room or heading for one, so this is a server that didn't understand
        // our hello: one started before the lobby existed. Say so, and stay on this page.
        state.stale = true;
        break;
      }
      if (msg.code === 'no-room') exitRoom();
      toast(msg.message, 'bad');
      break;
    case 'kicked':
      exitRoom();
      toast('The host removed you from the room.', 'bad');
      break;
    case 'replaced':
      // This seat was opened in another tab, which now owns it.
      exitRoom();
      toast('This game is now open in another tab.');
      break;
  }
  render();
}

function exitRoom() {
  if (state.code) save(sessionStorage, sessionKey(state.code), null);
  Object.assign(state, { view: null, code: null, busy: false, page: 'lobby', roomChat: [], chatUnread: 0, sideTab: 'log', chatDraft: '' });
  resetMoves();
  if (location.pathname !== '/') history.replaceState(null, '', '/');
  // Back in the lobby: ask for it afresh, since nothing about it was sent while we were in a room.
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'hello', player: PLAYER, name: state.name }));
}

function toast(text, kind = 'info') {
  state.toast = { text, kind };
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    state.toast = null;
    render();
  }, 4000);
  render();
}

// ---------------------------------------------------------------- actions

/** Starts a new room and goes into it. Public rooms are listed in the lobby; private ones need the link. */
function createGame(isPublic) {
  send({ t: 'create', name: state.name, player: PLAYER, public: isPublic });
}

/** Goes into a room. If it turns out not to exist, the server says so and we land back in the lobby. */
function enterRoom(code) {
  state.code = code;
  send({ t: 'join', code, name: state.name, token: loadSession(code)?.token, player: PLAYER });
  render();
}

function joinByCode(event) {
  event.preventDefault();
  const code = state.codeDraft.trim().toUpperCase();
  if (!/^[A-Z]{4}$/.test(code)) return toast('Game codes are four letters.', 'bad');
  state.codeDraft = '';
  enterRoom(code);
}

function sendChat(event) {
  event.preventDefault();
  const input = event.target.elements.text;
  if (!input.value.trim()) return;
  if (send({ t: 'chat', text: input.value, name: state.name })) {
    input.value = '';
    state.chatDraft = '';
  }
}

function saveName(event) {
  event.preventDefault();
  const name = (state.nameDraft ?? state.name).replace(/\s+/g, ' ').trim().slice(0, 20);
  if (!name) return toast('Enter a name.', 'bad');
  state.name = name;
  state.nameDraft = null;
  save(localStorage, 'fish:name', name);
  send({ t: 'hello', player: PLAYER, name }); // so the chat and new games use it straight away
  toast('Name saved.');
}

/** Asks to switch this browser to the profile a code from another device stands for. */
function useLinkCode(event) {
  event.preventDefault();
  const code = state.linkDraft.replace(/[^a-z0-9]/gi, '');
  if (code.length !== 8) return toast('A code is eight letters and numbers.', 'bad');
  const games = state.profile?.stats?.games ?? 0;
  const left = games ? ` The ${games === 1 ? 'game' : `${games} games`} played from this browser will stay with its old profile, which it will stop using.` : '';
  if (!confirm(`Switch this browser to the profile that code came from?${left}`)) return;
  if (send({ t: 'linkUse', code })) state.linkDraft = '';
}

function leaveRoom() {
  const inGame = state.view?.game && state.view.game.seats.includes(state.view.you) && state.view.phase === 'playing';
  if (inGame && !confirm('Leave the game? Your seat stays open, and the host can let a bot play your cards.')) return;
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'leave' }));
  exitRoom();
  render();
}

async function copyLink() {
  const url = `${location.origin}/${state.view.code}`;
  try {
    await navigator.clipboard.writeText(url);
    toast('Invite link copied.');
  } catch {
    // No clipboard access (plain http on a LAN address, for one): show it to copy by hand.
    prompt('Copy this link and send it to your friends:', url);
  }
}

function resetMoves() {
  Object.assign(state, { tab: 'ask', askCard: null, askTarget: null, declOpen: false, declSet: null, declSide: 'mine', declAssign: {} });
}

function submitAsk() {
  if (!state.askCard || !state.askTarget) return;
  if (send({ t: 'ask', target: state.askTarget, card: state.askCard })) {
    state.busy = true;
    state.askCard = null;
    render();
  }
}

/** Lets the bot whose turn it is make its move. Says which move we were looking at, so a second press can't skip one. */
function stepBot() {
  if (send({ t: 'next', at: state.view.game.position })) {
    state.busy = true;
    render();
  }
}

function submitDeclare() {
  if (!state.declSet) return;
  if (send({ t: 'declare', set: state.declSet, assignment: state.declAssign })) {
    state.busy = true;
    state.declOpen = false;
    state.tab = 'ask';
    render();
  }
}

/** Drops selections the latest state has made impossible, and keeps the declare form in step with the hand. */
function reconcile() {
  const { game, you, members } = state.view;
  if (!game || game.winner || !game.seats.includes(you)) return resetMoves();
  const hand = new Set(game.hand);
  const heldSets = new Set(game.hand.map(setIdOf));
  const cardsOf = new Map(members.map((m) => [m.id, m.cards]));

  if (state.askCard && (hand.has(state.askCard) || !heldSets.has(setIdOf(state.askCard)))) state.askCard = null;
  if (state.askTarget && !cardsOf.get(state.askTarget)) state.askTarget = null;
  if (game.turn !== you) {
    state.tab = 'ask';
    if (!game.canDeclare) state.declOpen = false;
  } else if (state.declOpen) {
    // The turn arrived while they were filling in a declaration: keep them on it.
    state.tab = 'declare';
    state.declOpen = false;
  }

  const set = buildSets(game.deck).find((s) => s.id === state.declSet);
  if (!set || game.sets.find((s) => s.id === set.id).claimedBy) {
    state.declSet = null;
    state.declSide = 'mine';
    state.declAssign = {};
    return;
  }
  if (state.declSide === 'theirs' && set.cards.some((card) => hand.has(card))) {
    // They have picked up part of the set, so it can no longer all be with the other team.
    state.declSide = 'mine';
    state.declAssign = {};
  }
  for (const card of set.cards) {
    const assigned = state.declAssign[card];
    if (hand.has(card)) state.declAssign[card] = you;
    else if (assigned === you || (assigned && !cardsOf.get(assigned))) delete state.declAssign[card];
  }
}

// ---------------------------------------------------------------- rendering

/** Builds an element. Attributes starting with "on" are event handlers; null/false attributes and children are skipped. */
function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs ?? {})) {
    if (value == null || value === false) continue;
    if (key.startsWith('on')) {
      (el.handlers ??= {})[key] = value;
      el[key] = value;
    } else {
      el.setAttribute(key, value === true ? '' : value);
    }
  }
  for (const child of children.flat(Infinity)) {
    if (child != null && child !== false && child !== '') el.append(child);
  }
  return el;
}

/**
 * Makes the live node `from` match the freshly built `to`, changing only what
 * differs. Keeping the existing elements means focus, scroll position, typed
 * text and half-finished clicks all survive a server update.
 */
function morph(from, to) {
  if (from.nodeType !== to.nodeType || from.nodeName !== to.nodeName) return from.replaceWith(to);
  if (from.nodeType === Node.TEXT_NODE) {
    if (from.data !== to.data) from.data = to.data;
    return;
  }
  for (const { name } of [...from.attributes]) if (!to.hasAttribute(name)) from.removeAttribute(name);
  for (const { name, value } of to.attributes) if (from.getAttribute(name) !== value) from.setAttribute(name, value);
  for (const key of Object.keys({ ...from.handlers, ...to.handlers })) from[key] = to.handlers?.[key] ?? null;
  from.handlers = to.handlers;
  if (from.nodeName === 'INPUT') {
    if (from.type === 'radio' || from.type === 'checkbox') from.checked = to.hasAttribute('checked');
    else if (from !== document.activeElement && from.value !== to.value) from.value = to.value;
  }

  const chosen = from.nodeName === 'SELECT' ? to.value : null;

  const before = [...from.childNodes];
  const after = [...to.childNodes];
  after.forEach((node, i) => (before[i] ? morph(before[i], node) : from.append(node)));
  before.slice(after.length).forEach((node) => node.remove());
  if (chosen !== null && from.value !== chosen) from.value = chosen;
}

function render() {
  const root = document.getElementById('app');
  // Keep the chat scrolled to the latest message, unless the reader has scrolled up to look back.
  const chat = root.querySelector('.chat-list');
  const atEnd = !chat || chat.scrollHeight - chat.scrollTop - chat.clientHeight < 60;
  morph(root, h('div', { id: 'app' }, screen(), statusBar(), toastEl()));
  const chatNow = root.querySelector('.chat-list');
  if (chatNow && atEnd) chatNow.scrollTop = chatNow.scrollHeight;
  // In a review, the list of moves follows the move being looked at.
  if (state.page === 'review' && state.reviewShown !== state.reviewStep) {
    state.reviewShown = state.reviewStep;
    const list = root.querySelector('.review-list');
    const row = list?.querySelector('.current');
    if (row) list.scrollTop += row.getBoundingClientRect().top - list.getBoundingClientRect().top - (list.clientHeight - row.offsetHeight) / 2;
    else if (list) list.scrollTop = 0;
  }

  const game = state.view?.game;
  document.title = game?.turn && game.turn === state.view.you ? 'Your turn · Fish' : 'Fish with Friends';

  // Draw the eye to the announcement whenever something new has happened.
  const seq = game?.log.at(-1)?.seq ?? 0;
  if (seq !== state.flashed) {
    state.flashed = seq;
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (seq && !reduced) root.querySelector('.banner')?.animate([{ transform: 'scale(1.015)', boxShadow: '0 0 0 4px rgb(128 128 128 / 0.55)' }, {}], 450);
  }
}

function screen() {
  if (state.view) return state.view.phase === 'lobby' ? setupScreen() : gameScreen();
  if (state.code) return h('div', { class: 'page' }, topbar(), h('main', { class: 'notice' }, h('p', { class: 'muted' }, 'Joining the game…')));
  if (state.page === 'help') return helpScreen();
  if (state.page === 'profile') return profileScreen();
  if (state.page === 'review') return reviewScreen();
  return lobbyScreen();
}

function statusBar() {
  if (state.status === 'closed' || (state.status === 'connecting' && state.view)) {
    return h('div', { class: 'statusbar', role: 'status' }, 'Connection lost. Reconnecting…');
  }
  if (state.stale) {
    return h(
      'div',
      { class: 'statusbar stale', role: 'status' },
      h('strong', {}, 'The server needs a restart. '),
      'It is running an older version of the game than this page, so parts of the site won’t work. In the terminal where it runs, press Ctrl+C, then run ',
      h('code', {}, 'npm start'),
      ' again.',
    );
  }
  return null;
}

function toastEl() {
  return h('div', { class: 'toast-wrap', 'aria-live': 'polite' }, state.toast ? h('div', { class: `toast ${state.toast.kind}` }, state.toast.text) : null);
}

// ---- small pieces used everywhere

/**
 * A suit mark, drawn in CSS so it looks the same on every device. No suit means
 * a joker's star. On a card it takes the card's colour; `tinted` gives a mark
 * standing on its own the colour of its suit.
 */
function pip(suit, { tinted = false } = {}) {
  return h('span', { class: cls('pip', `pip-${suit ?? 'star'}`, tinted && suit && `suit-${suit}`), 'aria-hidden': 'true' });
}

function icon(name) {
  return h('span', { class: `icon icon-${name}`, 'aria-hidden': 'true' });
}

function cardFace(info) {
  return [h('span', { class: 'rank' }, info.rank), pip(info.suit)];
}

function cardEl(card, { small = false, fresh = false } = {}) {
  const info = cardInfo(card);
  return h(
    'span',
    { class: cls('card', `suit-${info.tint}`, info.joker && 'joker', small && 'small', fresh && 'fresh'), role: 'img', 'aria-label': info.name, title: info.name },
    cardFace(info),
  );
}

/** A card mentioned in running text. */
function cardChip(card) {
  const info = cardInfo(card);
  return h('span', { class: `chip suit-${info.tint}`, role: 'img', 'aria-label': info.name, title: info.name }, info.rank, pip(info.suit));
}

/** Minutes and seconds left, rounded up so the clock reads 0:00 only when time is really up. */
function mmss(ms) {
  const seconds = Math.ceil(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/** What the player on the clock has left at this moment, counted down from the server's last word on it. */
function clockNow() {
  const clock = state.view?.game?.clock;
  if (!clock) return null;
  const spent = performance.now() - state.clockAt;
  const move = Math.max(0, clock.move - spent);
  const bank = Math.max(0, clock.bank - Math.max(0, spent - clock.move));
  const onBank = move <= 0;
  return { player: clock.player, onBank, low: (onBank ? bank : move) <= 10_000, move: mmss(move), bank: `+${mmss(bank)}` };
}

/**
 * The countdown for the player to move: their time for this move, then their
 * time bank. `brief` shows only whichever of the two is running. Between
 * renders, tickClock() rewrites every one of these in place.
 */
function clockEl({ brief = false } = {}) {
  const now = clockNow();
  if (!now) return null;
  return h(
    'span',
    { class: cls('clock', brief && 'brief', now.onBank && 'on-bank', now.low && 'low'), role: 'timer', title: 'Time for this move, then the time bank' },
    h('span', { class: 'clock-move' }, now.move),
    h('span', { class: 'clock-bank' }, now.bank),
  );
}

let hurried = null; // the move and part of the clock the warning tone last sounded for

function tickClock() {
  const now = clockNow();
  if (!now) return;
  // One warning as your own time runs low: for the move (unless it was short to begin with), and again for the time bank.
  if (now.low && now.player === state.view.you && (now.onBank || state.view.settings.moveTime > 10)) {
    const key = `${state.view.code}:${state.view.game.position}:${now.onBank}`;
    if (key !== hurried) play(SOUNDS.hurry);
    hurried = key;
  }
  for (const el of document.querySelectorAll('.clock')) {
    el.classList.toggle('on-bank', now.onBank);
    el.classList.toggle('low', now.low);
    const [move, bank] = el.children;
    if (move.textContent !== now.move) move.textContent = now.move;
    if (bank.textContent !== now.bank) bank.textContent = now.bank;
  }
}

/** Short name for a set: its suit mark and "low" or "high". */
function setLabel(set) {
  return set.suit ? [pip(set.suit, { tinted: true }), set.kind] : '8s & jokers';
}

function tag(text, kind = '') {
  return h('span', { class: `tag ${kind}` }, text);
}

/** A player's name in their own colour: the same hue every time, picked by the server. */
function coloured(name, hue) {
  return h('span', { class: 'name', style: `--hue: ${hue}` }, name);
}

/** "3 minutes ago". The clock is the browser's, so anything in the future counts as now. */
function ago(time) {
  const minutes = Math.floor((Date.now() - time) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ${hours === 1 ? 'hour' : 'hours'} ago`;
  const days = Math.floor(hours / 24);
  return `${days} ${days === 1 ? 'day' : 'days'} ago`;
}

const deckName = (deck) => (deck === 72 ? 'Sets of eight' : 'Sets of six');

// ---- the bar across the top of every screen

function topbar() {
  const v = state.view;
  const isHost = v && v.hostId === v.you;
  // From inside a room, other pages open in a new tab, so the game stays where it is.
  const away = v ? { target: '_blank', rel: 'noopener' } : {};
  return h(
    'header',
    { class: cls('topbar', v && 'in-room') },
    v ? h('span', { class: 'brand' }, 'Fish') : h('a', { class: 'brand', href: '/' }, 'Fish with Friends'),
    v
      ? h('button', { class: 'room-pill', title: 'Copy the invite link', onclick: copyLink }, h('span', { class: 'label' }, 'Game'), h('strong', {}, v.code), h('span', { class: 'copy' }, 'Copy link'))
      : null,
    h('span', { class: 'spacer' }),
    isHost && v.phase === 'playing'
      ? h('button', { class: 'btn quiet', onclick: () => confirm('End this game for everyone and go back to choosing teams?') && send({ t: 'toLobby' }) }, 'End game')
      : null,
    v ? h('button', { class: 'btn quiet', onclick: leaveRoom }, 'Leave') : null,
    h('a', { class: 'me', href: '/profile', title: 'Your profile: your games and statistics', ...away }, state.name),
    h('a', { class: 'icon-btn', href: '/help', title: 'Help: how to play', 'aria-label': 'Help: how to play', ...away }, '?'),
    v ? soundButton() : null,
    themeButton(),
  );
}

// ---- lobby: who is around, the games you can join, and a chat

function lobbyScreen() {
  const lobby = state.lobby ?? { games: [], yours: [], online: 0, played: 0 };
  const tab = state.lobbyTab;
  const tabs = [
    ['games', 'Lobby'],
    ['yours', 'Your games'],
    ['top', 'Leaderboard'],
  ];
  return h(
    'div',
    { class: 'page' },
    topbar(),
    h(
      'main',
      { class: 'lobby' },
      chatPanel(),
      h(
        'section',
        { class: 'lobby-games' },
        h(
          'div',
          { class: 'lobby-tabs', role: 'tablist' },
          tabs.map(([id, label]) =>
            h(
              'button',
              {
                class: 'lobby-tab',
                role: 'tab',
                'aria-selected': String(tab === id),
                onclick: () => {
                  state.lobbyTab = id;
                  render();
                },
              },
              label,
              id === 'yours' && lobby.yours.length ? h('span', { class: 'tab-count' }, lobby.yours.length) : null,
            ),
          ),
        ),
        h('div', { class: 'panel lobby-table' }, tab === 'top' ? leaderboard() : gamesTable(tab === 'games' ? lobby.games : lobby.yours, tab)),
      ),
      h(
        'aside',
        { class: 'lobby-side' },
        h('button', { class: 'btn primary big', onclick: () => createGame(true) }, 'Create a game'),
        h('button', { class: 'btn big', onclick: () => createGame(false) }, 'New private game'),
        h(
          'form',
          { class: 'join-row', onsubmit: joinByCode },
          h('input', {
            type: 'text',
            'aria-label': 'Game code',
            maxlength: 4,
            autocomplete: 'off',
            autocapitalize: 'characters',
            spellcheck: 'false',
            placeholder: 'Code',
            class: 'code-input',
            value: state.codeDraft,
            oninput: (e) => {
              state.codeDraft = e.target.value;
            },
          }),
          h('button', { class: 'btn', type: 'submit' }, 'Join'),
        ),
        youCard(),
        h(
          'p',
          { class: 'lobby-stats' },
          h('strong', {}, lobby.online.toLocaleString()),
          lobby.online === 1 ? ' player online' : ' players online',
          h('br'),
          h('strong', {}, lobby.played.toLocaleString()),
          lobby.played === 1 ? ' game played' : ' games played',
        ),
      ),
    ),
    h('footer', { class: 'footer' }, h('a', { href: '/help' }, 'Help'), ' · ', h('a', { href: '/profile' }, 'Your profile')),
  );
}

/** Who you are playing as, your rating at a glance, and the way to your profile. */
function youCard() {
  const me = state.ratings?.me;
  return h(
    'a',
    { class: 'panel you-card', href: '/profile', title: 'Your profile: statistics and every game you have played' },
    h('span', { class: 'muted small' }, 'Playing as'),
    h('span', { class: 'you-name nm' }, state.name),
    h('span', { class: 'muted small' }, me?.games ? `Rating ${me.rating} · ${me.wins} won, ${me.losses} lost` : 'No rated games yet'),
    h('span', { class: 'you-link' }, 'Profile and statistics'),
  );
}

function gamesTable(games, tab) {
  if (games.length === 0) {
    return h('p', { class: 'muted empty-note' }, tab === 'games' ? 'No open games right now. Create one and it will show up here.' : 'You aren’t in any games at the moment.');
  }
  const status = { waiting: 'Open', playing: 'Playing', finished: 'Finished' };
  return h(
    'table',
    { class: 'games' },
    h('thead', {}, h('tr', {}, ['Host', 'Players', 'Deck', 'Status', 'Created'].map((label) => h('th', { scope: 'col' }, label)))),
    h(
      'tbody',
      {},
      games.map((game) =>
        // The whole row goes into the game; the host's name is a real link so it works from the keyboard too.
        h(
          'tr',
          { title: game.status === 'waiting' ? 'Join this game' : 'Watch this game', onclick: () => enterRoom(game.code) },
          h('td', {}, h('a', { class: 'name', style: `--hue: ${game.hue}`, href: `/${game.code}`, onclick: (e) => e.preventDefault() }, game.host), game.private ? tag('private') : null),
          h('td', {}, game.players),
          h('td', {}, deckName(game.deck)),
          h('td', {}, h('span', { class: `status ${game.status}` }, status[game.status])),
          h('td', { class: 'muted' }, ago(game.createdAt)),
        ),
      ),
    ),
  );
}

/**
 * A chat's messages and the box for adding to it. In the lobby a speaker has a
 * colour of their own; in a room they have their team's.
 */
function chatBox(messages) {
  const speaker = (m) => (m.hue == null ? h('span', { class: cls('who', m.team && `team-${m.team}`) }, m.name) : coloured(m.name, m.hue));
  return [
    h(
      'ol',
      { class: 'chat-list', 'aria-live': 'polite' },
      messages.length === 0 ? h('li', { class: 'muted' }, 'Nobody has said anything yet.') : messages.map((m) => h('li', {}, speaker(m), ': ', m.text)),
    ),
    h(
      'form',
      { class: 'chat-form', onsubmit: sendChat },
      h('input', {
        type: 'text',
        name: 'text',
        maxlength: 240,
        autocomplete: 'off',
        'aria-label': 'Message',
        placeholder: 'Type a message…',
        value: state.chatDraft,
        oninput: (e) => {
          state.chatDraft = e.target.value;
        },
      }),
    ),
  ];
}

function chatPanel() {
  return h('section', { class: 'panel chat' }, h('h2', {}, 'Lobby chat'), chatBox(state.chat));
}

function leaderboard() {
  const { me, top } = state.ratings ?? { me: null, top: [] };
  return h(
    'div',
    { class: 'board' },
    me?.games ? h('p', { class: 'board-me' }, 'Your rating is ', h('strong', {}, me.rating), `: rank ${me.rank}, ${me.wins} won and ${me.losses} lost.`) : null,
    top.length === 0 ? h('p', { class: 'muted' }, 'No rated games yet. Everyone starts at 1000, the bots included, and ratings move after each game.') : null,
    h(
      'ol',
      { class: 'board-list' },
      top.map((row) =>
        h(
          'li',
          { class: cls(row.you && 'you') },
          h('span', { class: 'board-rank' }, row.rank),
          h('span', { class: 'nm' }, row.name),
          row.you ? tag('you') : null,
          row.bot ? h('span', { class: 'tag', title: 'Every bot plays the same way, so they share one rating' }, 'all bots') : null,
          h('span', { class: 'board-record', title: `${row.wins} won, ${row.losses} lost` }, `${row.wins}–${row.losses}`),
          h('span', { class: 'board-rating' }, row.rating),
        ),
      ),
    ),
  );
}

// ---- profile: this browser's player, their numbers, and every game they have finished

function profileScreen() {
  const profile = state.profile;
  const stats = profile?.stats ?? { games: 0, wins: 0, losses: 0, rated: 0, setsWon: 0, setsLost: 0, streak: 0, bestStreak: 0 };
  const streak = stats.streak > 0 ? `${stats.streak} won` : stats.streak < 0 ? `${-stats.streak} lost` : '–';
  const me = profile?.me;
  const stat = (label, value, note) => h('div', { class: 'stat' }, h('span', { class: 'stat-value' }, value), h('span', { class: 'stat-label' }, label), note ? h('span', { class: 'muted small' }, note) : null);
  const when = (time) => new Date(time).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  return h(
    'div',
    { class: 'page' },
    topbar(),
    h(
      'main',
      { class: 'profile' },
      h('h1', {}, 'Your profile'),
      h(
        'form',
        { class: 'panel name-form', onsubmit: saveName },
        h(
          'label',
          { class: 'field' },
          h('span', {}, 'Name'),
          h('input', {
            type: 'text',
            maxlength: 20,
            autocomplete: 'nickname',
            value: state.nameDraft ?? state.name,
            oninput: (e) => {
              state.nameDraft = e.target.value;
            },
          }),
        ),
        h('button', { class: 'btn', type: 'submit' }, 'Save'),
      ),
      PLAYER
        ? h('p', { class: 'muted small' }, 'Your games and rating are kept for this browser. Clearing its site data, or playing from another browser, starts a new record, unless you bring this one across with a code (below).')
        : h('p', { class: 'muted small' }, 'This browser is blocking storage, so it can’t be recognised from one visit to the next and no record is kept.'),
      profile
        ? h(
            'section',
            { class: 'stats', 'aria-label': 'Statistics' },
            stat('Rating', me?.rating ?? '–', me?.rank ? `rank ${me.rank}` : 'no rated games yet'),
            stat('Games', stats.games, `${stats.rated} rated`),
            stat('Won', stats.wins),
            stat('Lost', stats.losses),
            stat('Win rate', stats.games ? `${Math.round((100 * stats.wins) / stats.games)}%` : '–'),
            stat('Sets', `${stats.setsWon}–${stats.setsLost}`, 'won and lost'),
            stat('Streak', streak, stats.bestStreak ? `best run: ${stats.bestStreak} won` : 'in a row'),
          )
        : h('p', { class: 'muted' }, 'Loading your record…'),
      profile
        ? h(
            'section',
            { class: 'panel history' },
            h('h2', {}, 'Games'),
            profile.games.length === 0
              ? h('p', { class: 'muted' }, 'You haven’t finished a game yet. Every game you play to the end will be listed here, to look back at move by move.')
              : h(
                  'div',
                  { class: 'table-scroll' },
                  h(
                    'table',
                    { class: 'games' },
                    h('thead', {}, h('tr', {}, ['Played', 'Result', 'Score', 'With', 'Against', 'Deck', 'Rating', ''].map((label) => h('th', { scope: 'col' }, label)))),
                    h(
                      'tbody',
                      {},
                      profile.games.map((game) =>
                        h(
                          'tr',
                          {},
                          h('td', { class: 'muted' }, when(game.endedAt)),
                          h('td', {}, h('span', { class: `result-word ${game.won ? 'won' : 'lost'}` }, game.won ? 'Won' : 'Lost')),
                          h('td', {}, `${game.score[0]}–${game.score[1]}`),
                          h('td', {}, game.mates.join(', ') || '–'),
                          h('td', {}, game.foes.join(', ')),
                          h('td', {}, deckName(game.deck)),
                          h(
                            'td',
                            {},
                            game.rated && game.delta != null
                              ? [h('span', { class: cls('delta', game.delta > 0 ? 'up' : 'down') }, game.delta > 0 ? `+${game.delta}` : `−${-game.delta}`), ' ', h('span', { class: 'muted' }, game.after)]
                              : h('span', { class: 'muted' }, 'practice'),
                          ),
                          h('td', {}, game.id ? h('a', { class: 'review-link', href: `/game/${game.id}` }, 'Review') : null),
                        ),
                      ),
                    ),
                  ),
                ),
          )
        : null,
      PLAYER ? linkPanel() : null,
    ),
  );
}

/** Taking this profile to another device, or bringing one here: a code made on one, typed in on the other. */
function linkPanel() {
  const made = state.linkCode;
  return h(
    'section',
    { class: 'panel link-panel' },
    h('h2', {}, 'Another device'),
    h('p', { class: 'muted small' }, 'To play as yourself on another phone or computer, get a code here and type it in on that device’s profile page. Both will then share this name, rating and list of games.'),
    h(
      'div',
      { class: 'link-row' },
      h('button', { class: 'btn', onclick: () => send({ t: 'linkCode', player: PLAYER, name: state.name }) }, made ? 'Get a new code' : 'Get a code'),
      made ? h('strong', { class: 'code link-code' }, `${made.code.slice(0, 4)} ${made.code.slice(4)}`) : null,
      made ? h('span', { class: 'muted small' }, `Works once, within ${made.minutes} minutes.`) : null,
    ),
    h(
      'form',
      { class: 'link-row', onsubmit: useLinkCode },
      h('input', {
        type: 'text',
        maxlength: 12,
        autocomplete: 'off',
        autocapitalize: 'characters',
        spellcheck: 'false',
        'aria-label': 'Code from your other device',
        placeholder: 'Code from your other device',
        value: state.linkDraft,
        oninput: (e) => {
          state.linkDraft = e.target.value;
        },
      }),
      h('button', { class: 'btn', type: 'submit' }, 'Use this code'),
    ),
  );
}

// ---- review: a finished game played back, every hand face up, with a note on each move

/**
 * The game at every move: frames[i] is how things stood when move i + 1 was
 * made, and the last frame is how it ended.
 */
function reviewFrames(record) {
  const sets = buildSets(record.deck);
  const hands = new Map(record.seats.map((seat) => [seat.id, new Set(record.deal[seat.id])]));
  const score = { A: 0, B: 0 };
  let turn = record.firstTurn;
  const snap = () => ({ hands: new Map([...hands].map(([id, hand]) => [id, sortCards([...hand])])), score: { ...score }, turn });
  const frames = [];
  for (const event of record.log) {
    frames.push(snap());
    if (event.type === 'ask' && event.success) {
      hands.get(event.target).delete(event.card);
      hands.get(event.asker).add(event.card);
    } else if (event.type === 'declare') {
      for (const card of sets.find((set) => set.id === event.set).cards) for (const hand of hands.values()) hand.delete(card);
      score[event.team] += 1;
    }
    turn = event.nextTurn;
  }
  frames.push(snap());
  return frames;
}

/**
 * What the player in `seatId` could be sure of when move `step` was about to be
 * made: `holder`, `lacks` and `active` as deduce() gives them, from that
 * player's own cards and the questions asked before it.
 */
function reviewKnowledge({ record, frames }, step, seatId) {
  const before = Math.max(0, step - 1); // the position shown at a step is the one its move was made in
  const log = record.log.slice(0, before);
  const claimed = new Map(log.filter((event) => event.type === 'declare').map((event) => [event.set, event.team]));
  const game = {
    seats: record.seats,
    sets: buildSets(record.deck).map((set) => ({ ...set, claimedBy: claimed.get(set.id) ?? null })),
    hands: new Map([...frames[before].hands].map(([id, cards]) => [id, new Set(cards)])),
    log,
  };
  return { ...deduce(game, seatId), claimed };
}

function reviewTo(step) {
  const moves = state.review?.record?.log.length ?? 0;
  state.reviewStep = Math.min(moves, Math.max(0, step));
  render();
}

/** What a move's note says: a short label, how it reads (good | bad | plain), and a sentence of detail. */
function reviewNote(name, event, note) {
  if (!note) return null;
  if (note.kind === 'sure') return { label: 'sure thing', tone: 'good', detail: [name(event.asker), ' could be certain ', name(event.target), ' held it.'] };
  // A card that was certain to be had for the asking, when the one asked for was not.
  const offer = note.sure?.length
    ? [' A sure card was there to take: ', note.sure.map(({ card, from }, i) => [i ? ', ' : null, cardChip(card), ' from ', name(from)]), '.']
    : null;
  if (note.kind === 'dead') {
    const why = note.holder ? [name(event.asker), ' could have known ', name(note.holder), ' held it.'] : [name(event.asker), ' could have known ', name(event.target), ' didn’t have it.'];
    return { label: 'couldn’t work', tone: 'bad', detail: [why, offer] };
  }
  if (note.kind === 'guess') {
    return { label: offer ? 'missed a sure card' : 'guess', tone: offer ? 'bad' : 'plain', detail: [`${offer ? 'A guess: it' : 'It'} could have been with any of ${note.places} players.`, offer] };
  }
  const all = note.known === note.of;
  const knew = `${note.known} of the ${note.of} cards`;
  if (event.correct) {
    return all
      ? { label: 'sure thing', tone: 'good', detail: [name(event.declarer), ' could place every card.'] }
      : { label: 'guess', tone: 'plain', detail: [name(event.declarer), ` could place ${knew}, and guessed the rest right.`] };
  }
  return { label: all ? 'slip' : 'guess', tone: 'bad', detail: [name(event.declarer), all ? ' could have placed every card.' : ` could place ${knew}.`] };
}

function reviewScreen() {
  const review = state.review;
  const shell = (...body) => h('div', { class: 'page' }, topbar(), h('main', { class: 'review' }, body));
  if (!review) return shell(h('p', { class: 'muted notice' }, 'Loading the game…'));
  if (review.missing) {
    return shell(h('div', { class: 'notice' }, h('p', {}, 'That game isn’t in the records.'), h('p', { class: 'muted' }, 'Games are kept from the moment they finish. ', h('a', { href: '/' }, 'Back to the lobby'))));
  }

  const { record, analysis, frames } = review;
  const moves = record.log.length;
  const step = Math.min(state.reviewStep, moves);
  const event = step ? record.log[step - 1] : null;
  const note = step ? analysis.moves[step - 1] : null;
  const frame = frames[Math.max(0, step - 1)];
  const sets = buildSets(record.deck);
  const seatOf = new Map(record.seats.map((seat) => [seat.id, seat]));
  const name = (id) => h('span', { class: `who team-${seatOf.get(id).team}` }, seatOf.get(id).name);
  const teamName = (team) => h('span', { class: `who team-${team}` }, TEAM_NAMES[team]);
  const setOf = (id) => sets.find((set) => set.id === id);
  const bySide = ['A', 'B'].flatMap((team) => record.seats.filter((seat) => seat.team === team));
  // Whose eyes the table is seen through: nobody's (every hand face up), or one player's.
  const viewer = seatOf.has(state.reviewSeat) ? state.reviewSeat : null;
  const known = viewer ? reviewKnowledge(review, step, viewer) : null;

  /** A move in a few words, as in the game's log. */
  const told = (e) => {
    if (e.type === 'ask') return [name(e.asker), ' asked ', name(e.target), ' for ', cardChip(e.card)];
    if (e.type === 'timeout') return [name(e.player), ' ran out of time'];
    const theirs = e.named !== seatOf.get(e.declarer).team;
    return [name(e.declarer), e.correct ? ' declared ' : ' misdeclared ', h('strong', {}, setOf(e.set).name), theirs ? [' from ', teamName(e.named), '’s hands'] : null];
  };

  // ---- the move being looked at
  const said = event ? reviewNote(name, event, note) : null;
  const good = event && (event.type === 'ask' ? event.success : event.type === 'declare' && event.correct);
  let story;
  if (!event) story = ['The cards are dealt. ', name(frame.turn), ' plays first.'];
  else if (event.type === 'ask') story = [told(event), event.success ? ' and got it.' : [', but ', name(event.target), ' didn’t have it.']];
  else if (event.type === 'timeout') story = [told(event), ' and lost the turn to ', name(event.nextTurn), '.'];
  else story = [told(event), event.correct ? '. A set for ' : '. The set went to ', teamName(event.team), '.'];
  const moveBox = h(
    'section',
    { class: cls('panel review-move', event && (good ? 'good' : 'bad')), 'aria-live': 'polite' },
    h('p', { class: 'banner-text' }, story),
    event?.type === 'declare' && !event.correct
      ? h(
          'div',
          { class: 'reveal' },
          setOf(event.set)
            .cards.filter((card) => event.actual[card] !== event.assignment[card])
            .map((card) => h('span', { class: 'reveal-item wrong' }, cardChip(card), ' ', name(event.actual[card]), h('span', { class: 'muted' }, ' (said ', name(event.assignment[card]), ')'))),
        )
      : null,
    said ? h('p', { class: 'review-note' }, h('span', { class: `tag ${said.tone}` }, said.label), ' ', said.detail) : null,
  );

  // ---- everyone's cards at that moment
  const marked = new Map(); // card -> how to mark it: the card asked for, or the cards of the set being declared
  if (event?.type === 'ask') marked.set(event.card, 'hot');
  if (event?.type === 'declare') for (const card of setOf(event.set).cards) marked.set(card, event.actual[card] === event.assignment[card] ? 'hot' : 'hot wrong');
  const part = (id) => {
    if (!event) return id === frame.turn ? 'plays first' : null;
    if (event.type === 'ask') return id === event.asker ? 'asks' : id === event.target ? 'is asked' : null;
    if (event.type === 'declare') return id === event.declarer ? 'declares' : null;
    return id === event.player ? 'out of time' : null;
  };
  const seatRow = (seat) => {
    const cards = frame.hands.get(seat.id);
    // From one player's seat, a hand is the cards they could place in it. The rest
    // are a number, unless the real cards have been asked for: then they are shown faintly.
    const placed = (card) => !known || known.holder.get(card) === seat.id;
    const shown = state.reviewTruth ? cards : cards.filter(placed);
    const unknown = cards.length - shown.length;
    const runs = sets.map((set) => shown.filter((card) => set.cards.includes(card))).filter((run) => run.length);
    return h(
      'div',
      { class: cls('review-seat', `team-${seat.team}`, part(seat.id) && 'acting', seat.id === viewer && 'self') },
      h(
        'div',
        { class: 'review-who' },
        h('span', { class: 'nm', title: seat.name }, seat.name),
        seat.bot ? tag('bot') : null,
        part(seat.id) ? h('span', { class: 'turn-pill' }, part(seat.id)) : null,
      ),
      h(
        'div',
        { class: 'review-cards' },
        cards.length === 0 ? h('span', { class: 'muted small' }, 'no cards') : null,
        runs.map((run) =>
          h(
            'span',
            { class: 'set-run' },
            run.map((card) => {
              const chip = cardChip(card);
              if (marked.has(card)) chip.className += ` ${marked.get(card)}`;
              if (!placed(card)) chip.className += ' unplaced';
              return chip;
            }),
          ),
        ),
        unknown ? h('span', { class: 'muted small' }, shown.length ? `and ${unknown} unknown` : `${unknown} unknown`) : null,
      ),
      h('span', { class: 'review-count muted small' }, cards.length),
    );
  };

  // ---- one player's view: for every card still in play, who has it, who can't, and who might
  const seenBy = (id, label, team) =>
    h(
      'button',
      {
        class: cls('pill', team && `team-${team}`),
        'aria-pressed': String(viewer === id),
        onclick: () => {
          state.reviewSeat = id;
          render();
        },
      },
      label,
    );
  const picker = h(
    'div',
    { class: 'review-seen', role: 'group', 'aria-label': 'Whose view of the game' },
    h('span', { class: 'step-label' }, 'Seen by'),
    seenBy(null, 'Everyone'),
    bySide.map((seat) => seenBy(seat.id, seat.name, seat.team)),
  );
  // A column is narrow, so a joker is headed "Jo" there.
  const columnChip = (card) => {
    const info = cardInfo(card);
    return h('span', { class: `chip suit-${info.tint}`, role: 'img', 'aria-label': info.name, title: info.name }, info.joker ? 'Jo' : info.rank, pip(info.suit));
  };
  const knowSet = (set) => {
    const won = known.claimed.get(set.id);
    const cell = (seat, card) => {
      const holds = frame.hands.get(seat.id);
      const sure = known.holder.get(card);
      const status = sure === seat.id ? 'has' : sure !== undefined || holds.length === 0 || known.lacks.get(card)?.has(seat.id) ? 'no' : 'maybe';
      const words = { has: 'has', no: 'can’t have', maybe: 'might have' }[status];
      const real = state.reviewTruth && status === 'maybe' && holds.includes(card);
      const asked = event?.type === 'ask' && event.card === card && event.target === seat.id;
      return h(
        'td',
        { class: cls(asked && 'hot'), title: `${seat.name} ${words} the ${cardInfo(card).name}${real ? ', and did' : ''}` },
        h('span', { class: cls('know', status, status === 'no' && 'icon icon-cross', real && 'real') }),
        h('span', { class: 'sr-only' }, words, real ? ' (really had it)' : null),
      );
    };
    const row = (seat) => {
      // Asking for a card of a set shows you hold one of it, for as long as none is taken from you.
      const some = seat.id !== viewer && known.active.get(seat.id)?.has(set.id) && !set.cards.some((card) => known.holder.get(card) === seat.id);
      return h(
        'tr',
        { class: cls(`team-${seat.team}`, seat.id === viewer && 'self', frame.hands.get(seat.id).length === 0 && 'out') },
        h(
          'th',
          { scope: 'row' },
          h('span', { class: 'know-who' }, h('span', { class: 'nm', title: seat.name }, seat.name), some ? h('span', { class: 'know-some', title: `${seat.name} has asked for a card of this set, so holds at least one of them` }, '1+') : null),
        ),
        set.cards.map((card) => cell(seat, card)),
      );
    };
    return h(
      'table',
      { class: cls('know-set', won && 'won', event?.type === 'declare' && event.set === set.id && 'hot') },
      h('caption', {}, set.suit ? pip(set.suit, { tinted: true }) : null, ' ', set.name, won ? h('span', { class: 'muted' }, ` · won by ${TEAM_NAMES[won]}`) : null),
      h('thead', {}, h('tr', {}, h('th', {}), set.cards.map((card) => h('th', { scope: 'col', class: cls(event?.type === 'ask' && event.card === card && 'hot') }, columnChip(card))))),
      won ? null : h('tbody', {}, bySide.map(row)),
    );
  };
  const knowledge = known
    ? h(
        'section',
        { class: 'panel review-know', style: `--n: ${sets[0].cards.length}`, 'aria-label': `What ${seatOf.get(viewer).name} could know` },
        h(
          'div',
          { class: 'know-head' },
          h('h2', {}, 'What ', name(viewer), ' could know'),
          h(
            'label',
            { class: 'know-truth' },
            h('input', {
              type: 'checkbox',
              checked: state.reviewTruth,
              onchange: (e) => {
                state.reviewTruth = e.target.checked;
                render();
              },
            }),
            'Show where the cards really were',
          ),
        ),
        h('div', { class: 'know-sets' }, sets.map(knowSet)),
        h(
          'p',
          { class: 'know-key muted small' },
          h('span', {}, h('span', { class: 'know has' }), ' has it'),
          h('span', {}, h('span', { class: 'know no icon icon-cross' }), ' can’t have it'),
          h('span', {}, h('span', { class: 'know maybe' }), ' might have it'),
          h('span', {}, h('span', { class: 'know-some' }, '1+'), ' holds at least one card of the set'),
          state.reviewTruth ? h('span', {}, h('span', { class: 'know maybe real' }), ' really had it') : null,
        ),
        h('p', { class: 'muted small' }, 'Worked out from their own cards and the questions asked before this move. It follows who was asked for what; it does not count cards.'),
      )
    : null;

  const table = h(
    'section',
    { class: 'panel review-table', 'aria-label': viewer ? `The table as ${seatOf.get(viewer).name} saw it` : 'Every hand at this move' },
    ['A', 'B'].map((team) =>
      h(
        'div',
        { class: `review-team team-${team}` },
        h('h2', {}, h('span', { class: 'team-dot' }), TEAM_NAMES[team], h('span', { class: 'review-score' }, frame.score[team]), h('span', { class: 'muted small' }, frame.score[team] === 1 ? 'set' : 'sets')),
        record.seats.filter((seat) => seat.team === team).map(seatRow),
      ),
    ),
  );

  // ---- stepping through
  const stepBtn = (label, to, { primary = false, key = null } = {}) =>
    h('button', { class: cls('btn', primary && 'primary'), disabled: to < 0 || to > moves || to === step, onclick: () => reviewTo(to) }, label, key ? h('span', { class: 'key-hint', 'aria-hidden': 'true' }, key) : null);
  const stepper = h(
    'div',
    { class: 'review-stepper' },
    stepBtn('First', 0),
    stepBtn('Back', step - 1, { key: '←' }),
    stepBtn('Next', step + 1, { primary: true, key: '→' }),
    stepBtn('Last', moves),
    h('span', { class: 'review-at' }, step ? `Move ${step} of ${moves}` : `The deal · ${moves} moves`),
    h('input', { type: 'range', class: 'review-range', min: 0, max: moves, value: step, 'aria-label': 'Move', oninput: (e) => reviewTo(Number(e.target.value)) }),
  );

  // ---- the whole game as a list
  const row = (e, i) => {
    const ok = e.type === 'ask' ? e.success : e.type === 'declare' && e.correct;
    const about = reviewNote(name, e, analysis.moves[i]);
    return h(
      'li',
      { class: cls(ok ? 'good' : 'bad', e.type === 'declare' && 'declared', step === i + 1 && 'current'), onclick: () => reviewTo(i + 1) },
      h('span', { class: 'num' }, i + 1),
      icon(e.type === 'declare' && e.correct ? 'star' : ok ? 'check' : 'cross'),
      h('span', { class: 'what' }, told(e)),
      about && about.tone !== 'plain' ? h('span', { class: `tag ${about.tone}` }, about.label) : null,
    );
  };
  const list = h(
    'aside',
    { class: 'panel review-moves' },
    h('h2', {}, 'Moves'),
    h('ol', { class: 'log-list review-list' }, h('li', { class: cls('deal', step === 0 && 'current'), onclick: () => reviewTo(0) }, h('span', { class: 'num' }), h('span', { class: 'what' }, 'The deal')), record.log.map(row)),
  );

  // ---- the game in numbers
  const anyTimeouts = record.seats.some((seat) => analysis.players[seat.id].timeouts);
  const columns = [
    ['Questions', 'Questions asked'],
    ['Got the card', 'Questions that won the card'],
    ['Sure things', 'Questions where they could be certain the card was there'],
    ['Couldn’t work', 'Questions where they could have known the card was not there'],
    ['Cards lost', 'Cards other players took from them'],
    ['Declared', 'Sets declared correctly'],
    ['Misdeclared', 'Sets declared wrongly, which went to the other team'],
    ...(anyTimeouts ? [['Out of time', 'Turns lost on the clock']] : []),
  ];
  const totals = h(
    'section',
    { class: 'panel history review-totals' },
    h('h2', {}, 'The game in numbers'),
    h(
      'div',
      { class: 'table-scroll' },
      h(
        'table',
        { class: 'games' },
        h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Player'), columns.map(([label, title]) => h('th', { scope: 'col', title }, label)))),
        h(
          'tbody',
          {},
          ['A', 'B'].flatMap((team) =>
            record.seats
              .filter((seat) => seat.team === team)
              .map((seat) => {
                const t = analysis.players[seat.id];
                const share = t.asks ? ` (${Math.round((100 * t.hits) / t.asks)}%)` : '';
                const cells = [t.asks, `${t.hits}${share}`, t.sure, t.dead, t.lost, t.declared, t.misdeclared, ...(anyTimeouts ? [t.timeouts] : [])];
                return h('tr', {}, h('td', {}, name(seat.id), seat.bot ? tag('bot') : null), cells.map((value) => h('td', { class: cls(value === 0 && 'muted') }, value)));
              }),
          ),
        ),
      ),
    ),
    h('p', { class: 'muted small' }, 'A sure thing is a question whose answer the asker could already work out from their own cards and the questions before it. One that couldn’t work is a question they could have known would fail.'),
  );

  const { winner, score } = record;
  const when = new Date(record.endedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  const minutes = Math.max(1, Math.round((record.endedAt - record.startedAt) / 60_000));
  return shell(
    h(
      'header',
      { class: 'review-head' },
      h('h1', {}, teamName(winner), ` won ${score[winner]}–${score[other(winner)]}`),
      h('p', { class: 'muted' }, [deckName(record.deck), when, `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`, record.rated ? 'rated' : 'practice'].join(' · ')),
    ),
    h('div', { class: 'review-body' }, h('div', { class: 'review-main' }, stepper, moveBox, picker, table, knowledge), list),
    totals,
  );
}

// ---- help: the rules, for when someone wants them

function helpScreen() {
  const section = (title, ...body) => h('section', {}, h('h2', {}, title), body);
  const p = (...text) => h('p', {}, text);
  const b = (text) => h('strong', {}, text);
  return h(
    'div',
    { class: 'page' },
    topbar(),
    h(
      'main',
      { class: 'help' },
      h('h1', {}, 'How to play Fish'),
      p('Fish, also called Literature, is a card game for two teams of two, three or four. The whole game is working out who holds which cards. The team that collects more sets wins.'),
      section(
        'Sets',
        p('The deck is split into nine ', b('sets'), '. Each suit gives two: its ', b('low'), ' cards and its ', b('high'), ' cards. The four 8s and the jokers make the ninth.'),
        h(
          'ul',
          {},
          h('li', {}, b('Sets of six'), ' (54 cards): low is 2–7, high is 9–A, and the 8s go with two jokers.'),
          h('li', {}, b('Sets of eight'), ' (72 cards): every suit also has a 0, 1, 11 and 12, so low is 0–7 and high is 9–A. The 8s go with four jokers, one in each suit.'),
        ),
        p('Spades are black, hearts red, diamonds blue and clubs green. In your hand, each set is laid out in full: the cards you hold are solid, and the ones you are missing are faint outlines.'),
      ),
      section(
        'Your turn: ask for a card',
        p('On your turn, ask ', b('one opponent'), ' for ', b('one exact card'), '. Two conditions: you must already hold a card from the same set, and you can’t ask for a card you hold yourself.'),
        p('If they have it, they hand it over and you go again. If they don’t, the turn passes to them. Everyone sees every question and its answer, so each one tells the whole table something.'),
        p('To ask, tap a faint card in your hand, pick the opponent, and press Ask.'),
      ),
      section(
        'Declaring a set',
        p('When you know where every card of a set is, ', b('declare'), ' it: name the set and say who holds each of its cards. The players you name must all be on one team: either your team holds the whole set, or the other team does.'),
        h(
          'ul',
          {},
          h('li', {}, 'Every card right: your team wins the set, even if it was all in the other team’s hands.'),
          h('li', {}, 'Any card wrong: the other team wins it. A set split between the two teams can’t be declared correctly, so ask for the missing cards first.'),
        ),
        p('You can declare whenever your team has the turn, even when it is a teammate’s turn and not yours. The set then leaves the game and its cards are shown. Teammates may not tell each other what they hold, so declaring is done from what you have seen asked and answered.'),
      ),
      section(
        'Running out of cards',
        p('A player with no cards can’t be asked. If the turn falls to them it passes to the next teammate who has cards. When one whole team is out of cards, the other team has to declare everything that is left.'),
        p('The game ends when all nine sets are won. Nine is odd, so there is always a winner.'),
      ),
      section(
        'The clock',
        p('If the host has set a time limit, each move has that long. Take longer and your ', b('time bank'), ' starts to run down: extra time that has to last you the whole game. It does not refill.'),
        p('When your move time and your time bank are both gone, you lose the turn. It passes to the next opponent round the table who has cards, as if you had asked and missed. Bots are not timed.'),
      ),
      section(
        'House rules',
        p('The host chooses these before the game starts.'),
        h(
          'ul',
          {},
          h('li', {}, b('Deck'), ': sets of six or sets of eight, as above.'),
          h('li', {}, b('Declaring'), ': whenever your team has the turn, only on your own turn, or at any time by anyone.'),
          h('li', {}, b('Bot moves'), ': one at a time, with a bot waiting until a player presses Next (or Space); or automatically after a short pause.'),
          h('li', {}, b('Question history'), ': a full log everyone can scroll back through, or only the last question, as at a real table.'),
          h('li', {}, b('Clock'), ': the time for each move (10 seconds to 5 minutes, or no limit) and each player’s time bank (up to 10 minutes, or none).'),
        ),
      ),
      section(
        'Games, bots and seats',
        p('A public game is listed in the lobby for anyone to join. A private game is reached only by its link or four-letter code. Teams need the same number of players, and bots can fill empty seats.'),
        p('If you lose your connection or close the tab, your seat is kept: opening the game again from the same browser puts you back in it. If someone has gone for good, the host can let a bot play their cards, or a spectator can take the seat over.'),
        p('Every game has a ', b('chat'), ' of its own, for the people in it: beside the teams before the game, and on a tab next to the game log once it starts.'),
        p('A short ', b('tone'), ' plays when the turn comes to you, and another when your clock is nearly out. The speaker button in the top bar switches them off.'),
      ),
      section(
        'Ratings',
        p('Everyone has an Elo rating that starts at 1000. Every game you play is ', b('rated'), ', against people or bots, unless the same player is sitting in two seats.'),
        p('A team is rated as the average of its players. Winners take points from losers: 16 between evenly matched teams, more for beating a stronger team, fewer for beating a weaker one.'),
        p('The bots have a rating too. They all play the same way, so they share one: it goes up when they win and down when they lose, and it is what each bot counts as in its team’s average. Bots on both teams cancel out.'),
        p('Your rating and your games belong to the browser you play in. To play as yourself on ', b('another device'), ', get a code on your profile page and type it in on the other device’s profile page.'),
      ),
      section(
        'Looking back at a game',
        p('When a game ends, ', b('Review the game'), ' shows it from the deal: every hand, face up, at every move. Step through with the buttons or the arrow keys. Your profile lists every game you have finished, each with its review.'),
        p('Each move has a note on what its player could have known at the time, from their own cards and the questions asked so far: a ', b('sure thing'), ' when the card was certain to be there, ', b('couldn’t work'), ' when it was known to be elsewhere, and a ', b('guess'), ' otherwise.'),
        p('Under ', b('Seen by'), ', pick a player to see the game from their seat: only the cards they could place, and for every set a grid of who has each card, who can’t have it and who might. Tick the box above the grid to see where the cards they couldn’t place really were.'),
      ),
    ),
  );
}

// ---- setting up a game: teams, house rules, and the invitation

function memberTags(m, { host = true } = {}) {
  const v = state.view;
  return [
    m.id === v.you && tag('you'),
    host && m.id === v.hostId && tag('host'),
    m.bot && tag('bot'),
    !m.bot && !m.online && tag('offline', 'warn'),
    m.auto && tag('bot playing'),
  ];
}

/** The clock's settings in a sentence. */
function clockSummary({ moveTime, timeBank }) {
  if (!moveTime) return 'No time limit';
  return `${duration(moveTime)} a move, ${timeBank ? `with a time bank of ${duration(timeBank)}` : 'and no time bank'}`;
}

function setupScreen() {
  const v = state.view;
  const isHost = v.hostId === v.you;
  const me = v.members.find((m) => m.id === v.you);
  const teams = { A: v.members.filter((m) => m.team === 'A'), B: v.members.filter((m) => m.team === 'B') };
  const watchers = v.members.filter((m) => !m.team);
  const sizes = [teams.A.length, teams.B.length];
  const ready = sizes[0] === sizes[1] && sizes[0] >= 2;
  const problem =
    sizes[0] !== sizes[1]
      ? `Teams must be even. It’s ${sizes[0]} against ${sizes[1]} right now.`
      : sizes[0] < 2
        ? 'Each team needs at least two players. Invite friends or add bots.'
        : null;

  const teamColumn = (team) => {
    const full = teams[team].length >= 4;
    return h(
      'section',
      { class: `panel team-col team-${team}` },
      h('h2', {}, h('span', { class: 'team-dot' }), TEAM_NAMES[team], h('span', { class: 'muted count' }, `${teams[team].length}/4`)),
      h(
        'ul',
        { class: 'roster' },
        teams[team].map((m) =>
          h(
            'li',
            {},
            h('span', { class: 'nm' }, m.name),
            memberTags(m),
            m.rating == null ? null : h('span', { class: 'rating', title: 'Elo rating' }, m.rating),
            isHost && m.id !== v.you
              ? h('button', { class: 'icon-btn', title: `Remove ${m.name}`, 'aria-label': `Remove ${m.name}`, onclick: () => send({ t: 'kick', id: m.id }) }, icon('cross'))
              : null,
          ),
        ),
        teams[team].length === 0 ? h('li', { class: 'muted empty' }, 'Nobody yet') : null,
      ),
      h(
        'div',
        { class: 'team-actions' },
        me.team !== team ? h('button', { class: 'btn', disabled: full, onclick: () => send({ t: 'team', team }) }, `Join ${TEAM_NAMES[team]}`) : null,
        isHost ? h('button', { class: 'btn quiet', disabled: full, onclick: () => send({ t: 'addBot', team }) }, '+ Add a bot') : null,
      ),
    );
  };

  const settings = h(
    'section',
    { class: 'panel settings' },
    h('h2', {}, 'House rules', isHost ? null : h('span', { class: 'muted small' }, ' set by the host')),
    SETTINGS.map(({ key, label, options }) =>
      h(
        'fieldset',
        {},
        h('legend', {}, label),
        // Guests see just the rule in force, not every option greyed out.
        options
          .filter(([value]) => isHost || v.settings[key] === value)
          .map(([value, title, detail]) =>
            h(
              'label',
              { class: cls('option', v.settings[key] === value && 'on', !isHost && 'locked') },
              h('input', {
                type: 'radio',
                name: key,
                checked: v.settings[key] === value,
                disabled: !isHost,
                onchange: () => send({ t: 'settings', settings: { [key]: value } }),
              }),
              h('span', {}, h('strong', {}, title), h('span', { class: 'muted small' }, detail)),
            ),
          ),
      ),
    ),
    h(
      'fieldset',
      { class: 'clock-rules' },
      h('legend', {}, 'Clock'),
      isHost
        ? h(
            'div',
            { class: 'clock-fields' },
            CLOCK_SETTINGS.map(({ key, label, none, values }) =>
              h(
                'label',
                { class: 'select-field' },
                h('span', {}, label),
                h(
                  'select',
                  {
                    // A time bank is extra time on top of a limit, so it means nothing without one.
                    disabled: key === 'timeBank' && v.settings.moveTime === 0,
                    onchange: (event) => send({ t: 'settings', settings: { [key]: Number(event.target.value) } }),
                  },
                  values.map((n) => h('option', { value: n, selected: v.settings[key] === n }, n ? duration(n) : none)),
                ),
              ),
            ),
          )
        : h('p', { class: 'clock-summary' }, clockSummary(v.settings)),
      h(
        'p',
        { class: 'muted small' },
        'Each move has this long. After that your time bank runs down: extra time that has to last you the whole game. When both are gone, you lose the turn. Bots aren’t timed.',
      ),
    ),
  );

  return h(
    'div',
    { class: 'page' },
    topbar(),
    h(
      'main',
      { class: 'setup' },
      h(
        'section',
        { class: 'invite' },
        h('h1', {}, 'Waiting for players'),
        h(
          'p',
          { class: 'muted' },
          v.public ? 'This game is listed in the lobby. You can also send friends this link, or tell them the code ' : 'This is a private game: only people with this link, or the code ',
          h('strong', { class: 'code' }, v.code),
          v.public ? '.' : ', can join.',
        ),
        h(
          'div',
          { class: 'invite-row' },
          h('input', { type: 'text', readonly: true, 'aria-label': 'Invite link', value: `${location.origin}/${v.code}`, onfocus: (e) => e.target.select() }),
          h('button', { class: 'btn', onclick: copyLink }, 'Copy link'),
        ),
      ),
      h('div', { class: 'teams' }, teamColumn('A'), h('div', { class: 'versus' }, 'vs'), teamColumn('B')),
      h(
        'p',
        { class: 'watchers muted' },
        watchers.length ? ['Watching: ', watchers.map((m) => m.name + (m.id === v.you ? ' (you)' : '')).join(', '), '. '] : null,
        me.team ? h('button', { class: 'link', onclick: () => send({ t: 'team', team: null }) }, 'Just watch instead') : 'Pick a team to play.',
      ),
      h('section', { class: 'panel chat room-chat' }, h('h2', {}, 'Chat'), chatBox(state.roomChat)),
      settings,
      h(
        'section',
        { class: 'start' },
        isHost
          ? [
              h('button', { class: 'btn', disabled: sizes[0] + sizes[1] < 2, onclick: () => send({ t: 'shuffle' }) }, 'Shuffle teams'),
              h('button', { class: 'btn primary big', disabled: !ready, onclick: () => send({ t: 'start' }) }, 'Start game'),
            ]
          : h('p', { class: 'muted' }, ready ? 'Waiting for the host to start the game…' : null),
        problem ? h('p', { class: 'muted small start-note' }, problem) : null,
        h('p', { class: 'muted small start-note' }, ratedNote(v.unrated)),
      ),
    ),
  );
}

/** One line on whether the game counts for Elo, and if not, why. */
function ratedNote(unrated) {
  if (unrated === 'no-humans') return 'Practice game: nobody playing has a rating to play for.';
  if (unrated === 'same-player') return 'Practice game: the same player is in more than one seat, so ratings won’t change.';
  return 'Rated game: the result will change the players’ Elo ratings.';
}

// ---- game

/** Everything the game screen's pieces need, worked out once per render. */
function gameContext() {
  const v = state.view;
  const g = v.game;
  const byId = new Map(v.members.map((m) => [m.id, m]));
  const me = byId.get(v.you);
  const seated = g.seats.includes(v.you);
  const myTeam = seated ? me.team : null;
  const hand = new Set(g.hand);
  const claimed = new Map(g.sets.map((s) => [s.id, s.claimedBy]));
  const sets = buildSets(g.deck).map((s) => ({ ...s, claimedBy: claimed.get(s.id), held: s.cards.filter((c) => hand.has(c)).length }));
  const seats = g.seats.map((id) => byId.get(id));
  const myTurn = seated && g.turn === v.you;
  const foes = seats.filter((m) => m.team !== myTeam);
  const canAsk = myTurn && foes.some((m) => m.cards > 0) && sets.some((s) => !s.claimedBy && s.held > 0 && s.held < s.cards.length);
  const isHost = v.hostId === v.you;
  const canDeclare = seated && Boolean(g.canDeclare);
  const canStep = v.phase === 'playing' && g.awaitingNext && (seated || isHost);
  return { v, g, byId, me, seated, myTeam, hand, sets, setSize: sets[0].cards.length, seats, myTurn, foes, canAsk, canDeclare, canStep, isHost };
}

/** A player's name in their team colour; "you" for the viewer. */
function who(c, id, { capital = false } = {}) {
  const m = c.byId.get(id);
  if (!m) return 'someone';
  const text = id === c.v.you ? (capital ? 'You' : 'you') : m.name;
  return h('span', { class: `who team-${m.team}` }, text);
}

/** " from Purple’s hands": added to the story of a declaration that named the other team's players. */
function fromOtherTeam(c, event) {
  if (!event.named || event.named === c.byId.get(event.declarer)?.team) return null;
  return [' from ', h('span', { class: `who team-${event.named}` }, TEAM_NAMES[event.named]), '’s hands'];
}

function gameScreen() {
  const c = gameContext();
  return h(
    'div',
    { class: 'page game-page' },
    topbar(),
    h(
      'div',
      { class: 'game' },
      // The table: the score, the players, the latest move and your cards.
      h('main', { class: 'game-main' }, scoreboard(c), playersPanel(c), banner(c), c.g.winner ? resultPanel(c) : null, c.seated && !c.g.winner ? handPanel(c) : null),
      // Beside it on a wide screen: your move, and everything that has happened.
      h('aside', { class: 'game-side' }, c.g.winner ? null : actionPanel(c), logPanel(c)),
    ),
  );
}

function scoreboard(c) {
  const side = (team) =>
    h(
      'div',
      { class: `score-side team-${team}` },
      h('span', { class: 'score-name' }, TEAM_NAMES[team], c.myTeam === team ? tag('your team') : null),
      h('span', { class: 'score-num' }, c.g.score[team]),
    );
  // One marker per suit with a low half and a high half, then the eights.
  const segment = (set, label) =>
    h(
      'span',
      { class: cls('seg', set.claimedBy && `claimed team-${set.claimedBy}`), title: `${set.name}: ${set.claimedBy ? `won by ${TEAM_NAMES[set.claimedBy]}` : 'still in play'}` },
      label,
    );
  const bySuit = [];
  for (const set of c.sets) {
    if (set.suit && bySuit.at(-1)?.[0].suit === set.suit) bySuit.at(-1).push(set);
    else bySuit.push([set]);
  }
  return h(
    'section',
    { class: 'scoreboard panel', 'aria-label': 'Score' },
    side('A'),
    h(
      'div',
      { class: 'set-strip' },
      bySuit.map((group) => h('span', { class: 'set-group' }, group[0].suit ? pip(group[0].suit, { tinted: true }) : null, group.map((s) => segment(s, s.suit ? s.kind : '8s & jokers')))),
    ),
    side('B'),
  );
}

function playersPanel(c) {
  const groups = c.myTeam
    ? [['Opponents', other(c.myTeam)], ['Your team', c.myTeam]]
    : [[TEAM_NAMES.A, 'A'], [TEAM_NAMES.B, 'B']];
  return h(
    'section',
    { class: 'players', 'aria-label': 'Players' },
    groups.map(([title, team]) =>
      h(
        'div',
        { class: `player-group team-${team}` },
        h('h2', {}, h('span', { class: 'team-dot' }), title),
        h('div', { class: 'seat-row', style: `--seats: ${c.seats.length / 2}` }, c.seats.filter((m) => m.team === team).map((m) => seat(c, m))),
      ),
    ),
  );
}

function seat(c, m) {
  const turn = c.g.turn === m.id;
  const timed = c.g.clock?.player === m.id;
  const away = !m.bot && !m.online;
  const playing = c.v.phase === 'playing';
  return h(
    'div',
    { class: cls('seat', `team-${m.team}`, turn && 'turn', m.cards === 0 && 'out', away && 'away') },
    h(
      'div',
      { class: 'seat-main' },
      h('span', { class: 'nm', title: m.name }, m.name),
      // Always there, so a seat keeps its height when the turn arrives.
      h(
        'div',
        { class: 'seat-tags' },
        memberTags(m, { host: false }),
        // On the clock, the countdown says "to play" by itself.
        turn ? h('span', { class: 'turn-pill' }, timed ? clockEl({ brief: true }) : 'to play') : null,
        m.bank != null && !timed ? h('span', { class: 'bank-tag', title: 'Time bank: extra time left for the rest of the game' }, `+${mmss(m.bank)}`) : null,
      ),
      playing && away && c.isHost
        ? h('button', { class: 'btn tiny', onclick: () => send({ t: 'botControl', id: m.id, on: !m.auto }) }, m.auto ? 'Stop the bot' : 'Let a bot play')
        : null,
      playing && away && !c.seated ? h('button', { class: 'btn tiny', onclick: () => send({ t: 'claimSeat', id: m.id }) }, 'Take this seat') : null,
    ),
    // The number of cards held, shown on the back of a card.
    h('span', { class: 'held', title: `${m.cards} ${m.cards === 1 ? 'card' : 'cards'}` }, m.cards, h('span', { class: 'sr-only' }, m.cards === 1 ? ' card' : ' cards')),
  );
}

function banner(c) {
  const g = c.g;
  const last = g.log.at(-1);
  const next = g.turn ? h('span', { class: 'next' }, g.turn === c.v.you ? 'Your turn.' : [who(c, g.turn, { capital: true }), ' to play.']) : null;

  let tone = null;
  let body;
  if (!last) {
    body = h('p', { class: 'banner-text' }, 'The cards are dealt. ', next);
  } else if (last.type === 'ask') {
    tone = last.success ? 'good' : 'bad';
    body = h(
      'p',
      { class: 'banner-text' },
      who(c, last.asker, { capital: true }),
      ' asked ',
      who(c, last.target),
      ' for the ',
      cardChip(last.card),
      last.success ? ' and got it. ' : [', but ', who(c, last.target), last.target === c.v.you ? ' don’t' : ' doesn’t', ' have it. '],
      next,
    );
  } else if (last.type === 'timeout') {
    tone = 'bad';
    body = h('p', { class: 'banner-text' }, who(c, last.player, { capital: true }), ' ran out of time and ', last.player === c.v.you ? 'lose' : 'loses', ' the turn. ', next);
  } else {
    const set = c.sets.find((s) => s.id === last.set);
    tone = last.correct ? 'good' : 'bad';
    body = [
      h(
        'p',
        { class: 'banner-text' },
        who(c, last.declarer, { capital: true }),
        last.correct ? ' declared ' : ' misdeclared ',
        h('strong', {}, set.name),
        fromOtherTeam(c, last),
        last.correct ? '. A set for ' : '. The set goes to ',
        h('span', { class: `who team-${last.team}` }, TEAM_NAMES[last.team]),
        '. ',
        next,
      ),
      h(
        'div',
        { class: 'reveal' },
        set.cards.map((card) => {
          const wrong = last.actual[card] !== last.assignment[card];
          return h(
            'span',
            { class: cls('reveal-item', wrong && 'wrong') },
            cardChip(card),
            ' ',
            who(c, last.actual[card]),
            wrong ? h('span', { class: 'muted' }, ' (said ', who(c, last.assignment[card]), ')') : null,
          );
        }),
      ),
    ];
  }

  // When a bot is waiting, the Next button sits right beside what just happened:
  // read it, press, read the next one. It stays in the same place from move to move.
  return h(
    'section',
    { class: cls('banner panel', tone, c.canStep && 'stepping'), 'aria-live': 'polite' },
    h('div', { class: 'banner-body' }, body),
    clockEl(),
    c.canStep
      ? h('button', { class: 'btn primary next-btn', disabled: state.busy, title: 'Let the bot make its move', onclick: stepBot }, 'Next', h('span', { class: 'key-hint', 'aria-hidden': 'true' }, 'space'))
      : null,
  );
}

function resultPanel(c) {
  const { winner, score } = c.g;
  const line = winner === 'tie' ? `It’s a tie, ${score.A}–${score.B}.` : `${TEAM_NAMES[winner]} wins ${score[winner]}–${score[other(winner)]}.`;
  const mine = !c.myTeam || winner === 'tie' ? null : winner === c.myTeam ? 'Your team won!' : 'Your team lost this one.';
  return h(
    'section',
    { class: cls('panel result', winner !== 'tie' && `team-${winner}`) },
    h('h2', {}, line),
    mine ? h('p', {}, mine) : null,
    c.g.ratingChanges?.length
      ? h(
          'ul',
          { class: 'changes', 'aria-label': 'Rating changes' },
          c.g.ratingChanges.map((change) =>
            h(
              'li',
              { class: cls(change.team ? `team-${change.team}` : 'no-team', change.you && 'you') },
              h('span', { class: 'who nm' }, change.name),
              change.bot ? h('span', { class: 'tag', title: 'Every bot plays the same way, so they share one rating' }, 'all bots') : null,
              h('span', { class: cls('delta', change.delta > 0 ? 'up' : 'down') }, change.delta > 0 ? `+${change.delta}` : `−${-change.delta}`),
              h('span', { class: 'after', title: 'New Elo rating' }, change.after),
            ),
          ),
        )
      : null,
    c.v.unrated ? h('p', { class: 'muted small' }, 'Practice game: ratings are unchanged.') : null,
    h(
      'div',
      { class: 'result-actions' },
      c.isHost ? h('button', { class: 'btn primary big', onclick: () => send({ t: 'start' }) }, 'Play again') : null,
      // In a new tab, so the room stays open behind it.
      c.g.reviewId ? h('a', { class: 'btn big', href: `/game/${c.g.reviewId}`, target: '_blank', rel: 'noopener', title: 'Every hand and every move, with notes' }, 'Review the game') : null,
      c.isHost ? h('button', { class: 'btn', onclick: () => send({ t: 'toLobby' }) }, 'Back to lobby') : null,
    ),
    c.isHost ? null : h('p', { class: 'muted' }, 'Waiting for the host to start another game…'),
  );
}

function actionPanel(c) {
  if (!c.seated) {
    const free = c.seats.some((m) => !m.bot && !m.online);
    return h(
      'section',
      { class: 'panel action' },
      h('p', { class: 'muted' }, 'You’re watching this game. ', free ? 'A player is offline: you can take over their seat above.' : 'You can pick a team when it’s over.'),
    );
  }

  if (!c.myTurn) {
    const waiting = c.g.awaitingNext
      ? h('p', { class: 'waiting' }, who(c, c.g.turn, { capital: true }), ' is a bot, and moves when a player presses Next.')
      : h('p', { class: 'waiting' }, 'Waiting for ', who(c, c.g.turn), '…');
    if (!c.canDeclare) return h('section', { class: 'panel action' }, waiting);
    return h(
      'section',
      { class: 'panel action' },
      h(
        'div',
        { class: 'action-head' },
        waiting,
        h(
          'button',
          {
            class: 'btn',
            onclick: () => {
              state.declOpen = !state.declOpen;
              render();
            },
          },
          state.declOpen ? 'Cancel' : 'Declare a set',
        ),
      ),
      state.declOpen ? declareForm(c) : null,
    );
  }

  const tab = c.canAsk ? state.tab : 'declare';
  const tabButton = (id, label, disabled) =>
    h(
      'button',
      {
        class: 'tab',
        role: 'tab',
        'aria-selected': String(tab === id),
        disabled,
        onclick: () => {
          state.tab = id;
          render();
          // On phones the panel moves when it changes mode; follow it.
          document.querySelector('.action').scrollIntoView({ block: 'nearest' });
        },
      },
      label,
    );
  return h(
    'section',
    { class: `panel action mine ${tab === 'ask' ? 'asking' : 'declaring'}` },
    h(
      'div',
      { class: 'action-head' },
      h('h2', {}, 'Your turn'),
      clockEl({ brief: true }),
      h('div', { class: 'tabs', role: 'tablist' }, tabButton('ask', 'Ask', !c.canAsk), tabButton('declare', 'Declare', false)),
    ),
    !c.canAsk ? h('p', { class: 'hint' }, 'There’s nothing you can ask for, so declare a set.') : null,
    tab === 'ask' ? askForm(c) : declareForm(c),
  );
}

function askForm(c) {
  const target = c.byId.get(state.askTarget);
  const info = state.askCard && cardInfo(state.askCard);
  const ready = info && target;
  return h(
    'div',
    { class: 'ask' },
    info ? null : h('p', { class: 'hint' }, 'Tap a faded card in your hand to choose what to ask for, then pick an opponent.'),
    h(
      'div',
      { class: 'ask-line' },
      h('span', { class: 'step-label' }, 'Ask for'),
      info ? cardEl(state.askCard, { small: true }) : h('span', { class: 'card small ghost' }, h('span', { class: 'rank' }, '?')),
      h('span', { class: 'step-label' }, 'from'),
      c.foes.map((m) =>
        h(
          'button',
          {
            class: `pill team-${m.team}`,
            'aria-pressed': String(state.askTarget === m.id),
            disabled: m.cards === 0,
            onclick: () => {
              state.askTarget = m.id;
              render();
            },
          },
          m.name,
          h('span', { class: 'pill-count' }, m.cards),
        ),
      ),
    ),
    h(
      'button',
      { class: 'btn primary big', disabled: !ready || state.busy, 'aria-label': ready ? `Ask ${target.name} for the ${info.name}` : null, onclick: submitAsk },
      ready ? ['Ask ', target.name, ' for the ', h('span', { class: 'inline-card' }, info.rank, pip(info.suit))] : 'Ask',
    ),
  );
}

/** Starts a declaration of `set`, naming players on your team ('mine') or on the other one ('theirs'). */
function chooseDeclareSet(c, set, side = state.declSide) {
  state.declSet = set.id;
  // Holding part of a set yourself rules out its being all with the other team.
  state.declSide = set.held > 0 ? 'mine' : side;
  state.declAssign = {};
  const team = state.declSide === 'mine' ? c.myTeam : other(c.myTeam);
  const others = c.seats.filter((m) => m.team === team && m.id !== c.v.you && m.cards > 0);
  for (const card of set.cards) {
    if (c.hand.has(card)) state.declAssign[card] = c.v.you;
    else if (others.length === 1) state.declAssign[card] = others[0].id; // nobody else it could be
  }
  render();
}

function declareForm(c) {
  const set = c.sets.find((s) => s.id === state.declSet && !s.claimedBy);
  const theirs = other(c.myTeam);
  const named = c.seats.filter((m) => m.team === (state.declSide === 'mine' ? c.myTeam : theirs) && m.id !== c.v.you);
  const complete = set?.cards.every((card) => state.declAssign[card]);
  const sideButton = (side, team, label, disabled) =>
    h(
      'button',
      {
        class: `pill team-${team}`,
        'aria-pressed': String(state.declSide === side),
        disabled,
        title: disabled ? 'You hold part of this set, so it can’t all be with the other team.' : null,
        onclick: () => chooseDeclareSet(c, set, side),
      },
      label,
    );
  return h(
    'div',
    { class: 'declare' },
    // Every set keeps its place in the picker: suits across, low above high. Sets already won are switched off.
    h(
      'div',
      { class: 'set-picker', role: 'group', 'aria-label': 'Set to declare' },
      c.sets.map((s) =>
        h(
          'button',
          {
            class: cls('pill', !s.suit && 'tall', s.claimedBy && `team-${s.claimedBy}`),
            'aria-pressed': String(s.id === state.declSet),
            'aria-label': s.name,
            title: s.claimedBy ? `${s.name}: won by ${TEAM_NAMES[s.claimedBy]}` : `${s.name}: you hold ${s.held} of ${s.cards.length}`,
            disabled: Boolean(s.claimedBy),
            onclick: () => chooseDeclareSet(c, s),
          },
          setLabel(s),
          s.held && !s.claimedBy ? h('span', { class: 'pill-count' }, s.held) : null,
        ),
      ),
    ),
    set
      ? h(
          'div',
          { class: 'ask-line' },
          h('span', { class: 'step-label' }, 'Held by'),
          sideButton('mine', c.myTeam, 'Your team', false),
          sideButton('theirs', theirs, 'The other team', set.held > 0),
        )
      : null,
    // One row per card, one column per player, so a name stays in the same place all the way down.
    set
      ? h(
          'div',
          { class: 'assign' },
          set.cards.map((card) =>
            h(
              'div',
              { class: 'assign-row' },
              cardChip(card),
              c.hand.has(card)
                ? h('span', { class: 'pill locked' }, 'You have it')
                : h(
                    'div',
                    { class: 'pills' },
                    named.map((m) =>
                      h(
                        'button',
                        {
                          class: `pill team-${m.team}`,
                          'aria-pressed': String(state.declAssign[card] === m.id),
                          disabled: m.cards === 0,
                          title: m.name,
                          onclick: () => {
                            state.declAssign[card] = m.id;
                            render();
                          },
                        },
                        h('span', { class: 'nm' }, m.name),
                      ),
                    ),
                  ),
            ),
          ),
        )
      : null,
    set
      ? h('p', { class: 'hint reminder' }, 'One mistake and the other team takes the set.')
      : h('p', { class: 'hint' }, 'Pick a set, then say who holds each card: all on your team, or all on the other team.'),
    h('button', { class: 'btn primary big', disabled: !complete || state.busy, onclick: submitDeclare }, set ? `Declare ${set.name}` : 'Pick a set'),
  );
}

function handPanel(c) {
  const groups = c.sets.filter((s) => s.held > 0);
  const picking = c.canAsk && state.tab === 'ask';
  return h(
    'section',
    { class: 'hand', 'aria-label': 'Your hand' },
    h('h2', {}, 'Your hand ', h('span', { class: 'muted count' }, `${c.g.hand.length} ${c.g.hand.length === 1 ? 'card' : 'cards'}`)),
    groups.length === 0 ? h('p', { class: 'muted' }, 'You’re out of cards. Your team can still win sets, so keep track of who has what.') : null,
    h(
      'div',
      { class: 'hand-groups', style: `--n: ${c.setSize}` },
      groups.map((set) =>
        h(
          'div',
          { class: 'hand-set' },
          h('h3', {}, set.suit ? pip(set.suit, { tinted: true }) : null, set.name, h('span', { class: 'count' }, `${set.held}/${set.cards.length}`)),
          h(
            'div',
            { class: 'hand-cards' },
            set.cards.map((card) => {
              if (c.hand.has(card)) return cardEl(card, { fresh: state.fresh.has(card) });
              // A card you are missing: on your turn, tapping it picks it as the card to ask for.
              const info = cardInfo(card);
              const selected = state.askCard === card;
              return h(
                'button',
                {
                  class: cls('card', 'ghost', `suit-${info.tint}`, info.joker && 'joker', picking && 'pickable', selected && 'selected'),
                  disabled: !picking,
                  'aria-pressed': String(selected),
                  'aria-label': `Ask for the ${info.name}`,
                  title: info.name,
                  onclick: () => {
                    state.askCard = selected ? null : card;
                    render();
                  },
                },
                cardFace(info),
              );
            }),
          ),
        ),
      ),
    ),
  );
}

function logPanel(c) {
  const { g, v } = c;
  const lastOnly = v.settings.history === 'last' && v.phase === 'playing';
  const entry = (event) => {
    if (event.type === 'ask') {
      return h(
        'li',
        { class: event.success ? 'good' : 'bad' },
        icon(event.success ? 'check' : 'cross'),
        h('span', {}, who(c, event.asker, { capital: true }), ' asked ', who(c, event.target), ' for ', cardChip(event.card)),
      );
    }
    if (event.type === 'timeout') {
      return h('li', { class: 'bad' }, icon('cross'), h('span', {}, who(c, event.player, { capital: true }), ' ran out of time'));
    }
    const set = c.sets.find((s) => s.id === event.set);
    return h(
      'li',
      { class: `declared ${event.correct ? 'good' : 'bad'}` },
      icon(event.correct ? 'star' : 'cross'),
      h(
        'span',
        {},
        who(c, event.declarer, { capital: true }),
        event.correct ? ' declared ' : ' misdeclared ',
        h('strong', {}, set.name),
        fromOtherTeam(c, event),
        ': a set for ',
        h('span', { class: `who team-${event.team}` }, TEAM_NAMES[event.team]),
      ),
    );
  };
  // The log shares its panel with the room's chat: one or the other, by the tabs along the top.
  const chatting = state.sideTab === 'chat';
  const tab = (id, label, count) =>
    h(
      'button',
      {
        class: 'tab',
        role: 'tab',
        'aria-selected': String(state.sideTab === id),
        onclick: () => {
          state.sideTab = id;
          state.chatUnread = 0;
          render();
        },
      },
      label,
      count ? h('span', { class: 'tab-count', title: `${count} new` }, count) : null,
    );
  return h(
    'section',
    { class: cls('log panel', chatting && 'chatting'), 'aria-label': chatting ? 'Chat' : 'Game log' },
    h('div', { class: 'tabs log-tabs', role: 'tablist' }, tab('log', lastOnly ? 'Last question' : 'Game log'), tab('chat', 'Chat', state.chatUnread)),
    chatting
      ? chatBox(state.roomChat)
      : [
          lastOnly ? h('p', { class: 'muted small' }, 'This room only shows the latest question. Remember the rest!') : null,
          g.log.length === 0 ? h('p', { class: 'muted small' }, 'Nothing has happened yet.') : null,
          h('ol', { class: 'log-list' }, [...g.log].reverse().map(entry)),
        ],
  );
}

// ---------------------------------------------------------------- start

window.addEventListener('popstate', () => location.reload());
// Space or Enter steps through the bots' moves, unless the key was meant for a control that has focus.
document.addEventListener('keydown', (event) => {
  if ((event.key !== ' ' && event.key !== 'Enter') || event.repeat || event.metaKey || event.ctrlKey || event.altKey) return;
  if (event.target.closest?.('input, button, a, summary, label, select, textarea')) return;
  const button = document.querySelector('.next-btn:not(:disabled)');
  if (!button) return;
  event.preventDefault();
  button.click();
});
// In a review, the arrow keys step through the moves.
document.addEventListener('keydown', (event) => {
  if (state.page !== 'review' || !state.review?.record || event.metaKey || event.ctrlKey || event.altKey) return;
  if (event.target.closest?.('input, select, textarea')) return;
  const to = { ArrowLeft: state.reviewStep - 1, ArrowRight: state.reviewStep + 1, Home: 0, End: state.review.record.log.length }[event.key];
  if (to === undefined) return;
  event.preventDefault();
  reviewTo(to);
});
// The clock counts down on the page between the server's updates.
setInterval(tickClock, 200);
// Sound has to be started from a click or a key press (see wakeAudio).
for (const type of ['pointerdown', 'keydown']) document.addEventListener(type, wakeAudio, { capture: true, passive: true });
// Follow the system's light/dark setting until the player picks a theme themselves.
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (event) => {
  if (load(localStorage, 'fish:theme')) return;
  applyTheme(event.matches ? 'dark' : 'light');
  render();
});
// "3 minutes ago" in the lobby's list should keep up with the clock.
setInterval(() => {
  if (!state.view && state.page === 'lobby') render();
}, 30_000);
applyTheme(currentTheme());
render();
connect();
if (load(sessionStorage, 'fish:linked')) {
  save(sessionStorage, 'fish:linked', null);
  toast('This browser now plays as the profile from your other device.');
}
