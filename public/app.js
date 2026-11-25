// The browser client. The server owns the game; this file draws whatever state
// it sends and turns clicks into messages. There is no build step: render()
// rebuilds a DOM tree from `state` and morph() patches the live page to match.

import { buildSets, cardInfo, setIdOf } from '/shared/cards.js';

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
      ['turn', 'On your turn', 'Only the player whose turn it is may declare.'],
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

// ---------------------------------------------------------------- state

// Room codes have no vowels, so a page like "/help" is never mistaken for one.
const ROOM_PATH = /^\/([BCDFGHJKLMNPQRSTVWXZ]{4})$/i;
const PAGES = { '/help': 'help', '/profile': 'profile' };

const state = {
  status: 'connecting', // connecting | open | closed
  view: null, // the latest room state from the server
  code: (location.pathname.match(ROOM_PATH)?.[1] ?? '').toUpperCase() || null, // the room we are in, or on our way into
  page: PAGES[location.pathname] ?? 'lobby', // the screen to show when not in a room: lobby | help | profile
  name: playerName(),
  busy: false,
  lobby: null, // { games, yours, online, played }: what the lobby lists
  lobbyTab: 'games', // games | yours | top
  chat: [], // lobby chat messages
  chatDraft: '',
  profile: null, // { me, stats, games }: this player's record, once asked for
  nameDraft: null, // the name being edited on the profile page
  codeDraft: '',
  tab: 'ask',
  askCard: null,
  askTarget: null,
  declOpen: false,
  declSet: null,
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
      save(sessionStorage, sessionKey(msg.code), JSON.stringify({ token: msg.token }));
      if (location.pathname !== `/${msg.code}`) history.pushState(null, '', `/${msg.code}`);
      break;
    case 'state': {
      // Anything in the new hand that wasn't in the old one was just dealt or won.
      const before = state.view ? (state.view.game?.hand ?? []) : null;
      state.fresh = new Set(before && msg.game ? msg.game.hand.filter((card) => !before.includes(card)) : []);
      state.view = msg;
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
      state.chat = [...state.chat, msg.message].slice(-200);
      break;
    case 'profile':
      state.profile = { me: msg.me, stats: msg.stats, games: msg.games };
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
  Object.assign(state, { view: null, code: null, busy: false, page: 'lobby' });
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
  Object.assign(state, { tab: 'ask', askCard: null, askTarget: null, declOpen: false, declSet: null, declAssign: {} });
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
  } else if (state.declOpen) {
    // The turn arrived while they were filling in a declaration: keep them on it.
    state.tab = 'declare';
    state.declOpen = false;
  }

  const set = buildSets(game.deck).find((s) => s.id === state.declSet);
  if (!set || game.sets.find((s) => s.id === set.id).claimedBy) {
    state.declSet = null;
    state.declAssign = {};
    return;
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

  const before = [...from.childNodes];
  const after = [...to.childNodes];
  after.forEach((node, i) => (before[i] ? morph(before[i], node) : from.append(node)));
  before.slice(after.length).forEach((node) => node.remove());
}

function render() {
  const root = document.getElementById('app');
  // Keep the chat scrolled to the latest message, unless the reader has scrolled up to look back.
  const chat = root.querySelector('.chat-list');
  const atEnd = !chat || chat.scrollHeight - chat.scrollTop - chat.clientHeight < 60;
  morph(root, h('div', { id: 'app' }, screen(), statusBar(), toastEl()));
  const chatNow = root.querySelector('.chat-list');
  if (chatNow && atEnd) chatNow.scrollTop = chatNow.scrollHeight;

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
      ? h('button', { class: 'room-pill', title: 'Copy the invite link', onclick: copyLink }, 'Game ', h('strong', {}, v.code), h('span', { class: 'copy' }, 'Copy link'))
      : null,
    h('span', { class: 'spacer' }),
    isHost && v.phase === 'playing'
      ? h('button', { class: 'btn quiet', onclick: () => confirm('End this game for everyone and go back to choosing teams?') && send({ t: 'toLobby' }) }, 'End game')
      : null,
    v ? h('button', { class: 'btn quiet', onclick: leaveRoom }, 'Leave') : null,
    h('a', { class: 'me', href: '/profile', title: 'Your profile: your games and statistics', ...away }, state.name),
    h('a', { class: 'icon-btn', href: '/help', title: 'Help: how to play', 'aria-label': 'Help: how to play', ...away }, '?'),
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

function chatPanel() {
  return h(
    'section',
    { class: 'panel chat' },
    h('h2', {}, 'Lobby chat'),
    h(
      'ol',
      { class: 'chat-list', 'aria-live': 'polite' },
      state.chat.length === 0 ? h('li', { class: 'muted' }, 'Nobody has said anything yet.') : state.chat.map((m) => h('li', {}, coloured(m.name, m.hue), ': ', m.text)),
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
  );
}

function leaderboard() {
  const { me, top } = state.ratings ?? { me: null, top: [] };
  return h(
    'div',
    { class: 'board' },
    me?.games ? h('p', { class: 'board-me' }, 'Your rating is ', h('strong', {}, me.rating), `: rank ${me.rank}, ${me.wins} won and ${me.losses} lost.`) : null,
    top.length === 0 ? h('p', { class: 'muted' }, 'No rated games yet. Everyone starts at 1000, and ratings move after each game with a human player on both teams.') : null,
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
        ? h('p', { class: 'muted small' }, 'Your games and rating are kept for this browser. Clearing its site data, or playing from another browser, starts a new record.')
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
              ? h('p', { class: 'muted' }, 'You haven’t finished a game yet. Every game you play to the end will be listed here.')
              : h(
                  'div',
                  { class: 'table-scroll' },
                  h(
                    'table',
                    { class: 'games' },
                    h('thead', {}, h('tr', {}, ['Played', 'Result', 'Score', 'With', 'Against', 'Deck', 'Rating'].map((label) => h('th', { scope: 'col' }, label)))),
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
                        ),
                      ),
                    ),
                  ),
                ),
          )
        : null,
    ),
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
        p('When you think your team holds a whole set between you, ', b('declare'), ' it: say which teammate holds each of its cards.'),
        h(
          'ul',
          {},
          h('li', {}, 'Every card right: your team wins the set.'),
          h('li', {}, 'Any card wrong, including one an opponent turns out to hold: the other team wins it.'),
        ),
        p('Either way the set leaves the game and the cards are shown. Teammates may not tell each other what they hold, so declaring is done from what you have seen asked and answered.'),
      ),
      section(
        'Running out of cards',
        p('A player with no cards can’t be asked. If the turn falls to them it passes to the next teammate who has cards. When one whole team is out of cards, the other team has to declare everything that is left.'),
        p('The game ends when all nine sets are won. Nine is odd, so there is always a winner.'),
      ),
      section(
        'House rules',
        p('The host chooses these before the game starts.'),
        h(
          'ul',
          {},
          h('li', {}, b('Deck'), ': sets of six or sets of eight, as above.'),
          h('li', {}, b('Declaring'), ': only on your own turn, or at any time by anyone.'),
          h('li', {}, b('Bot moves'), ': one at a time, with a bot waiting until a player presses Next (or Space); or automatically after a short pause.'),
          h('li', {}, b('Question history'), ': a full log everyone can scroll back through, or only the last question, as at a real table.'),
        ),
      ),
      section(
        'Games, bots and seats',
        p('A public game is listed in the lobby for anyone to join. A private game is reached only by its link or four-letter code. Teams need the same number of players, and bots can fill empty seats.'),
        p('If you lose your connection or close the tab, your seat is kept: opening the game again from the same browser puts you back in it. If someone has gone for good, the host can let a bot play their cards, or a spectator can take the seat over.'),
      ),
      section(
        'Ratings',
        p('Everyone has an Elo rating that starts at 1000. A game is ', b('rated'), ' when each team has at least one human player and nobody is sitting in two seats; anything else is a practice game.'),
        p('A team is rated as the average of its players, with bots counted as 1000. Winners take points from losers: 16 between evenly matched teams, more for beating a stronger team, fewer for beating a weaker one. Your profile lists every game you have finished.'),
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
  if (unrated === 'needs-humans') return 'Practice game: ratings only change when each team has at least one human player.';
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
  const canStep = v.phase === 'playing' && g.awaitingNext && (seated || isHost);
  return { v, g, byId, me, seated, myTeam, hand, sets, setSize: sets[0].cards.length, seats, myTurn, foes, canAsk, canStep, isHost };
}

