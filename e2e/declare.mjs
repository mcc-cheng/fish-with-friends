// The declaring rule: a teammate may declare while the team has the turn, and a
// call may name the other team's players. Then the bots play the game out, to
// see that nothing sticks.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DESK, PHONE, newGame, overflow, seating, setup, shot, startGame, sync, text } from './lib/harness.mjs';

for (const [label, size] of [['a laptop', DESK], ['a phone', PHONE]]) {
  test(`declaring out of turn, and from the other team's hands: ${label}`, async () => {
    const world = await setup();
    const tag = size === PHONE ? 'phone' : 'desk';
    try {
      const page = await world.open('Ming', size);
      const room = await newGame(world, page, { orange: 3, purple: 4 });
      await startGame(page);
      const { game, human, mine, theirs, mates, foes, nameOf } = seating(room);
      const turn = async (id) => {
        game.turn = id;
        await sync(world, room, page);
      };
      /** Moves every card of `set` out of the given players' hands into `to`'s. */
      const moveSet = (set, from, to) => {
        for (const card of set.cards) for (const id of from) if (game.hands.get(id).delete(card)) game.hands.get(to).add(card);
      };
      const declareButton = page.getByRole('button', { name: 'Declare a set' });
      const sideRow = page.locator('.declare .ask-line');

      // ---- who may declare, as the turn moves around
      await turn(foes[0]);
      assert.equal(await declareButton.count(), 0, 'no Declare button while the other team has the turn');
      await turn(mates[0]);
      assert.equal(await declareButton.count(), 1, 'a Declare button while a teammate has the turn');

      // ---- a set held entirely by the other team, declared correctly out of turn
      const [first, second, third] = game.sets;
      moveSet(first, [human.id, ...mates], foes[0]);
      moveSet(second, [human.id], mates[1]); // the player holds none of the second set
      if (!third.cards.some((card) => game.hands.get(human.id).has(card))) {
        const from = game.seats.map((seat) => seat.id).find((id) => third.cards.some((card) => game.hands.get(id).has(card)));
        const card = third.cards.find((c) => game.hands.get(from).has(c));
        game.hands.get(from).delete(card);
        game.hands.get(human.id).add(card); // ...and at least one card of the third
      }
      await sync(world, room, page);

      await declareButton.click();
      await page.getByRole('button', { name: first.name, exact: true }).click();
      assert.equal(await sideRow.locator('.pill[aria-pressed="true"]').innerText(), 'Your team', 'the form starts on "Your team"');
      await sideRow.getByRole('button', { name: 'The other team' }).click();
      const offered = await page.locator('.assign-row').first().locator('.pill').allInnerTexts();
      assert.deepEqual(offered.sort(), foes.map(nameOf).sort(), 'each card offers the four opponents');
      assert.ok(await page.getByRole('button', { name: `Declare ${first.name}` }).isDisabled(), 'Declare waits until every card has a holder');
      const holderOf = (card) => [...game.hands].find(([, hand]) => hand.has(card))[0];
      for (const [i, card] of first.cards.entries()) await page.locator('.assign-row').nth(i).getByRole('button', { name: nameOf(holderOf(card)), exact: true }).click();
      assert.ok((await overflow(page)) <= 0, 'no sideways scrolling with the form open');
      await shot(page, `declare-${tag}-1-form`);
      const before = { ...game.score };
      await page.getByRole('button', { name: `Declare ${first.name}` }).click();
      await page.waitForFunction(() => /declared/.test(document.querySelector('.banner')?.innerText ?? ''));
      assert.match(await text(page.locator('.banner-text')), new RegExp(`^You declared ${first.name} from (Orange|Purple)’s hands\\. A set for (Orange|Purple)\\.`));
      assert.equal(game.score[mine], before[mine] + 1, 'the declaring team scored');
      assert.equal(game.turn, mates[0], 'the turn stayed with the teammate');
      assert.equal(await page.locator('.declare').count(), 0, 'the form closes after declaring');

      // ---- a wrong call on the other team: everything pinned on one opponent
      await declareButton.click();
      await page.getByRole('button', { name: second.name, exact: true }).click();
      await sideRow.getByRole('button', { name: 'The other team' }).click();
      for (let i = 0; i < second.cards.length; i++) await page.locator('.assign-row').nth(i).getByRole('button', { name: nameOf(foes[1]), exact: true }).click();
      await page.getByRole('button', { name: `Declare ${second.name}` }).click();
      await page.waitForFunction((name) => document.querySelector('.banner')?.innerText.includes(name), second.name);
      assert.match(await text(page.locator('.banner-text')), /^You misdeclared .+ from (Orange|Purple)’s hands\. The set goes to (Orange|Purple)\./);
      assert.equal(game.score[theirs], before[theirs] + 1, 'the other team scored');
      await shot(page, `declare-${tag}-2-misdeclared`);

      // ---- a set you hold part of can't be "all with the other team"
      await declareButton.click();
      await page.getByRole('button', { name: third.name, exact: true }).click();
      assert.ok(await sideRow.getByRole('button', { name: 'The other team' }).isDisabled());
      assert.ok((await page.locator('.assign-row .pill.locked').count()) >= 1, 'your own cards are filled in');

      // ---- the form goes away when the turn passes to the other team
      await turn(foes[2]);
      assert.equal(await page.locator('.declare').count(), 0);
      assert.equal(await declareButton.count(), 0);

      // ---- then the game is played out: the bots a press of Next at a time, the player declaring or asking
      await turn(foes[0]);
      for (let presses = 0; game.phase === 'playing' && presses < 1500; presses++) {
        // Each action below waits for its button, so the page is never ahead of itself;
        // afterwards, wait for the server to have made the move before looking at whose turn it is.
        const at = game.log.length;
        const moved = async () => {
          for (let tries = 0; tries < 250 && game.log.length === at; tries++) await page.waitForTimeout(20);
        };
        if (game.turn !== human.id) {
          await page.locator('.next-btn:not(:disabled)').click();
          await moved();
          continue;
        }
        await page.getByRole('tab', { name: 'Declare' }).click();
        const open = game.sets.find((set) => !set.claimedBy);
        await page.getByRole('button', { name: open.name, exact: true }).click();
        const cards = await page.locator('.assign-row').count();
        for (let i = 0; i < cards; i++) {
          const row = page.locator('.assign-row').nth(i);
          const pills = row.locator('button.pill:not(:disabled)');
          if ((await pills.count()) > 0 && (await row.locator('.pill[aria-pressed="true"]').count()) === 0) await pills.first().click();
        }
        const go = page.getByRole('button', { name: `Declare ${open.name}` });
        if (await go.isEnabled()) await go.click();
        else {
          // The rest of the set is with the other team: ask for a card instead.
          await page.getByRole('tab', { name: 'Ask' }).click();
          await page.locator('.hand .card.pickable').first().click();
          await page.locator('.ask-line button.pill:not(:disabled)').first().click();
          await page.locator('.ask > .btn.primary').click();
        }
        await moved();
      }
      assert.equal(game.phase, 'finished', 'the game played out to the end');
      await page.waitForSelector('.result');
      await shot(page, `declare-${tag}-3-end`);
      assert.deepEqual(world.problems, []);
    } finally {
      await world.close();
    }
  });
}
