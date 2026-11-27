// The things around a game: the room's chat, a server restart in the middle of
// a game, and taking a profile to another device.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { DESK, PHONE, addBots, newGame, overflow, seating, setup, shot, startGame, text } from './lib/harness.mjs';

const chatLines = async (page) => Promise.all((await page.locator('.chat-list li').all()).map(text));

async function say(page, words) {
  await page.getByLabel('Message').fill(words);
  await page.getByLabel('Message').press('Enter');
}

test('the room’s chat: beside the teams before the game, and on a tab by the log during it', async () => {
  const world = await setup();
  try {
    const host = await world.open('Ming');
    const guest = await world.open('Priya', PHONE);
    await host.goto(world.url);
    await host.getByRole('button', { name: 'Create a game' }).click();
    await host.waitForSelector('.setup');
    const code = new URL(host.url()).pathname.slice(1);
    await guest.goto(`${world.url}/${code}`);
    await guest.waitForSelector('.setup');

    // ---- waiting for players: everyone in the room sees what is said, in their team's colour
    assert.deepEqual(await chatLines(host), ['Nobody has said anything yet.']);
    await say(host, 'shall we start?');
    await guest.waitForFunction(() => /shall we start/.test(document.querySelector('.chat-list')?.innerText ?? ''));
    await host.waitForTimeout(800); // (one message at a time: the server holds a second one back for a moment)
    await say(guest, 'one more bot first');
    for (const page of [host, guest]) await page.waitForFunction(() => /one more bot/.test(document.querySelector('.chat-list')?.innerText ?? ''));
    assert.deepEqual(await chatLines(host), ['Ming: shall we start?', 'Priya: one more bot first']);
    assert.deepEqual(await chatLines(guest), await chatLines(host));
    assert.equal(await host.locator('.chat-list .who.team-A').innerText(), 'Ming');
    assert.equal(await host.locator('.chat-list .who.team-B').innerText(), 'Priya');
    // On a wide screen the chat sits beside the teams and rules, not below them.
    const beside = await host.evaluate(() => document.querySelector('.room-chat').getBoundingClientRect().left > document.querySelector('.teams').getBoundingClientRect().right);
    assert.ok(beside, 'the chat is in a column of its own on a laptop');
    assert.ok((await overflow(host)) <= 0 && (await overflow(guest)) <= 0, 'no sideways scrolling');
    await shot(host, 'room-1-waiting');
    await shot(guest, 'room-1-waiting-phone');

    // ---- in the game: a tab beside the log, which counts what you haven't read
    await addBots(host, 'Orange', 1);
    await addBots(host, 'Purple', 1);
    await host.waitForFunction(() => document.querySelectorAll('.roster li:not(.empty)').length === 4);
    await startGame(host);
    await guest.waitForSelector('.game');
    assert.equal(await host.locator('.log-list').count(), 1, 'the log shows first');
    assert.equal(await host.locator('.log-tabs .tab-count').count(), 0);
    await guest.getByRole('tab', { name: 'Chat' }).click();
    assert.equal((await chatLines(guest)).length, 2, 'what was said before the game is still there');
    await guest.waitForTimeout(800);
    await say(guest, 'good luck');
    await host.waitForSelector('.log-tabs .tab-count');
    assert.equal(await host.locator('.log-tabs .tab-count').innerText(), '1', 'one unread message on the Chat tab');
    assert.equal(await host.locator('.toast').count(), 0, 'with the tab in view, the count is notice enough');
    await shot(host, 'room-2-unread', { fullPage: false });
    await host.getByRole('tab', { name: /^Chat/ }).click();
    assert.deepEqual((await chatLines(host)).at(-1), 'Priya: good luck');
    assert.equal(await host.locator('.log-tabs .tab-count').count(), 0, 'reading it clears the count');
    await host.waitForTimeout(800);
    await say(host, 'you too');
    await guest.waitForFunction(() => /you too/.test(document.querySelector('.chat-list')?.innerText ?? ''));
    assert.equal(await guest.locator('.log-tabs .tab-count').count(), 0, 'nothing is unread for someone looking at the chat');
    await shot(guest, 'room-2-chat-phone');
    // On a phone the tabs are a long way down the page: with the log showing and the top of the page in view, a message is shown as it arrives.
    await guest.getByRole('tab', { name: 'Game log' }).click();
    await guest.evaluate(() => scrollTo(0, 0));
    await host.waitForTimeout(800);
    await say(host, 'your turn soon');
    await guest.waitForSelector('.toast');
    assert.equal(await guest.locator('.toast').innerText(), 'Ming: your turn soon');

    // Typing a space in the chat is typing, not pressing Next for a bot.
    const room = world.rooms.rooms.get(code);
    const position = room.game.log.length;
    await host.getByLabel('Message').fill('');
    await host.getByLabel('Message').press('Space');
    await host.waitForTimeout(200);
    assert.equal(room.game.log.length, position);

    // A reload brings the conversation back.
    await host.reload();
    await host.waitForSelector('.game');
    await host.getByRole('tab', { name: 'Chat' }).click();
    assert.equal((await chatLines(host)).length, 5);
    assert.deepEqual(world.problems, []);
  } finally {
    await world.close();
  }
});