/** A player's name in their team colour; "you" for the viewer. */
function who(c, id, { capital = false } = {}) {
  const m = c.byId.get(id);
  if (!m) return 'someone';
  const text = id === c.v.you ? (capital ? 'You' : 'you') : m.name;
  return h('span', { class: `who team-${m.team}` }, text);
}

function gameScreen() {
  const c = gameContext();
  return h(
    'div',
    { class: 'page' },
    topbar(),
    h(
      'div',
      { class: 'game' },
      h(
        'main',
        { class: 'game-main' },
        scoreboard(c),
        playersPanel(c),
        banner(c),
        c.g.winner ? resultPanel(c) : actionPanel(c),
        c.seated && !c.g.winner ? handPanel(c) : null,
      ),
      logPanel(c),
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
        h('div', { class: 'seat-row' }, c.seats.filter((m) => m.team === team).map((m) => seat(c, m))),
      ),
    ),
  );
}

function seat(c, m) {
  const turn = c.g.turn === m.id;
  const away = !m.bot && !m.online;
  const playing = c.v.phase === 'playing';
  return h(
    'div',
    { class: cls('seat', `team-${m.team}`, turn && 'turn', m.cards === 0 && 'out', away && 'away') },
    h(
      'div',
      { class: 'seat-main' },
      h('div', { class: 'seat-name' }, h('span', { class: 'nm' }, m.name), memberTags(m, { host: false })),
      turn ? h('span', { class: 'turn-pill' }, 'to play') : null,
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
              { class: cls(`team-${change.team}`, change.you && 'you') },
              h('span', { class: 'who nm' }, change.name),
              h('span', { class: cls('delta', change.delta > 0 ? 'up' : 'down') }, change.delta > 0 ? `+${change.delta}` : `−${-change.delta}`),
              h('span', { class: 'after', title: 'New Elo rating' }, change.after),
            ),
          ),
        )
      : null,
    c.v.unrated ? h('p', { class: 'muted small' }, 'Practice game: ratings are unchanged.') : null,
    c.isHost
      ? h(
          'div',
          { class: 'result-actions' },
          h('button', { class: 'btn primary big', onclick: () => send({ t: 'start' }) }, 'Play again'),
          h('button', { class: 'btn', onclick: () => send({ t: 'toLobby' }) }, 'Back to lobby'),
        )
      : h('p', { class: 'muted' }, 'Waiting for the host to start another game…'),
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
    if (!c.g.declareAnytime) return h('section', { class: 'panel action' }, waiting);
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
    h('div', { class: 'action-head' }, h('h2', {}, 'Your turn'), h('div', { class: 'tabs', role: 'tablist' }, tabButton('ask', 'Ask', !c.canAsk), tabButton('declare', 'Declare', false))),
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

