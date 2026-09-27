'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const CONFIG = require('../config');
const pool = require('../db/pool');
const { request, MEDIA_PAGE_QUERY } = require('./client');

const KIND = 'media';

const pagePath = (n) =>
    path.join(CONFIG.RAW_DIR, `media-p${String(n).padStart(5, '0')}.json.gz`);

function writePage(n, payload) {
    const gz = zlib.gzipSync(Buffer.from(JSON.stringify(payload), 'utf8'));
    fs.writeFileSync(pagePath(n), gz);
}

function readPage(n) {
    return JSON.parse(zlib.gunzipSync(fs.readFileSync(pagePath(n))).toString('utf8'));
}

async function openRun(fresh) {
    if (!fresh) {
        const { rows } = await pool.query(
            `SELECT * FROM crawl_runs
        WHERE kind = $1 AND status IN ('running','paused','failed')
        ORDER BY started_at DESC LIMIT 1`,
            [KIND]
        );
        if (rows.length) {
            const run = rows[0];
            await pool.query(`UPDATE crawl_runs SET status='running', error=NULL WHERE id=$1`, [run.id]);
            console.log(`[run] resuming run #${run.id} from page ${(run.last_page || 0) + 1}`);
            return run;
        }
    }
    const { rows } = await pool.query(
        `INSERT INTO crawl_runs (kind, status) VALUES ($1,'running') RETURNING *`,
        [KIND]
    );
    console.log(`[run] started run #${rows[0].id}`);
    return rows[0];
}

async function main() {
    const fresh = process.argv.includes('--fresh');
    fs.mkdirSync(CONFIG.RAW_DIR, { recursive: true });

    const run = await openRun(fresh);
    let page = (run.last_page || 0) + 1;
    let seen = run.items_seen || 0;

    let stopping = false;
    process.on('SIGINT', () => {
        console.log('\n[run] stopping after current page...');
        stopping = true;
    });

    try {
        for (; page <= CONFIG.MAX_PAGES; page++) {
            if (stopping) break;
            if (seen >= CONFIG.MAX_TITLES) {
                console.log(`[run] reached MAX_TITLES (${CONFIG.MAX_TITLES})`);
                break;
            }

            let data;
            let cached = false;

            if (fs.existsSync(pagePath(page))) {
                data = readPage(page);
                cached = true;
            } else {
                data = await request(MEDIA_PAGE_QUERY, { page, perPage: CONFIG.PAGE_SIZE });
                writePage(page, data);
            }

            const info = data.Page.pageInfo;
            const count = data.Page.media.length;
            seen += count;

            await pool.query(
                `UPDATE crawl_runs
            SET last_page=$1, items_seen=$2, pages_total=$3
          WHERE id=$4`,
                [page, seen, info.lastPage || null, run.id]
            );

            console.log(
                `[page ${page}${info.lastPage ? '/' + info.lastPage : ''}] ` +
                `${count} titles${cached ? ' (cached)' : ''} -- ${seen} total`
            );

            if (!info.hasNextPage || count === 0) {
                console.log('[run] no further pages');
                break;
            }
        }

        const done = !stopping;
        await pool.query(
            `UPDATE crawl_runs SET status=$1, finished_at=now() WHERE id=$2`,
            [done ? 'done' : 'paused', run.id]
        );
        console.log(done ? `[run] complete -- ${seen} titles archived` : `[run] paused at page ${page}`);
    } catch (err) {
        await pool.query(
            `UPDATE crawl_runs SET status='failed', error=$1, finished_at=now() WHERE id=$2`,
            [String(err.message).slice(0, 2000), run.id]
        );
        console.error('[run] FAILED:', err.message);
        process.exitCode = 1;
    } finally {
        await pool.end();
    }
}

main();