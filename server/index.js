import path from 'node:path';
import { createApp } from './app.js';

// Ratings are the only thing kept on disk. Point DATA_DIR at a persistent volume when hosting.
const ratingsFile = path.resolve(process.env.DATA_DIR ?? 'data', 'ratings.json');
const app = createApp({ ratingsFile });
const port = await app.listen(Number(process.env.PORT) || 3000, process.env.HOST);
console.log(`Fish is running at http://localhost:${port}`);
console.log(`Ratings are saved in ${ratingsFile}`);
