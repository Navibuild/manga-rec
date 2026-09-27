'use strict';
require('dotenv').config();

// ============================================================
//  TUNABLES
// ============================================================
const CONFIG = {
    // --- AniList API ---
    ENDPOINT: process.env.ANILIST_ENDPOINT || 'https://graphql.anilist.co',
    RPM: Number(process.env.ANILIST_RPM || 25),   // stay under the degraded 30/min ceiling
    PAGE_SIZE: Number(process.env.ANILIST_PAGE_SIZE || 25), // raise to 50 if pages come back clean

    // --- Corpus bounds ---
    MAX_TITLES: Number(process.env.MAX_TITLES || 30000), // sorted by popularity, so this is "top N"
    MAX_PAGES: Number(process.env.MAX_PAGES || 5000),   // hard safety stop

    // --- Retry behaviour ---
    MAX_RETRIES: 5,
    BACKOFF_BASE_MS: 2000,
    BACKOFF_MAX_MS: 60000,
    REQUEST_TIMEOUT_MS: 45000,

    // --- Storage ---
    RAW_DIR: process.env.RAW_DUMP_DIR || './data/raw',
    DATABASE_URL: process.env.DATABASE_URL,

    // --- Politeness ---
    USER_AGENT: 'manga-rec/0.1 (github.com/Navibuild)',
};
// ============================================================

CONFIG.MIN_INTERVAL_MS = Math.ceil(60000 / CONFIG.RPM);

module.exports = CONFIG;