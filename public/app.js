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

const state = {
  status: 'connecting', // connecting | open | closed
  view: null, // the latest room state from the server
  code: (location.pathname.match(/^\/([A-Za-z]{4})$/)?.[1] ?? '').toUpperCase() || null,
  joining: false,
  busy: false,
  nameDraft: load(localStorage, 'fish:name') ?? '',
  codeDraft: '',
  tab: 'ask',
  askCard: null,
  askTarget: null,
  declOpen: false,
  declSet: null,
  declAssign: {},
  fresh: new Set(), // cards that arrived in the latest update, so they can be animated in
  ratings: null, // { me, top }: this player's Elo standing and the leaderboard
  toast: null,
  flashed: 0,
};
state.joining = Boolean(state.code && loadSession(state.code));

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
    send({ t: 'hello', player: PLAYER }); // says who we are and fetches the leaderboard
    const session = state.code && loadSession(state.code);
    state.joining = Boolean(session) && !state.view;
    if (session) send({ t: 'join', code: state.code, name: session.name, token: session.token, player: PLAYER });
    render();
  };
  ws.onmessage = (event) => receive(JSON.parse(event.data));
  ws.onclose = () => {
    state.status = 'closed';
    state.busy = false;
    state.joining = false;
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
      save(sessionStorage, sessionKey(msg.code), JSON.stringify({ token: msg.token, name: state.nameDraft }));
      if (location.pathname !== `/${msg.code}`) history.replaceState(null, '', `/${msg.code}`);
      break;
    case 'state': {
      // Anything in the new hand that wasn't in the old one was just dealt or won.
      const before = state.view ? (state.view.game?.hand ?? []) : null;
      state.fresh = new Set(before && msg.game ? msg.game.hand.filter((card) => !before.includes(card)) : []);
      state.view = msg;
      state.busy = false;
      state.joining = false;
      reconcile();
      break;
    }
    case 'ratings':
      state.ratings = { me: msg.me, top: msg.top };
      break;
    case 'error':
      state.busy = false;
      state.joining = false;
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
  Object.assign(state, { view: null, code: null, busy: false });
  resetMoves();
  if (location.pathname !== '/') history.replaceState(null, '', '/');
  // Back on the home screen: the leaderboard may have moved while we played.
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'hello', player: PLAYER }));
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

function rememberName() {
  const name = state.nameDraft.trim();
  if (!name) {
    toast('Enter your name first.', 'bad');
    document.querySelector('[data-focus="name"]')?.focus();
    return null;
  }
  save(localStorage, 'fish:name', name);
  return name;
}

function createRoom(event) {
  event.preventDefault();
  const name = rememberName();
  if (name) send({ t: 'create', name, player: PLAYER });
}

function joinRoom(event) {
  event.preventDefault();
  const code = (state.code ?? state.codeDraft).trim().toUpperCase();
  if (!/^[A-Z]{4}$/.test(code)) {
    toast('Room codes are four letters.', 'bad');
    document.querySelector('[data-focus="code"]')?.focus();
    return;
  }
  const name = rememberName();
  if (name) send({ t: 'join', code, name, player: PLAYER });
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
  morph(root, h('div', { id: 'app' }, screen(), statusBar(), toastEl()));

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
  if (state.view) return state.view.phase === 'lobby' ? lobbyScreen() : gameScreen();
  if (state.joining) return h('main', { class: 'home' }, h('p', { class: 'muted center' }, 'Rejoining your room…'));
  return homeScreen();
}

