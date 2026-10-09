// Vercel serverless entry point — the whole Express API from server/index.mjs runs as one function.
// vercel.json rewrites every /api/* request here; Express still sees the original path.
import app from '../server/index.mjs';

export default app;
