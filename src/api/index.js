'use strict';
require('dotenv').config();
const express = require('express');
const path = require('path');

const { recommend } = require('../recommend/profile');
const { applyDisplayScores } = require('../recommend/score');

const app = express();
const PORT = process.env.PORT || 3000;

// ---- In-memory cache: avoids hammering AniList on repeat lookups
const cache = new Map();
const TTL_MS = 30 * 60 * 1000; // 30 minutes

function cacheGet(key) {
    const hit = cache.get(key);
    if (!hit) return null;
    if (Date.now() > hit.exp) { cache.delete(key); return null; }
    return hit.data;
}
function cacheSet(key, data) {
    cache.set(key, { data, exp: Date.now() + TTL_MS });
}

// ---- Static frontend
app.use(express.static(path.join(__dirname, '../../client')));

// ---- Health check (useful for deployment later)
app.get('/api/health', (_req, res) => res.json({ ok: true }));

// ---- Core recommendation endpoint
app.get('/api/recommend/:username', async (req, res) => {
    const username = req.params.username.trim();
    if (!username) {
        return res.status(400).json({ error: 'Username required', code: 'BAD_REQUEST' });
    }

    const key = username.toLowerCase();
    const cached = cacheGet(key);
    if (cached) return res.json({ ...cached, cached: true });

    try {
        const raw = await recommend(username);
        const results = applyDisplayScores(raw);
        const payload = {
            username,
            results,
            count: results.length,
            generatedAt: new Date().toISOString(),
            cached: false,
        };
        cacheSet(key, payload);
        res.json(payload);
    } catch (err) {
        const statusMap = {
            USER_NOT_FOUND: 404,
            PRIVATE_LIST: 403,
            EMPTY_LIST: 422,
            INSUFFICIENT_DATA: 422,
            NO_RESULTS: 422,
        };
        const status = statusMap[err.code] || 500;
        console.error(`[api] ${err.code || 'ERROR'}: ${err.message}`);
        res.status(status).json({ error: err.message, code: err.code || 'SERVER_ERROR' });
    }
});

// ---- SPA fallback (keeps future client-side routing working)
app.get('/{*path}', (_req, res) => {
    res.sendFile(path.join(__dirname, '../../client/index.html'));
});

app.listen(PORT, () => {
    console.log(`[api] http://localhost:${PORT}`);
});