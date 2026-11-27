// The clock: choosing the times before the game, the countdown on a move, the
// time bank, losing the turn when both run out, and the tones that go with it.
// The server's "second" is short here, so the whole thing takes a few real ones.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addBots, overflow, setup, shot, startGame, text, tones, turnTo } from './lib/harness.mjs';

const SECOND = 300; // ms to a clock second: 20 s a move is 6 s of real time, a 15 s bank is 4.5 s

const seconds = (shown) => {
  const [m, s] = shown.replace('+', '').split(':').map(Number);
  return m * 60 + s;
};

test('the clock: set before the game, counted down on the page, and the turn lost when it runs out', async () => {
  const world = await setup({ secondMs: SECOND });
  try {
    const host = await world.open('Ming');
    const guest = await world.open('Priya');
    await host.goto(world.url);
    await host.getByRole('button', { name: 'Create a game' }).click();
    await host.waitForSelector('.setup');
    const code = new URL(host.url()).pathname.slice(1);
    await guest.goto(`${world.url}/${code}`);
    await guest.waitForSelector('.setup');

    // ---- setting the clock before the game
    const move = host.getByLabel('Time per move');
    const bank = host.getByLabel('Time bank');
    const chosen = (select) => select.evaluate((el) => el.selectedOptions[0].textContent);
    assert.deepEqual([await chosen(move), await chosen(bank)], ['1 minute', '2 minutes'], 'the defaults');
    assert.equal(await guest.locator('select').count(), 0, 'a guest has no dropdowns');
    await move.selectOption({ label: 'No limit' });
    await host.waitForFunction(() => document.querySelectorAll('.select-field select')[1].disabled);
    await guest.waitForFunction(() => document.querySelector('.clock-summary')?.innerText === 'No time limit');
    await move.selectOption({ label: '20 seconds' });
    await host.waitForFunction(() => !document.querySelectorAll('.select-field select')[1].disabled);
    await bank.selectOption({ label: '15 seconds' });
    await guest.waitForFunction(() => /20 seconds a move/.test(document.querySelector('.clock-summary')?.innerText ?? ''));
    assert.deepEqual([await chosen(move), await chosen(bank)], ['20 seconds', '15 seconds'], 'the dropdowns keep what was chosen');

    // ---- a game: Ming and a bot against Priya and a bot
    await addBots(host, 'Orange', 1);
    await addBots(host, 'Purple', 1);
    await host.waitForFunction(() => document.querySelectorAll('.roster li:not(.empty)').length === 4);
    await startGame(host);
    await guest.waitForSelector('.game');
    const room = world.rooms.rooms.get(code);
    const game = room.game;
    const members = [...room.members.values()];
    const me = members.find((member) => member.name === 'Ming');
    const bots = members.filter((member) => member.isBot);

    await turnTo(world, room, host, bots[0].id);
    assert.equal(await host.locator('.clock').count(), 0, 'no clock while a bot is to move');
    await tones(host);

    // ---- the turn comes to Ming: a countdown in three places, and a tone
    await turnTo(world, room, host, me.id);
    await host.waitForSelector('.banner > .clock');
    for (const place of ['.banner > .clock', '.action-head > .clock', '.seat.turn .clock']) assert.equal(await host.locator(place).count(), 1, `a countdown at ${place}`);
    assert.equal(await guest.locator('.banner > .clock').count(), 1, 'the other player sees it in the banner');
    assert.equal(await guest.locator('.action-head > .clock').count(), 0, '...but not as their own move');
    // Two rising notes for the turn. The warning (a double beep) is for the last ten real seconds
    // of a move, and with seconds this short the whole move is inside them, so it follows at once.
    await host.waitForTimeout(400);
    assert.deepEqual(await tones(host), [659, 880, 440, 440], 'a tone when the turn arrives, and a warning when time is short');
    assert.deepEqual(await tones(guest), [], 'and nothing for the player whose turn it isn’t');
    const read = async () => ({
      move: await host.locator('.banner .clock-move').innerText(),
      bank: await host.locator('.banner .clock-bank').innerText(),
      onBank: await host.locator('.banner > .clock').evaluate((el) => el.classList.contains('on-bank')),
    });
    const t0 = await read();
    assert.ok(seconds(t0.move) >= 5 && seconds(t0.move) <= 6 && t0.bank === '+0:05' && !t0.onBank, `six real seconds for the move, the bank untouched: ${JSON.stringify(t0)}`);
    await shot(host, 'clock-1-my-move', { fullPage: false });
    await host.waitForTimeout(1300);
    const t1 = await read();
    assert.ok(seconds(t1.move) < seconds(t0.move) && t1.bank === t0.bank, 'the move time counts down between the server’s messages; the bank waits');

    // ---- the time bank, with a warning tone on the way into it and another as it runs low
    await host.waitForFunction(() => document.querySelector('.banner > .clock')?.classList.contains('on-bank'), null, { timeout: 8000 });
    const t2 = await read();
    assert.ok(t2.move === '0:00' && seconds(t2.bank) <= 5, `then the bank runs down: ${JSON.stringify(t2)}`);
    assert.ok((await host.locator('.action-head > .clock').innerText()).startsWith('+'), 'the short clock switches to the bank');
    await host.waitForTimeout(300);
    assert.deepEqual(await tones(host), [440, 440], 'the warning sounds once more for the time bank, and only once');
    await shot(host, 'clock-2-on-the-bank', { fullPage: false });

    // ---- both gone: the turn is lost
    await host.waitForFunction(() => /ran out of time/.test(document.querySelector('.banner')?.innerText ?? ''), null, { timeout: 8000 });
    assert.match(await text(host.locator('.banner-text')), /^You ran out of time and lose the turn\./);
    assert.match(await host.locator('.log-list li').first().innerText(), /ran out of time/);
    assert.ok(game.turn !== me.id && room.members.get(game.turn).team !== me.team, 'the turn went to the other team');
    assert.equal(room.clock.bank.get(me.id), 0, 'the time bank is empty');
    assert.equal(await host.locator('.action-head > .clock').count(), 0, 'the Ask form is gone with the turn');

    // ---- with the sounds switched off, the next turn arrives in silence
    await host.getByRole('button', { name: 'Turn the sounds off' }).click();
    await tones(host);
    await turnTo(world, room, host, bots[0].id);
    await turnTo(world, room, host, me.id);
    assert.equal((await read()).bank, '+0:00', 'the empty bank shows on the next turn');
    assert.deepEqual(await tones(host), [], 'no tone once the sounds are off');
    await host.reload();
    await host.waitForSelector('.game');
    assert.equal(await host.getByRole('button', { name: 'Turn the sounds on' }).count(), 1, 'and they stay off after a reload');

    // ---- moving in time costs nothing
    await host.locator('.hand .card.pickable').first().click();
    await host.locator('.ask-line button.pill:not(:disabled)').first().click();
    await host.locator('.ask > .btn.primary').click();
    await host.waitForFunction(() => /asked/.test(document.querySelector('.banner')?.innerText ?? ''));
    assert.equal(game.log.at(-1).type, 'ask', 'a move made in time goes through');
    assert.ok((await overflow(host)) <= 0, 'no sideways scrolling');
    assert.deepEqual(world.problems, []);
  } finally {
    await world.close();
  }
});
