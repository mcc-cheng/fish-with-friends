import path from 'node:path';
import { createApp } from './app.js';

// Ratings and the record of finished games are the only things kept on disk.
// Point DATA_DIR at a persistent volume when hosting.
const dataDir = path.resolve(process.env.DATA_DIR ?? 'data');
const app = createApp({ dataDir });
const port = await app.listen(Number(process.env.PORT) || 3000, process.env.HOST);
console.log(`Fish is running at http://localhost:${port}`);
console.log(`Ratings and game history are saved in ${dataDir}`);
