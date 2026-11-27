// What every browser check starts from: the app running in this process, so a
// check can look at (and arrange) the game on the server, and a real browser
// to drive the pages with.
//
//   BROWSER  chrome (the default: the Google Chrome installed on this machine),
//            or chromium, webkit, firefox: Playwright's own builds, fetched once
//            with `npx playwright-core install webkit` and the like
//   THEME    light (the default) or dark
//   SHOTS    a folder to save screenshots in as the checks go; none are taken without it

import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { createApp } from '../../server/app.js';

let playwright;
try {
  playwright = await import('playwright-core');
} catch {
  throw new Error('The browser checks need Playwright, which is not installed yet. Run: npm install --save-dev playwright-core');
}

const ENGINE = process.env.BROWSER ?? 'chrome';
const SHOTS = process.env.SHOTS ? path.resolve(process.env.SHOTS) : null;
export const THEME = process.env.THEME === 'dark' ? 'dark' : 'light';

export const DESK = { viewport: { width: 1280, height: 800 } };
// Firefox has no phone mode, so there a phone is only a narrow window.
export const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, ...(ENGINE === 'firefox' ? null : { isMobile: true, hasTouch: true }) };

async function launch() {
  try {
    if (ENGINE === 'chrome') return await playwright.chromium.launch({ channel: 'chrome' });
    return await playwright[ENGINE].launch();
  } catch (error) {
    throw new Error(`Could not start the browser "${ENGINE}". The checks drive Google Chrome unless BROWSER says otherwise (see e2e/lib/harness.mjs).\n${error.message}`);
  }
}

/**
 * One check's world: the app on a free port, and a browser.
 *   open(name, size)  a page in a browser profile of its own, as another person on another device would have
 *   restart()         stops the server and starts it again on the same port, as a redeploy would
 *   problems          every page error and console error seen so far; a check ends by asserting it is empty
 *   close()
 * `options` go to createApp. Bots move quickly unless told otherwise.
 */
export async function setup(options = {}) {
  const settings = { botDelay: [50, 80], ...options };
  const browser = await launch();
  let app = createApp(settings);
  const port = await app.listen(0, '127.0.0.1');
  const problems = [];
  let restarting = false;
  const watch = (page) => {
    page.setDefaultTimeout(10_000);
    // While the server is down the browser complains about the connection it can't make: that is the point of the check.
    page.on('console', (message) => message.type() === 'error' && !restarting && problems.push(`console: ${message.text()}`));
    page.on('pageerror', (error) => problems.push(`page error: ${error.message}`));
  };
  return {
    url: `http://127.0.0.1:${port}`,
    problems,
    get rooms() {
      return app.rooms;
    },
    async open(name = 'Ming', size = DESK) {
      const context = await browser.newContext({ ...size, colorScheme: THEME });
      context.on('page', watch);
      await context.addInitScript((playerName) => {
        try {
          if (!localStorage.getItem('fish:name')) localStorage.setItem('fish:name', playerName);
        } catch {
          // The blank page a new tab starts on has no storage.
        }
        // Keep hold of every tone the page makes, so a check can tell that it played (and at what pitch).
        window.tones = [];
        for (const Audio of [window.AudioContext, window.webkitAudioContext]) {
          if (!Audio || Audio.prototype.listened) continue;
          const make = Audio.prototype.createOscillator;
          Audio.prototype.listened = true;
          Audio.prototype.createOscillator = function createOscillator() {
            const tone = make.call(this);
            window.tones.push(tone);
            return tone;
          };
        }
      }, name);
      return context.newPage();
    },
    async restart() {
      restarting = true;
      await app.close();
      app = createApp(settings);
      await app.listen(port, '127.0.0.1');
      return () => {
        restarting = false; // call once the pages have reconnected
      };
    },
    async close() {
      await browser.close();
      await app.close();
    },
  };
}

/** How far the page can be scrolled sideways, in pixels: it should be none. */
export const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

/** The pitches of the tones the page has played since this was last asked. */
export const tones = (page) => page.evaluate(() => window.tones.splice(0).map((tone) => Math.round(tone.frequency.value)));

export const text = async (locator) => (await locator.innerText()).replace(/\s+/g, ' ').trim();

export async function shot(page, name, { fullPage = true } = {}) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, `${THEME}-${name}.png`), fullPage });
}

export async function addBots(page, team, count) {
  const column = page.locator('.team-col', { hasText: team });
  for (let i = 0; i < count; i++) await column.getByRole('button', { name: '+ Add a bot' }).click();
}

/**
 * From the lobby, creates a game and fills it with bots: `orange` beside the
 * player and `purple` against them. Leaves the page on the waiting room and
 * returns the room as the server holds it.
 */
export async function newGame(world, page, { orange = 1, purple = 2, deck = 54 } = {}) {
  await page.goto(world.url);
  await page.getByRole('button', { name: 'Create a game' }).click();
  await page.waitForSelector('.setup');
  const code = new URL(page.url()).pathname.slice(1);
  if (deck === 72) await page.locator('.settings .option', { hasText: 'Nine sets of eight' }).click();
  await addBots(page, 'Orange', orange);
  await addBots(page, 'Purple', purple);
  await page.waitForFunction((n) => document.querySelectorAll('.roster li:not(.empty)').length === n, 1 + orange + purple);
  return world.rooms.rooms.get(code);
}

export async function startGame(page) {
  await page.getByRole('button', { name: 'Start game' }).click();
  await page.waitForSelector('.game');
}

/** Who is who at a table with one person at it: the game, the person, their teammates and their opponents. */
export function seating(room) {
  const game = room.game;
  const human = [...room.members.values()].find((member) => !member.isBot);
  const mine = game.seats.find((seat) => seat.id === human.id).team;
  return {
    game,
    human,
    mine,
    theirs: mine === 'A' ? 'B' : 'A',
    mates: game.seats.filter((seat) => seat.team === mine && seat.id !== human.id).map((seat) => seat.id),
    foes: game.seats.filter((seat) => seat.team !== mine).map((seat) => seat.id),
    nameOf: (id) => room.members.get(id).name,
  };
}

/** Sends everyone the room as it now stands: for after a check has rearranged the game by hand. */
export async function sync(world, room, page) {
  world.rooms.broadcast(room);
  await page.waitForTimeout(150);
}

/** Puts the turn with `id`, as if a move had just been made, so the clock starts afresh for them. */
export async function turnTo(world, room, page, id) {
  room.game.turn = id;
  if (room.clock) room.clock.key = null;
  await sync(world, room, page);
}
