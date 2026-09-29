import { Hono } from 'hono';
import { serveStatic } from 'hono/cloudflare-workers';
import { getNeonClient } from '../db/neon-client.js';
import { applyDisplayScores } from '../recommend/score.js';
import { recommend, recommendFromEntries } from '../recommend/profile.js';

const app = new Hono();

// In-memory cache (per Worker instance, resets on cold start — fine for this)
const cache = new Map();
const TTL_MS = 30 * 60 * 1000;

function cacheGet(key) {
    const hit = cache.get(key);
    if (!hit) return null;
    if (Date.now() > hit.exp) { cache.delete(key); return null; }
    return hit.data;
}
function cacheSet(key, data) {
    cache.set(key, { data, exp: Date.now() + TTL_MS });
}

app.get('/api/health', (c) => c.json({ ok: true }));

app.get('/api/recommend/:username', async (c) => {
    const username = c.req.param('username').trim();
    if (!username) {
        return c.json({ error: 'Username required', code: 'BAD_REQUEST' }, 400);
    }

    const key = username.toLowerCase();
    const cached = cacheGet(key);
    if (cached) return c.json({ ...cached, cached: true });

    const db = getNeonClient(c.env.DATABASE_URL);

    try {
        const raw = await recommend(username, db);
        const results = applyDisplayScores(raw);
        const payload = {
            username,
            results,
            count: results.length,
            generatedAt: new Date().toISOString(),
            cached: false,
        };
        cacheSet(key, payload);
        return c.json(payload);
    } catch (err) {
        const statusMap = {
            USER_NOT_FOUND: 404,
            PRIVATE_LIST: 403,
            EMPTY_LIST: 422,
            INSUFFICIENT_DATA: 422,
            NO_RESULTS: 422,
        };
        const status = statusMap[err.code] || 500;
        return c.json({ error: err.message, code: err.code || 'SERVER_ERROR' }, status);
    }
});
app.post('/api/recommend', async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body?.username || !body?.entries || !body?.scoreFormat) {
        return c.json({ error: 'Invalid payload', code: 'BAD_REQUEST' }, 400);
    }

    const key = body.username.toLowerCase();
    const cached = cacheGet(key);
    if (cached) return c.json({ ...cached, cached: true });

    const db = getNeonClient(c.env.DATABASE_URL);

    try {
        const raw = await recommendFromEntries(body.username, body.scoreFormat, body.entries, db);
        const results = applyDisplayScores(raw);
        const payload = {
            username: body.username,
            results,
            count: results.length,
            generatedAt: new Date().toISOString(),
            cached: false,
        };
        cacheSet(key, payload);
        return c.json(payload);
    } catch (err) {
        const statusMap = {
            USER_NOT_FOUND: 404,
            PRIVATE_LIST: 403,
            EMPTY_LIST: 422,
            INSUFFICIENT_DATA: 422,
            NO_RESULTS: 422,
        };
        const status = statusMap[err.code] || 500;
        return c.json({ error: err.message, code: err.code || 'SERVER_ERROR' }, status);
    }
});

// Serve static frontend for everything else
app.get('/*', serveStatic({ root: './' }));

export default app;