// Does the game page fit the window? On a desktop nothing should scroll but the
// log. One game is put through its main states and measured at several window
// sizes, with the hand as tall as it gets and the declaring form open.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { newGame, seating, setup, shot, startGame, sync } from './lib/harness.mjs';

const SIZES = [[1200, 640], [1280, 650], [1366, 650], [1280, 720], [1536, 730], [1440, 800], [1920, 950]];

const measure = (page) =>
  page.evaluate(() => {
    const over = (selector) => {
      const el = document.querySelector(selector);
      return el ? el.scrollHeight - el.clientHeight : 0;
    };
    const doc = document.documentElement;
    const log = document.querySelector('.log');
    return { page: doc.scrollHeight - doc.clientHeight, sideways: doc.scrollWidth - doc.clientWidth, hand: over('.hand'), action: over('.action'), log: log ? Math.round(log.getBoundingClientRect().height) : null };
  });

for (const deck of [54, 72]) {
  test(`the game page fits one screen: four a side, sets of ${deck / 9}`, async () => {
    const world = await setup();
    try {
      const page = await world.open('Ming');
      const room = await newGame(world, page, { orange: 3, purple: 4, deck });
      await startGame(page);
      const { game, human, mine, mates, foes } = seating(room);
      const misfits = [];
      const sweep = async (state) => {
        for (const [width, height] of SIZES) {
          await page.setViewportSize({ width, height });
          await page.waitForTimeout(100);
          const m = await measure(page);
          const bad = [];
          if (m.page > 0) bad.push(`the page scrolls ${m.page}px`);
          if (m.sideways > 0) bad.push(`sideways by ${m.sideways}px`);
          if (m.hand > 0) bad.push(`the hand scrolls ${m.hand}px`);
          if (m.action > 0) bad.push(`the move panel scrolls ${m.action}px`);
          if (m.log !== null && m.log < 44) bad.push(`the log is only ${m.log}px tall`);
          if (bad.length) misfits.push(`${state} at ${width}x${height}: ${bad.join(', ')}`);
          if (width === 1280 && height === 650) await shot(page, `fit-${deck}-${state}`, { fullPage: false });
        }
      };
      const turn = async (id) => {
        game.turn = id;
        await sync(world, room, page);
      };

      // A card from every set, so the hand is as tall as it gets: nine trays...
      for (const set of game.sets) {
        if (set.cards.some((card) => game.hands.get(human.id).has(card))) continue;
        const [from, hand] = [...game.hands].find(([, cards]) => set.cards.some((card) => cards.has(card)));
        const card = set.cards.find((c) => hand.has(c));
        game.hands.get(from).delete(card);
        game.hands.get(human.id).add(card);
      }
      // ...except for one set, held entirely by the other team, to declare from their hands.
      const target = game.sets[1];
      for (const card of target.cards) for (const id of [human.id, ...mates]) if (game.hands.get(id).delete(card)) game.hands.get(foes[0]).add(card);

      await turn(foes[0]);
      await sweep('waiting');
      await turn(mates[0]);
      await sweep('a-teammates-turn');
      await turn(human.id);
      await sweep('asking');
      await page.locator('.hand .card.pickable').first().click();
      await page.locator('.ask-line button.pill:not(:disabled)').first().click();
      await sweep('ready-to-ask');
      await page.getByRole('tab', { name: 'Chat' }).click();
      await sweep('chat-open');
      await page.getByRole('tab', { name: 'Game log' }).click();

      await page.getByRole('tab', { name: 'Declare' }).click();
      await sweep('declare-nothing-picked');
      await page.getByRole('button', { name: target.name, exact: true }).click();
      await page.locator('.declare .ask-line').getByRole('button', { name: 'The other team' }).click();
      await sweep('declaring-from-the-other-team');
      const own = game.sets.find((set) => set !== target && !set.claimedBy);
      await page.getByRole('button', { name: own.name, exact: true }).click();
      await sweep('declaring-from-your-team');

      // Declared wrongly, for the longest announcement: every card, with who really had it.
      await page.getByRole('button', { name: target.name, exact: true }).click();
      await page.locator('.declare .ask-line').getByRole('button', { name: 'The other team' }).click();
      const rows = await page.locator('.assign .pills').count();
      for (let i = 0; i < rows; i++) await page.locator('.assign .pills').nth(i).locator('button.pill:not(:disabled)').nth(1).click();
      await page.getByRole('button', { name: `Declare ${target.name}` }).click();
      await page.waitForFunction(() => /declared/.test(document.querySelector('.banner')?.innerText ?? ''));
      await sweep('after-a-wrong-declaration');

      // Game over.
      for (const set of game.sets) set.claimedBy ??= mine;
      for (const hand of game.hands.values()) hand.clear();
      Object.assign(game, { phase: 'finished', turn: null, winner: mine });
      game.score[mine] = 9 - game.score[mine === 'A' ? 'B' : 'A'];
      await sync(world, room, page);
      await page.waitForSelector('.result');
      await sweep('finished');

      assert.deepEqual(misfits, []);
      assert.deepEqual(world.problems, []);
    } finally {
      await world.close();
    }
  });
}