test('a server restart in the middle of a game: the page reconnects and the game carries on', async (t) => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'fish-e2e-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const world = await setup({ dataDir });
  try {
    const page = await world.open('Ming');
    let room = await newGame(world, page, { orange: 1, purple: 2 });
    const code = room.code;
    await startGame(page);
    // Some moves, until the turn comes round to the player. (Every seat plays as a bot would here. The turn
    // can't simply be handed over: a restart plays the game back from its moves, and would not know of it.)
    const { human } = seating(room);
    for (let moves = 0; moves < 300 && (room.game.log.length < 6 || room.game.turn !== human.id); moves++) world.rooms.moveBot(room, room.game.turn);
    assert.equal(room.game.turn, human.id);
    world.rooms.broadcast(room);
    await page.waitForSelector('.action.mine');
    const before = {
      hand: await page.locator('.hand .card:not(.ghost)').count(),
      log: await page.locator('.log-list li').count(),
      banner: await text(page.locator('.banner-text')),
      seats: await Promise.all((await page.locator('.seat').all()).map(text)),
    };
    assert.ok(before.log >= 6 && before.hand > 0);

    // ---- the server goes down and comes back
    const reconnected = await world.restart();
    await page.waitForSelector('.statusbar');
    assert.match(await page.locator('.statusbar').innerText(), /Reconnecting/);
    await shot(page, 'room-3-server-down', { fullPage: false });
    await page.waitForSelector('.statusbar', { state: 'detached', timeout: 15_000 });
    reconnected();
    await page.waitForSelector('.action.mine');
    assert.equal(new URL(page.url()).pathname, `/${code}`, 'still in the same game');
    const after = {
      hand: await page.locator('.hand .card:not(.ghost)').count(),
      log: await page.locator('.log-list li').count(),
      banner: await text(page.locator('.banner-text')),
      seats: await Promise.all((await page.locator('.seat').all()).map(text)),
    };
    // (the clock starts the move afresh, so the seat that is to play may read a second differently)
    const steady = (seats) => seats.map((seat) => seat.replace(/\d:\d\d/g, ''));
    assert.deepEqual({ ...after, seats: steady(after.seats) }, { ...before, seats: steady(before.seats) }, 'the same cards, the same log, the same turn');

    // ---- and it is still a game: the player's move goes through on the new server
    room = world.rooms.rooms.get(code);
    assert.notEqual(room, undefined);
    await page.locator('.hand .card.pickable').first().click();
    await page.locator('.ask-line button.pill:not(:disabled)').first().click();
    await page.locator('.ask > .btn.primary').click();
    await page.waitForFunction((n) => document.querySelectorAll('.log-list li').length === n + 1, before.log);
    assert.equal(room.game.log.length, before.log + 1);
    assert.deepEqual(world.problems, []);
  } finally {
    await world.close();
  }
});

