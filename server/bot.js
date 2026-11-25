// A computer player. It only uses what a human in the same seat could know:
// its own hand, everyone's card counts, and the public log of questions.

import { setIdOf } from '../shared/cards.js';

/**
 * What `playerId` can be sure of.
 *   holder: card -> id of the player known to hold it
 *   lacks:  card -> ids of players known not to hold it
 *   active: player id -> ids of sets they have asked in (so held a card of) lately
 */
export function deduce(game, playerId) {
  const holder = new Map();
  const lacks = new Map();
  const active = new Map();
  const lack = (card, id) => {
    if (!lacks.has(card)) lacks.set(card, new Set());
    lacks.get(card).add(id);
  };

  // Cards only ever move through public questions, so a holder learned from the
  // log stays right until the set is declared, and "lacks" stays right for as
  // long as the holder is unknown.
  for (const event of game.log) {
    if (event.type !== 'ask') continue;
    const setId = setIdOf(event.card);
    if (!active.has(event.asker)) active.set(event.asker, new Set());
    active.get(event.asker).add(setId);
    if (event.success) {
      holder.set(event.card, event.asker);
      active.get(event.target)?.delete(setId);
    } else {
      lack(event.card, event.asker);
      lack(event.card, event.target);
    }
  }

  const hand = game.hands.get(playerId);
  const withCards = game.seats.filter((seat) => game.hands.get(seat.id).size > 0);
  for (const set of game.sets) {
    if (set.claimedBy) continue;
    for (const card of set.cards) {
      if (hand.has(card)) {
        holder.set(card, playerId);
        continue;
      }
      lack(card, playerId);
      if (holder.has(card)) continue;
      const possible = withCards.filter((seat) => !lacks.get(card).has(seat.id));
      if (possible.length === 1) holder.set(card, possible[0].id);
    }
  }
  return { holder, lacks, active };
}

const pick = (items, rng) => items[Math.floor(rng() * items.length)];

function pickWeighted(items, rng) {
  let roll = rng() * items.reduce((sum, item) => sum + item.weight, 0);
  for (const item of items) {
    roll -= item.weight;
    if (roll < 0) return item;
  }
  return items.at(-1);
}

/** Returns a legal move for the player whose turn it is: an ask or a declaration. */
export function chooseMove(game, botId, rng = Math.random) {
  const me = game.seats.find((seat) => seat.id === botId);
  const hand = game.hands.get(botId);
  const size = (id) => game.hands.get(id).size;
  const mates = game.seats.filter((seat) => seat.team === me.team);
  const foes = game.seats.filter((seat) => seat.team !== me.team && size(seat.id) > 0);
  const onMyTeam = (id) => mates.some((seat) => seat.id === id);
  const openSets = game.sets.filter((set) => !set.claimedBy);
  const { holder, lacks, active } = deduce(game, botId);
  // Someone who asked in a set recently is a likelier place to find its cards.
  const likelihood = (id, card) => size(id) * (active.get(id)?.has(setIdOf(card)) ? 4 : 1);

  const declareMove = (set, whoHolds) => ({
    type: 'declare',
    set: set.id,
    assignment: Object.fromEntries(set.cards.map((card) => [card, whoHolds(card)])),
  });

  // 1. A set we can place card for card: claim it.
  for (const set of openSets) {
    if (set.cards.every((card) => holder.has(card) && onMyTeam(holder.get(card)))) {
      return declareMove(set, (card) => holder.get(card));
    }
  }

  // 2. Ask: take a card whose holder we know, otherwise make a guess that hasn't been ruled out.
  if (hand.size > 0 && foes.length > 0) {
    const wanted = openSets
      .filter((set) => set.cards.some((card) => hand.has(card)))
      .flatMap((set) => set.cards.filter((card) => !hand.has(card)));
    const sure = wanted.filter((card) => holder.has(card) && !onMyTeam(holder.get(card)));
    if (sure.length > 0) {
      const card = pick(sure, rng);
      return { type: 'ask', target: holder.get(card), card };
    }
    const guesses = [];
    for (const card of wanted) {
      if (holder.has(card)) continue; // a teammate has it
      for (const foe of foes) {
        if (!lacks.get(card)?.has(foe.id)) guesses.push({ card, target: foe.id, weight: likelihood(foe.id, card) });
      }
    }
    if (guesses.length > 0) {
      const { card, target } = pickWeighted(guesses, rng);
      return { type: 'ask', target, card };
    }
  }

  // 3. Nothing left worth asking, so every card we are after sits with our own
  //    team. Declare the set we know most about and guess the rest.
  const confidence = (set) =>
    set.cards.reduce((total, card) => {
      if (holder.has(card)) return total + (onMyTeam(holder.get(card)) ? 2 : -6);
      return total + (foes.every((foe) => lacks.get(card)?.has(foe.id)) ? 1 : -2);
    }, 0);
  const best = openSets.reduce((a, b) => (confidence(b) > confidence(a) ? b : a));
  return declareMove(best, (card) => {
    if (holder.has(card) && onMyTeam(holder.get(card))) return holder.get(card);
    const others = mates.filter((seat) => seat.id !== botId && size(seat.id) > 0);
    const possible = others.filter((seat) => !lacks.get(card)?.has(seat.id));
    const pool = possible.length > 0 ? possible : others;
    if (pool.length === 0) return botId;
    return pickWeighted(pool.map((seat) => ({ id: seat.id, weight: likelihood(seat.id, card) })), rng).id;
  });
}
