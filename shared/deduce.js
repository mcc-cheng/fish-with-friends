// What one player can work out for certain, from their own hand, how many cards
// everyone holds, and the questions asked so far. Shared by the server (the
// bots play from it, and the review's notes are written from it) and the
// browser (the review shows it as a seat's view of the table).

import { setIdOf } from './cards.js';

/**
 * What `playerId` can be sure of. `game` needs only `seats`, `sets` (each with
 * `cards` and `claimedBy`), `hands` (player id -> Set of cards) and `log`.
 *   holder: card -> id of the player known to hold it
 *   lacks:  card -> ids of players known not to hold it
 *   active: player id -> ids of the sets they have asked in since they last
 *           lost a card from it, so they are known to hold at least one card of
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