function chooseDeclareSet(c, set) {
  state.declSet = set.id;
  state.declAssign = {};
  const mates = c.seats.filter((m) => m.team === c.myTeam && m.id !== c.v.you && m.cards > 0);
  for (const card of set.cards) {
    if (c.hand.has(card)) state.declAssign[card] = c.v.you;
    else if (mates.length === 1) state.declAssign[card] = mates[0].id; // nobody else it could be
  }
  render();
}

function declareForm(c) {
  const open = c.sets.filter((s) => !s.claimedBy);
  const set = open.find((s) => s.id === state.declSet);
  const mates = c.seats.filter((m) => m.team === c.myTeam && m.id !== c.v.you);
  const complete = set?.cards.every((card) => state.declAssign[card]);
  return h(
    'div',
    { class: 'declare' },
    h('p', { class: 'hint' }, 'Say which teammate holds each card. One mistake and the other team takes the set.'),
    h(
      'div',
      { class: 'pills' },
      open.map((s) =>
        h(
          'button',
          { class: 'pill', 'aria-pressed': String(s.id === state.declSet), 'aria-label': s.name, onclick: () => chooseDeclareSet(c, s) },
          setLabel(s),
          s.held ? h('span', { class: 'pill-count' }, `${s.held}/${s.cards.length}`) : null,
        ),
      ),
    ),
    set
      ? h(
          'div',
          { class: 'assign' },
          set.cards.map((card) =>
            h(
              'div',
              { class: 'assign-row' },
              cardEl(card, { small: true }),
              c.hand.has(card)
                ? h('span', { class: 'pill locked' }, 'You have it')
                : h(
                    'div',
                    { class: 'pills' },
                    mates.map((m) =>
                      h(
                        'button',
                        {
                          class: `pill team-${m.team}`,
                          'aria-pressed': String(state.declAssign[card] === m.id),
                          disabled: m.cards === 0,
                          onclick: () => {
                            state.declAssign[card] = m.id;
                            render();
                          },
                        },
                        m.name,
                      ),
                    ),
                  ),
            ),
          ),
        )
      : null,
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
        ': a set for ',
        h('span', { class: `who team-${event.team}` }, TEAM_NAMES[event.team]),
      ),
    );
  };
  return h(
    'aside',
    { class: 'log panel', 'aria-label': 'Game log' },
    h('h2', {}, lastOnly ? 'Last question' : 'Game log'),
    lastOnly ? h('p', { class: 'muted small' }, 'This room only shows the latest question. Remember the rest!') : null,
    g.log.length === 0 ? h('p', { class: 'muted small' }, 'Nothing has happened yet.') : null,
    h('ol', { class: 'log-list' }, [...g.log].reverse().map(entry)),
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
