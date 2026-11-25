import { createApp } from './app.js';

const app = createApp();
const port = await app.listen(Number(process.env.PORT) || 3000, process.env.HOST);
console.log(`Fish is running at http://localhost:${port}`);
