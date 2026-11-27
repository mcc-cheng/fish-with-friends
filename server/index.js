import path from 'node:path';
import { createApp } from './app.js';

// Ratings, the record of finished games and the rooms open right now are kept
// on disk. Point DATA_DIR at a persistent volume when hosting.
const dataDir = path.resolve(process.env.DATA_DIR ?? 'data');
const app = createApp({ dataDir });
const port = await app.listen(Number(process.env.PORT) || 3000, process.env.HOST);
console.log(`Fish is running at http://localhost:${port}`);
console.log(`Ratings, game history and open games are saved in ${dataDir}`);

// Stopping the server (Ctrl+C, a redeploy, `npm run dev` restarting it) saves
// the rooms as they stand, so the next start carries on with the same games.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, async () => {
    await app.rooms.saved();
    process.exit(0);
  });
}
