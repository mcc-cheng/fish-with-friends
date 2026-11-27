// What can be said about how a finished game was played.
//
// The game is played back from its record, and each move is looked at from the
// seat of the player who made it, using only what they could have known at the
// time: their own cards, how many everyone held, and every question asked so
// far. Nothing here uses the hidden hands to judge a move.
//
// analyse(record) returns
//   moves:   one note per move of the record, in order (see noteFor)
//   players: seat id -> totals for the game (see emptyTotals)

import { deduce } from './bot.js';
import { askableCards, replay } from './game.js';

const emptyTotals = () => ({
  asks: 0, // questions asked
  hits: 0, // ... that won the card
  sure: 0, // ... where they could be certain the card was there
  dead: 0, // ... where they could have known it was not
  lost: 0, // cards taken from them
  declared: 0, // sets called correctly
  misdeclared: 0, // sets called wrongly
  timeouts: 0,
});

/**
 * A note on one move, from what its player could have known.
 *
 * A question:
 *   { kind: 'sure' }                     the target was certain to hold the card
 *   { kind: 'dead', holder }             it could not work: the card was known to be elsewhere
 *                                        (`holder` if they could tell with whom), or the target
 *                                        was known not to have it
 *   { kind: 'guess', places }            it might have been there: one of `places` players who
 *                                        could have held it
 *   and, on a question that was not a sure thing, `sure`: up to three cards that were,
 *   as [{ card, from }]
 * A declaration:
 *   { kind: 'declare', known, of }       how many of the set's cards the declarer could place
 * Losing the turn on time has no note (null).
 */
function noteFor(game, event) {
  if (event.type === 'ask') {
    const { holder, lacks } = deduce(game, event.asker);
    const team = game.seats.find((seat) => seat.id === event.asker).team;
    const isFoe = (id) => game.seats.find((seat) => seat.id === id).team !== team;
    const known = holder.get(event.card);
    if (known === event.target) return { kind: 'sure' };
    const sure = askableCards(game, event.asker)
      .filter((card) => holder.has(card) && isFoe(holder.get(card)))
      .slice(0, 3)
      .map((card) => ({ card, from: holder.get(card) }));
    const offer = sure.length ? { sure } : null;
    if (known !== undefined || lacks.get(event.card)?.has(event.target)) return { kind: 'dead', holder: known ?? null, ...offer };
    const places = game.seats.filter((seat) => seat.id !== event.asker && game.hands.get(seat.id).size > 0 && !lacks.get(event.card)?.has(seat.id));
    return { kind: 'guess', places: places.length, ...offer };
  }
  if (event.type === 'declare') {
    const { holder } = deduce(game, event.declarer);
    const cards = game.sets.find((set) => set.id === event.set).cards;
    return { kind: 'declare', known: cards.filter((card) => holder.has(card)).length, of: cards.length };
  }
  return null;
}

export function analyse(record) {
  const moves = [];
  const players = Object.fromEntries(record.seats.map((seat) => [seat.id, emptyTotals()]));
  replay(record, (game, event) => {
    const note = noteFor(game, event);
    moves.push(note);
    if (event.type === 'ask') {
      const mine = players[event.asker];
      mine.asks += 1;
      if (event.success) {
        mine.hits += 1;
        players[event.target].lost += 1;
      }
      if (note.kind === 'sure') mine.sure += 1;
      if (note.kind === 'dead') mine.dead += 1;
    } else if (event.type === 'declare') {
      players[event.declarer][event.correct ? 'declared' : 'misdeclared'] += 1;
    } else {
      players[event.player].timeouts += 1;
    }
  });
  return { moves, players };
}
