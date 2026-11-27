// A game against bots, then the review of it: the bots' rating, the link to the
// review, stepping through, the note on each kind of move, and one player's view.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyse } from '../server/analysis.js';
import { ask, askableCards, recordOf, replay } from '../server/game.js';
import { deduce } from '../shared/deduce.js';
import { DESK, PHONE, newGame, overflow, seating, setup, shot, startGame, text } from './lib/harness.mjs';

/**
 * Plays the game out on the server: the bots as themselves, and the person half
 * the time as a bot would and half the time asking at random, so that the
 * record has every kind of move in it.
 */
function playOut(world, room) {
  const { game, human, foes } = seating(room);
  let seed = 7;
  const random = () => (seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296;
  const pick = (items) => items[Math.floor(random() * items.length)];
  for (let guard = 0; game.phase === 'playing' && guard < 5000; guard++) {
    const targets = foes.filter((id) => game.hands.get(id).size > 0);
    const cards = askableCards(game, human.id);
    if (game.turn === human.id && targets.length && cards.length && random() < 0.5) ask(game, human.id, pick(targets), pick(cards));
    else world.rooms.moveBot(room, game.turn);
  }
  world.rooms.settleGame(room);
  world.rooms.broadcast(room);
  assert.equal(game.phase, 'finished');
}

for (const [label, size, deck, side] of [['a laptop, sets of six, two a side', DESK, 54, 2], ['a phone, sets of eight, three a side', PHONE, 72, 3]]) {
  test(`reviewing a finished game: ${label}`, async () => {
    const world = await setup();
    const tag = size === PHONE ? 'phone' : 'desk';
    try {
      const page = await world.open('Ming', size);
      const room = await newGame(world, page, { orange: side - 1, purple: side, deck });
      assert.deepEqual(await page.locator('.roster .rating').allInnerTexts(), Array(side * 2).fill('1000'), 'every seat shows a rating, bots too');
      await startGame(page);
      playOut(world, room);
      await page.waitForSelector('.result');
      const { game } = seating(room);
      const moves = game.log.length;

      // ---- the end of the game: the rating changes, the bots' among them
      const changes = await Promise.all((await page.locator('.changes li').all()).map(text));
      assert.ok(changes.some((line) => line.startsWith('Ming')), `the player's rating change is shown: ${changes}`);
      assert.match(changes.at(-1), /^Bots all bots/, 'the bots come last, marked as all bots');
      assert.ok((await overflow(page)) <= 0, 'no sideways scrolling on the result');
      await shot(page, `review-${tag}-1-result`);

      // ---- into the review, in a new tab
      const [review] = await Promise.all([page.context().waitForEvent('page'), page.getByRole('link', { name: 'Review the game' }).click()]);
      await review.waitForSelector('.review-table');
      const at = () => review.locator('.review-at').innerText();
      const chips = () => review.locator('.review-cards .chip').count();
      assert.equal(await at(), `The deal · ${moves} moves`);
      assert.equal(await chips(), deck, 'every card is face up at the deal');
      assert.equal(await review.locator('.review-list li').count(), moves + 1, 'the list has the deal and every move');
      assert.equal(await review.locator('.review-seat').count(), side * 2);
      assert.ok((await overflow(review)) <= 0, 'no sideways scrolling in the review');

      // Step with the keyboard, checking positions against the game as the server recorded it.
      const record = recordOf(game);
      const expected = [];
      replay(record, (g) => expected.push({ cards: [...g.hands.values()].reduce((n, hand) => n + hand.size, 0), score: { ...g.score } }));
      const sample = new Set([1, 2, 3, Math.floor(moves / 2), moves - 1, moves]);
      for (let k = 1; k <= moves; k++) {
        await review.keyboard.press('ArrowRight');
        if (!sample.has(k) && k % 9) continue;
        assert.equal(await at(), `Move ${k} of ${moves}`);
        assert.equal(await chips(), expected[k - 1].cards, `cards on the table at move ${k}`);
        assert.deepEqual((await review.locator('.review-score').allInnerTexts()).map(Number), [expected[k - 1].score.A, expected[k - 1].score.B], `score at move ${k}`);
      }
      assert.ok(await review.getByRole('button', { name: 'Next' }).isDisabled(), 'Next is disabled on the last move');
      const inView = await review.locator('.review-list li.current').evaluate((row) => {
        const list = row.closest('.review-list').getBoundingClientRect();
        const box = row.getBoundingClientRect();
        return box.top >= list.top - 1 && box.bottom <= list.bottom + 1;
      });
      assert.ok(inView, 'the list keeps the current move in view');

      // One of each kind of note the game happens to have, reached by clicking its row.
      const notes = analyse(record).moves;
      const find = (wanted) => notes.findIndex((note, i) => note && wanted(note, record.log[i]));
      const kinds = {
        sure: find((n) => n.kind === 'sure'),
        dead: find((n) => n.kind === 'dead'),
        guess: find((n) => n.kind === 'guess' && !n.sure),
        'missed-a-sure-card': find((n) => n.kind === 'guess' && n.sure),
        declared: find((n, e) => n.kind === 'declare' && e.correct),
        misdeclared: find((n, e) => n.kind === 'declare' && !e.correct),
      };
      for (const [kind, i] of Object.entries(kinds)) {
        if (i < 0) continue;
        await review.locator('.review-list li').nth(i + 1).click();
        assert.equal(await at(), `Move ${i + 1} of ${moves}`);
        assert.equal(await review.locator('.review-cards .chip.hot').count(), record.log[i].type === 'ask' ? 1 : deck / 9, `${kind}: the card, or the set, is marked`);
        assert.equal(await review.locator('.review-note .tag').count(), 1, `${kind}: the move has its note`);
        await shot(review, `review-${tag}-2-${kind}`, { fullPage: false });
      }
      assert.ok(kinds.sure >= 0 && kinds.guess >= 0 && kinds.declared >= 0, 'the game had the common kinds of move');

      // The buttons, the slider and the numbers.
      await review.getByRole('button', { name: 'First' }).click();
      assert.match(await at(), /^The deal/);
      const middle = Math.floor(moves / 2);
      await review.locator('.review-range').fill(String(middle));
      assert.equal(await at(), `Move ${middle} of ${moves}`);
      await review.getByRole('button', { name: 'Back' }).click();
      assert.equal(await at(), `Move ${middle - 1} of ${moves}`);
      assert.equal(await review.locator('.review-totals tbody tr').count(), side * 2);

      // ---- seen by one player: only what they could place, and a grid of who has, can't have and might have each card
      const viewer = record.seats[0];
      const step = middle; // the position move `middle` was made in
      await review.locator('.review-range').fill(String(step));
      await review.locator('.review-seen').getByRole('button', { name: seating(room).nameOf(viewer.id), exact: true }).click();
      await review.waitForSelector('.review-know');
      const position = { hands: null, sets: null };
      replay(record, (g, event, i) => {
        if (i !== step - 1) return;
        position.hands = new Map([...g.hands].map(([id, hand]) => [id, new Set(hand)]));
        position.sets = g.sets.map((set) => ({ ...set }));
        position.known = deduce(g, viewer.id);
      });
      const open = position.sets.filter((set) => !set.claimedBy);
      const openCards = open.flatMap((set) => set.cards);
      const placed = openCards.filter((card) => position.known.holder.has(card));
      const count = (selector) => review.locator(selector).count();
      assert.equal(await count('.know-set'), 9, 'a table for every set');
      assert.equal(await count('.know-set.won'), 9 - open.length, 'sets already won are greyed out');
      assert.equal(await count('.know-set td'), openCards.length * side * 2, 'a cell for every card still in play and every player');
      assert.equal(await count('.know-set td .know.has'), placed.length, 'one "has it" for each card the viewer could place');
      const cardsInPlay = [...position.hands.values()].reduce((n, hand) => n + hand.size, 0);
      assert.equal(cardsInPlay, openCards.length);
      assert.equal(await chips(), placed.length, 'the hands show only the cards the viewer could place');
      assert.equal(await review.locator('.review-seat.self .chip').count(), position.hands.get(viewer.id).size, 'their own hand is whole');
      assert.ok((await overflow(review)) <= 0, 'no sideways scrolling with the grid open');
      await shot(review, `review-${tag}-3-seat-view`);

      // ...and, on request, where the cards they couldn't place really were.
      await review.getByLabel('Show where the cards really were').check();
      assert.equal(await chips(), cardsInPlay, 'every card is on the table again');
      assert.equal(await count('.review-cards .chip.unplaced'), cardsInPlay - placed.length, 'the ones they could not place are faint');
      assert.equal(await count('.know-set td .know.real'), cardsInPlay - placed.length, 'and each is marked in the grid where it really was');
      await shot(review, `review-${tag}-4-seat-view-truth`);
      // Stepping keeps the view; "Everyone" turns every hand face up again.
      await review.keyboard.press('ArrowRight');
      assert.equal(await count('.review-know'), 1);
      await review.locator('.review-seen').getByRole('button', { name: 'Everyone' }).click();
      assert.equal(await count('.review-know'), 0);
      assert.equal(await count('.review-cards .chip.unplaced'), 0);

      // ---- the review by its link alone, a game that isn't there, the profile's link, the leaderboard
      const fresh = await page.context().newPage();
      await fresh.goto(review.url());
      await fresh.waitForSelector('.review-table');
      assert.equal(await fresh.locator('.review-cards .chip').count(), deck);
      await fresh.goto(`${world.url}/game/0123456789abcdef`);
      await fresh.waitForSelector('.review .notice');
      assert.match(await fresh.locator('.review').innerText(), /isn’t in the records/);
      await fresh.goto(`${world.url}/profile`);
      await fresh.waitForSelector('.history .games');
      assert.equal(await fresh.locator('.review-link').getAttribute('href'), new URL(review.url()).pathname);
      await fresh.goto(world.url);
      await fresh.getByRole('tab', { name: 'Leaderboard' }).click();
      const board = await Promise.all((await fresh.locator('.board-list li').all()).map(text));
      assert.ok(board.some((row) => /Bots all bots/.test(row)) && board.some((row) => /Ming you/.test(row)), `the leaderboard has the player and the bots: ${board}`);

      assert.deepEqual(world.problems, []);
    } finally {
      await world.close();
    }
  });
}
