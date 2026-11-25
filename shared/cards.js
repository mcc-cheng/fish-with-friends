// Card and set definitions shared by the server and the browser client.
//
// Card ids are rank + suit letter ("7S", "10H", "QD"); the jokers are "RJ" and "BJ".
// A "set" (half-suit) is six cards: the low cards 2-7 or the high cards 9-A of a
// suit. With the 54-card deck the four 8s and the two jokers form a ninth set;
// with the 48-card deck they are left out.

export const SUITS = {
  S: { name: 'Spades', symbol: '♠', red: false },
  H: { name: 'Hearts', symbol: '♥', red: true },
  D: { name: 'Diamonds', symbol: '♦', red: true },
  C: { name: 'Clubs', symbol: '♣', red: false },
};

const SUIT_ORDER = ['S', 'H', 'D', 'C'];
const LOW = ['2', '3', '4', '5', '6', '7'];
const HIGH = ['9', '10', 'J', 'Q', 'K', 'A'];
const RANK_NAMES = { J: 'Jack', Q: 'Queen', K: 'King', A: 'Ace' };

export const DECK_SIZES = [54, 48];

export function buildSets(deck = 54) {
  const sets = [];
  for (const suit of SUIT_ORDER) {
    const { name, symbol } = SUITS[suit];
    sets.push({ id: `L${suit}`, name: `Low ${name}`, short: `${symbol} low`, cards: LOW.map((r) => r + suit) });
    sets.push({ id: `H${suit}`, name: `High ${name}`, short: `${symbol} high`, cards: HIGH.map((r) => r + suit) });
  }
  if (deck === 54) {
    sets.push({
      id: 'E',
      name: 'Eights & Jokers',
      short: '8s & jokers',
      cards: [...SUIT_ORDER.map((suit) => `8${suit}`), 'RJ', 'BJ'],
    });
  }
  return sets;
}

export function setIdOf(card) {
  if (card === 'RJ' || card === 'BJ') return 'E';
  const rank = card.slice(0, -1);
  if (rank === '8') return 'E';
  return (LOW.includes(rank) ? 'L' : 'H') + card.at(-1);
}

export function cardInfo(card) {
  if (card === 'RJ') return { rank: 'Joker', symbol: '★', red: true, joker: true, label: 'Red Joker', name: 'Red Joker' };
  if (card === 'BJ') return { rank: 'Joker', symbol: '★', red: false, joker: true, label: 'Black Joker', name: 'Black Joker' };
  const suit = SUITS[card.at(-1)];
  const rank = card.slice(0, -1);
  return {
    rank,
    symbol: suit.symbol,
    red: suit.red,
    joker: false,
    label: rank + suit.symbol,
    name: `${RANK_NAMES[rank] ?? rank} of ${suit.name}`,
  };
}

const ORDER = new Map(buildSets(54).flatMap((set) => set.cards).map((card, i) => [card, i]));

/** Sorts cards so each set sits together, in rank order. Returns the same array. */
export function sortCards(cards) {
  return cards.sort((a, b) => ORDER.get(a) - ORDER.get(b));
}
