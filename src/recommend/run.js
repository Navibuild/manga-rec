'use strict';
require('dotenv').config();
const pool = require('../db/pool');
const { recommend } = require('./profile');
const { applyDisplayScores } = require('./score');

async function main() {
    const username = process.argv[2];
    if (!username) {
        console.error('Usage: node src/recommend/run.js <AniList username>');
        process.exit(1);
    }

    console.log(`\nFetching recommendations for "${username}"...\n`);

    try {
        const raw = await recommend(username);
        const results = applyDisplayScores(raw);
        console.log(`Top ${results.length} recommendations:\n`);

        results.forEach((r, i) => {
            const title = r.title_english || r.title_romaji;
            const pct = `${r.match_pct}%`;
            const because = r.because_of
                ? (r.because_of.title_english || r.because_of.title_romaji)
                : '—';
            const genres = r.genres.slice(0, 3).join(', ');

            console.log(`${String(i + 1).padStart(2)}. [${pct}] ${title}`);
            console.log(`     because: ${because}  |  ${genres}\n`);
        });
    } catch (err) {
        if (err.code) {
            console.error(`Error (${err.code}): ${err.message}`);
        } else {
            console.error('Unexpected error:', err.message);
        }
        process.exitCode = 1;
    } finally {
        await pool.end();
    }
}

main();