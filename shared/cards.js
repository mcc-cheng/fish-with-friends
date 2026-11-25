// Card and set definitions shared by the server and the browser client.
//
// Card ids are rank + suit letter ("7S", "10H", "QD"). A "set" is the low cards
// or the high cards of one suit, and the four 8s plus the jokers form a ninth.
//
// Two decks, both with nine sets:
//   54 cards, sets of six:   low 2-7, high 9-A, and 8s + two jokers ("RJ", "BJ").
//   72 cards, sets of eight: the same deck stretched with a 0, 1, 11 and 12 in
//     every suit, so low is 0-7 and high is 9-A, and with four jokers, one per
//     suit ("XS", "XH", "XD", "XC").

export const SUITS = {
  S: { name: 'Spades', red: false },
  H: { name: 'Hearts', red: true },
  D: { name: 'Diamonds', red: true },
  C: { name: 'Clubs', red: false },
};

const SUIT_ORDER = ['S', 'H', 'D', 'C'];
const RANK_NAMES = { J: 'Jack', Q: 'Queen', K: 'King', A: 'Ace' };
const DECKS = {
  54: { low: ['2', '3', '4', '5', '6', '7'], high: ['9', '10', 'J', 'Q', 'K', 'A'], jokers: ['RJ', 'BJ'] },
  72: {
    low: ['0', '1', '2', '3', '4', '5', '6', '7'],
    high: ['9', '10', '11', '12', 'J', 'Q', 'K', 'A'],
    jokers: ['XS', 'XH', 'XD', 'XC'],
  },
};

export const DECK_SIZES = [54, 72];

/** The nine sets of a deck. `kind` is 'low', 'high' or 'eights'; `suit` is null for the eights. */
export function buildSets(deck = 54) {
  const { low, high, jokers } = DECKS[deck];
  const sets = [];
  for (const suit of SUIT_ORDER) {
    const { name } = SUITS[suit];
    sets.push({ id: `L${suit}`, name: `Low ${name}`, suit, kind: 'low', cards: low.map((rank) => rank + suit) });
    sets.push({ id: `H${suit}`, name: `High ${name}`, suit, kind: 'high', cards: high.map((rank) => rank + suit) });
  }
  sets.push({
    id: 'E',
    name: 'Eights & Jokers',
    suit: null,
    kind: 'eights',
    cards: [...SUIT_ORDER.map((suit) => `8${suit}`), ...jokers],
  });
  return sets;
}

const isJoker = (card) => card === 'RJ' || card === 'BJ' || card[0] === 'X';

export function setIdOf(card) {
  if (isJoker(card)) return 'E';
  const rank = card.slice(0, -1);
  if (rank === '8') return 'E';
  // Number ranks up to 7 are low; 9 and up, and the court cards, are high.
  return (Number(rank) <= 7 ? 'L' : 'H') + card.at(-1);
}

/** How to show a card. `suit` is null for the red and black jokers, which have no suit. */
export function cardInfo(card) {
  if (card === 'RJ') return { rank: 'Joker', suit: null, red: true, joker: true, name: 'Red Joker' };
  if (card === 'BJ') return { rank: 'Joker', suit: null, red: false, joker: true, name: 'Black Joker' };
  const suit = card.at(-1);
  const rank = card.slice(0, -1);
  const { name, red } = SUITS[suit];
  if (rank === 'X') return { rank: 'Joker', suit, red, joker: true, name: `Joker of ${name}` };
  return { rank, suit, red, joker: false, name: `${RANK_NAMES[rank] ?? rank} of ${name}` };
}

// The 72-card deck holds every rank of the 54-card one, so its order serves both.
const ORDER = new Map();
for (const set of buildSets(72)) {
  for (const card of set.id === 'E' ? [...set.cards, 'RJ', 'BJ'] : set.cards) ORDER.set(card, ORDER.size);
}

/** Sorts cards so each set sits together, in rank order. Returns the same array. */
export function sortCards(cards) {
  return cards.sort((a, b) => ORDER.get(a) - ORDER.get(b));
}