test('a profile moves to another device with a code', async () => {
  const world = await setup();
  try {
    // On the laptop: a game played against bots, so there is something to carry across.
    const laptop = await world.open('Ming', DESK);
    const room = await newGame(world, laptop, { orange: 1, purple: 2 });
    await startGame(laptop);
    for (let guard = 0; room.game.phase === 'playing' && guard < 5000; guard++) world.rooms.moveBot(room, room.game.turn);
    world.rooms.settleGame(room);
    world.rooms.broadcast(room);
    await laptop.waitForSelector('.result');
    await laptop.goto(`${world.url}/profile`);
    await laptop.waitForSelector('.history .games');
    const mine = { rating: await laptop.locator('.stat-value').first().innerText(), games: await laptop.locator('.history tbody tr').count() };
    assert.equal(mine.games, 1);
    assert.notEqual(mine.rating, '1000');

    await laptop.getByRole('button', { name: 'Get a code' }).click();
    await laptop.waitForSelector('.link-code');
    const code = await laptop.locator('.link-code').innerText();
    assert.match(code, /^[A-Z2-9]{4} [A-Z2-9]{4}$/);
    assert.match(await laptop.locator('.link-panel').innerText(), /Works once, within 10 minutes/);
    await shot(laptop, 'room-4-code');

    // On the phone: a different player, until the code is typed in.
    const phone = await world.open('Guest 4321', PHONE);
    const questions = [];
    phone.on('dialog', (dialog) => {
      questions.push(dialog.message());
      dialog.accept();
    });
    await phone.goto(`${world.url}/profile`);
    await phone.waitForSelector('.link-panel');
    assert.equal(await phone.locator('.history tbody tr').count(), 0);
    await phone.getByLabel('Code from your other device').fill('nope');
    await phone.getByRole('button', { name: 'Use this code' }).click();
    await phone.waitForSelector('.toast.bad');
    assert.match(await phone.locator('.toast').innerText(), /eight letters and numbers/);
    assert.deepEqual(questions, [], 'nothing is asked until the code looks like one');
    assert.ok((await overflow(phone)) <= 0, 'no sideways scrolling on the phone');
    await shot(phone, 'room-4-phone-before');

    await phone.getByLabel('Code from your other device').fill(code.toLowerCase());
    await Promise.all([phone.waitForEvent('load'), phone.getByRole('button', { name: 'Use this code' }).click()]);
    assert.equal(questions.length, 1);
    assert.match(questions[0], /Switch this browser to the profile that code came from\?$/, 'with no games of its own, there is nothing to warn about');
    await phone.waitForSelector('.history .games');
    assert.match(await phone.locator('.toast').innerText(), /now plays as the profile from your other device/);
    assert.equal(await phone.locator('.topbar .me').innerText(), 'Ming', 'the name came across');
    assert.equal(await phone.locator('.stat-value').first().innerText(), mine.rating, 'and the rating');
    assert.equal(await phone.locator('.history tbody tr').count(), 1, 'and the games');
    await shot(phone, 'room-4-phone-after');

    // The code is spent: a third browser can't use it.
    const other = await world.open('Someone else');
    other.on('dialog', (dialog) => dialog.accept());
    await other.goto(`${world.url}/profile`);
    await other.waitForSelector('.link-panel');
    await other.getByLabel('Code from your other device').fill(code);
    await other.getByRole('button', { name: 'Use this code' }).click();
    await other.waitForSelector('.toast.bad');
    assert.match(await other.locator('.toast').innerText(), /isn’t right, or it has run out/);
    assert.equal(await other.locator('.topbar .me').innerText(), 'Someone else');
    assert.deepEqual(world.problems, []);
  } finally {
    await world.close();
  }
});
