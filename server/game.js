// The rules of Fish, with no networking: deal, ask, declare, pass the turn, score.
// Every function mutates the game object it is given and reports problems as
// { ok: false, error } instead of throwing, so the caller can relay them to a player.

import { buildSets } from '../shared/cards.js';

export const otherTeam = (team) => (team === 'A' ? 'B' : 'A');

export function shuffle(items, rng = Math.random) {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}

/** When a player may declare: while their team has the turn, only on their own turn, or whenever they like. */
export const DECLARE_RULES = ['team', 'turn', 'anytime'];

/**
 * @param {{ seats: { id: string, team: 'A' | 'B' }[], deck?: 54 | 72, declareRule?: 'team' | 'turn' | 'anytime', rng?: () => number }} options
 *   `seats` is the order around the table and must alternate teams, so that an
 *   uneven deal (54 cards between 4 or 8 players) gives both teams the same total.
 */
export function createGame({ seats, deck = 54, declareRule = 'team', rng = Math.random }) {
  const sets = buildSets(deck).map((set) => ({ ...set, claimedBy: null }));
  const hands = new Map(seats.map((seat) => [seat.id, new Set()]));
  const cards = shuffle(sets.flatMap((set) => set.cards), rng);
  const dealer = Math.floor(rng() * seats.length);
  cards.forEach((card, i) => hands.get(seats[(dealer + i) % seats.length].id).add(card));
  return {
    deck,
    declareRule,
    seats: seats.map(({ id, team }) => ({ id, team })),
    sets,
    hands,
    turn: seats[Math.floor(rng() * seats.length)].id,
    score: { A: 0, B: 0 },
    log: [],
    phase: 'playing',
    winner: null,
  };
}

const fail = (error) => ({ ok: false, error });
const seatOf = (game, id) => game.seats.find((seat) => seat.id === id);

/** The cards `playerId` may legally ask for: missing cards from sets they hold part of. */
export function askableCards(game, playerId) {
  const hand = game.hands.get(playerId);
  if (!hand) return [];
  return game.sets
    .filter((set) => !set.claimedBy && set.cards.some((card) => hand.has(card)))
    .flatMap((set) => set.cards.filter((card) => !hand.has(card)));
}

export function ask(game, askerId, targetId, card) {
  if (game.phase !== 'playing') return fail('The game is over.');
  if (game.turn !== askerId) return fail("It isn't your turn.");
  const asker = seatOf(game, askerId);
  const target = seatOf(game, targetId);
  if (!target || target.team === asker.team) return fail('You can only ask an opponent.');
  const targetHand = game.hands.get(targetId);
  if (targetHand.size === 0) return fail('That player has no cards left.');
  const set = game.sets.find((s) => s.cards.includes(card));
  if (!set || set.claimedBy) return fail('That card is not in play.');
  const hand = game.hands.get(askerId);
  if (hand.has(card)) return fail('You already hold that card.');
  if (!set.cards.some((c) => hand.has(c))) return fail('You need a card from the same set to ask for it.');

  const success = targetHand.delete(card);
  if (success) hand.add(card);
  else game.turn = targetId;

  const event = { type: 'ask', seq: game.log.length + 1, asker: askerId, target: targetId, card, success, nextTurn: game.turn };
  game.log.push(event);
  return { ok: true, event };
}

/** Whether `playerId` is allowed to declare right now, under the game's declaring rule. */
export function canDeclare(game, playerId) {
  const player = seatOf(game, playerId);
  if (!player || game.phase !== 'playing') return false;
  if (game.declareRule === 'anytime') return true;
  if (game.declareRule === 'turn') return game.turn === playerId;
  return seatOf(game, game.turn).team === player.team;
}

/**
 * Call a set by naming who holds each card: `assignment` maps every card of the
 * set to a player id. The players named must all be on one team, the declarer's
 * own or the other one. Every card right and the declarer's team takes the set;
 * anything else and the other team does.
 */
export function declare(game, declarerId, setId, assignment) {
  if (game.phase !== 'playing') return fail('The game is over.');
  const declarer = seatOf(game, declarerId);
  if (!declarer) return fail('Only players can declare.');
  if (!canDeclare(game, declarerId)) {
    return fail(game.declareRule === 'turn' ? 'You can only declare on your turn.' : 'You can only declare while your team has the turn.');
  }
  const set = game.sets.find((s) => s.id === setId);
  if (!set) return fail('Unknown set.');
  if (set.claimedBy) return fail('That set has already been claimed.');
  if (!assignment || typeof assignment !== 'object') return fail('Say who holds each card.');
  const named = set.cards.map((card) => seatOf(game, assignment[card]));
  if (named.some((holder) => !holder)) return fail('Say who holds each card.');
  if (named.some((holder) => holder.team !== named[0].team)) {
    return fail('Name players from one team only: all on your team, or all on the other team.');
  }

  const actual = {};
  for (const card of set.cards) {
    for (const [id, hand] of game.hands) {
      if (hand.delete(card)) actual[card] = id;
    }
  }
  const correct = set.cards.every((card) => actual[card] === assignment[card]);
  const team = correct ? declarer.team : otherTeam(declarer.team);
  set.claimedBy = team;
  game.score[team] += 1;
  settleTurn(game);

  const event = {
    type: 'declare',
    seq: game.log.length + 1,
    declarer: declarerId,
    set: setId,
    correct,
    team,
    named: named[0].team, // the team whose players the declarer named
    assignment: Object.fromEntries(set.cards.map((card) => [card, assignment[card]])),
    actual,
    nextTurn: game.turn,
  };
  game.log.push(event);
  return { ok: true, event };
}

/**
 * The player to move has run out of time and loses the turn. It goes to the next
 * opponent round the table who has cards (or, if the other team is out of cards,
 * to the next teammate). Fails if there is nobody else to give it to.
 */
export function timeout(game, playerId) {
  if (game.phase !== 'playing') return fail('The game is over.');
  if (game.turn !== playerId) return fail("It isn't their turn.");
  const i = game.seats.findIndex((seat) => seat.id === playerId);
  const hasCards = (seat) => game.hands.get(seat.id).size > 0;
  const around = [...game.seats.slice(i + 1), ...game.seats.slice(0, i)];
  const next = around.find((seat) => seat.team !== game.seats[i].team && hasCards(seat)) ?? around.find(hasCards);
  if (!next) return fail('There is nobody to pass the turn to.');
  game.turn = next.id;
  const event = { type: 'timeout', seq: game.log.length + 1, player: playerId, nextTurn: next.id };
  game.log.push(event);
  return { ok: true, event };
}

/**
 * After cards leave play: end the game if every set is claimed, otherwise make
 * sure the turn sits with someone who still has cards. An empty-handed player
 * hands the turn to the next teammate around the table who has cards, and to
 * the next opponent only when their whole team is out.
 */
function settleTurn(game) {
  if (game.sets.every((set) => set.claimedBy)) {
    const { A, B } = game.score;
    game.phase = 'finished';
    game.turn = null;
    game.winner = A > B ? 'A' : B > A ? 'B' : 'tie';
    return;
  }
  const hasCards = (seat) => game.hands.get(seat.id).size > 0;
  const i = game.seats.findIndex((seat) => seat.id === game.turn);
  if (hasCards(game.seats[i])) return;
  const around = [...game.seats.slice(i + 1), ...game.seats.slice(0, i)];
  const next = around.find((seat) => seat.team === game.seats[i].team && hasCards(seat)) ?? around.find(hasCards);
  game.turn = next.id;
}