function statusBar() {
  if (state.status === 'open' || (state.status === 'connecting' && !state.view)) return null;
  return h('div', { class: 'statusbar', role: 'status' }, 'Connection lost. Reconnecting…');
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

function rules() {
  return h(
    'details',
    { class: 'rules' },
    h('summary', {}, 'How to play'),
    h(
      'ul',
      {},
      h('li', {}, 'Two teams. The deck is split into nine ', h('strong', {}, 'sets'), ': the low cards and the high cards of each suit, plus the four 8s with the jokers.'),
      h('li', {}, 'On your turn, ', h('strong', {}, 'ask'), ' one opponent for one exact card. You must already hold a card from the same set, and you can’t ask for a card you have.'),
      h('li', {}, 'If they have it, they hand it over and you go again. If not, the turn passes to them.'),
      h('li', {}, 'When you think your team holds a whole set, ', h('strong', {}, 'declare'), ' it by saying which teammate has each card. All right and your team wins the set; any mistake and the other team gets it.'),
      h('li', {}, 'No table talk about cards. The team with the most sets wins.'),
      h('li', {}, 'Games with a human player on each team are ', h('strong', {}, 'rated'), ': the winners take Elo points from the losers, more for an upset.'),
    ),
  );
}

// ---- home

function homeScreen() {
  const nameField = h(
    'label',
    { class: 'field' },
    h('span', {}, 'Your name'),
    h('input', {
      type: 'text',
      'data-focus': 'name',
      maxlength: 20,
      autocomplete: 'nickname',
      placeholder: 'What should we call you?',
      value: state.nameDraft,
      oninput: (e) => {
        state.nameDraft = e.target.value;
      },
    }),
  );

  const body = state.code
    ? h(
        'form',
        { class: 'panel stack', onsubmit: joinRoom },
        h('h2', {}, 'Join room ', h('span', { class: 'code' }, state.code)),
        nameField,
        h('button', { class: 'btn primary big', type: 'submit' }, 'Join game'),
        h('a', { class: 'muted small', href: '/' }, 'Or start a room of your own'),
      )
    : h(
        'div',
        { class: 'panel stack' },
        nameField,
        h('form', { onsubmit: createRoom }, h('button', { class: 'btn primary big', type: 'submit' }, 'Create a room')),
        h('div', { class: 'divider' }, 'or join a friend’s'),
        h(
          'form',
          { class: 'join-row', onsubmit: joinRoom },
          h('input', {
            type: 'text',
            'data-focus': 'code',
            'aria-label': 'Room code',
            maxlength: 4,
            autocomplete: 'off',
            autocapitalize: 'characters',
            spellcheck: 'false',
            placeholder: 'CODE',
            class: 'code-input',
            value: state.codeDraft,
            oninput: (e) => {
              state.codeDraft = e.target.value;
            },
          }),
          h('button', { class: 'btn', type: 'submit' }, 'Join'),
        ),
      );

  return h(
    'main',
    { class: 'home' },
    h('div', { class: 'corner' }, themeButton()),
    h('div', { class: 'fan', 'aria-hidden': 'true' }, ['9S', '10H', 'JD', 'QC', 'KH', 'AS'].map((card, i) => h('span', { class: 'fan-slot', style: `--i: ${i}` }, cardEl(card)))),
    h('h1', { class: 'logo' }, 'Fish'),
    h('p', { class: 'tagline' }, 'The team card game of asking, remembering and declaring, also known as Literature. For 4, 6 or 8 players.'),
    body,
    leaderboard(),
    rules(),
  );
}

function leaderboard() {
  const { me, top } = state.ratings ?? { me: null, top: [] };
  return h(
    'section',
    { class: 'panel board' },
    h('h2', {}, 'Leaderboard'),
    me?.games
      ? h('p', { class: 'board-me' }, 'Your rating is ', h('strong', {}, me.rating), `: rank ${me.rank}, ${me.wins} won and ${me.losses} lost.`)
      : null,
    top.length === 0 ? h('p', { class: 'muted small' }, 'No rated games yet. Everyone starts at 1000, and ratings move after each game with a human player on both teams.') : null,
    PLAYER ? null : h('p', { class: 'muted small' }, 'This browser is blocking storage, so your games here can’t be rated.'),
    h(
      'ol',
      { class: 'board-list' },
      top.slice(0, 10).map((row) =>
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

// ---- lobby

function topbar() {
  const v = state.view;
  const isHost = v.hostId === v.you;
  return h(
    'header',
    { class: 'topbar' },
    h('span', { class: 'brand' }, 'Fish'),
    h('button', { class: 'room-pill', title: 'Copy the invite link', onclick: copyLink }, 'Room ', h('strong', {}, v.code), h('span', { class: 'copy' }, 'Copy link')),
    h('span', { class: 'spacer' }),
    isHost && v.phase === 'playing'
      ? h('button', { class: 'btn quiet', onclick: () => confirm('End this game for everyone and go back to the lobby?') && send({ t: 'toLobby' }) }, 'End game')
      : null,
    h('button', { class: 'btn quiet', onclick: leaveRoom }, 'Leave'),
    themeButton(),
  );
}

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

function lobbyScreen() {
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
      { class: 'lobby' },
      h(
        'section',
        { class: 'invite' },
        h('h1', {}, 'Waiting for players'),
        h('p', { class: 'muted' }, 'Send friends this link, or tell them the code ', h('strong', { class: 'code' }, v.code), '.'),
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
      rules(),
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
  return { v, g, byId, me, seated, myTeam, hand, sets, setSize: sets[0].cards.length, seats, myTurn, foes, canAsk, isHost: v.hostId === v.you };
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

  if (!last) return h('section', { class: 'banner panel', 'aria-live': 'polite' }, h('p', { class: 'banner-text' }, 'The cards are dealt. ', next));

  if (last.type === 'ask') {
    return h(
      'section',
      { class: `banner panel ${last.success ? 'good' : 'bad'}`, 'aria-live': 'polite' },
      h(
        'p',
        { class: 'banner-text' },
        who(c, last.asker, { capital: true }),
        ' asked ',
        who(c, last.target),
        ' for the ',
        cardChip(last.card),
        last.success ? ' and got it. ' : [', but ', who(c, last.target), last.target === c.v.you ? ' don’t' : ' doesn’t', ' have it. '],
        next,
      ),
    );
  }

  const set = c.sets.find((s) => s.id === last.set);
  return h(
    'section',
    { class: `banner panel ${last.correct ? 'good' : 'bad'}`, 'aria-live': 'polite' },
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
    const waiting = h('p', { class: 'waiting' }, 'Waiting for ', who(c, c.g.turn), '…');
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
// Follow the system's light/dark setting until the player picks a theme themselves.
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (event) => {
  if (load(localStorage, 'fish:theme')) return;
  applyTheme(event.matches ? 'dark' : 'light');
  render();
});
applyTheme(currentTheme());
render();
connect();
