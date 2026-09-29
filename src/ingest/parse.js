'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

require('dotenv').config();
const CONFIG = require('../config');

function stripHtml(str) {
    if (!str) return null;
    return str
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<[^>]*>/g, '')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#039;/g, "'")
        .trim() || null;
}

function getFiles() {
    return fs.readdirSync(CONFIG.RAW_DIR)
        .filter(f => /^media-p\d+\.json\.gz$/.test(f))
        .sort()
        .map(f => path.join(CONFIG.RAW_DIR, f));
}

function readGzip(filePath) {
    return JSON.parse(zlib.gunzipSync(fs.readFileSync(filePath)).toString('utf8'));
}

async function ingestPage(client, mediaList) {
    const tagMap = new Map();
    const genreNames = new Set();

    for (const m of mediaList) {
        for (const t of (m.tags || [])) tagMap.set(t.id, t);
        for (const g of (m.genres || [])) genreNames.add(g);
    }

    if (tagMap.size > 0) {
        const arr = [...tagMap.values()];
        await client.query(
            `INSERT INTO tags (id, name, category, description, is_adult)
       SELECT * FROM unnest($1::int[], $2::text[], $3::text[], $4::text[], $5::bool[])
         AS t(id, name, category, description, is_adult)
       ON CONFLICT (id) DO UPDATE SET
         name        = EXCLUDED.name,
         category    = EXCLUDED.category,
         description = EXCLUDED.description,
         is_adult    = EXCLUDED.is_adult`,
            [
                arr.map(t => t.id),
                arr.map(t => t.name),
                arr.map(t => t.category || null),
                arr.map(t => t.description || null),
                arr.map(t => t.isAdult || false),
            ]
        );
    }

    let genreIdMap = {};
    if (genreNames.size > 0) {
        const names = [...genreNames];
        await client.query(
            `INSERT INTO genres (name) SELECT unnest($1::text[]) ON CONFLICT (name) DO NOTHING`,
            [names]
        );
        const { rows } = await client.query(
            `SELECT id, name FROM genres WHERE name = ANY($1)`,
            [names]
        );
        genreIdMap = Object.fromEntries(rows.map(r => [r.name, r.id]));
    }

    const ids = mediaList.map(m => m.id);
    await client.query(`DELETE FROM media_tags             WHERE media_id   = ANY($1)`, [ids]);
    await client.query(`DELETE FROM media_genres           WHERE media_id   = ANY($1)`, [ids]);
    await client.query(`DELETE FROM media_relations        WHERE source_id  = ANY($1)`, [ids]);
    await client.query(`DELETE FROM media_recommendations  WHERE source_id  = ANY($1)`, [ids]);

    for (const m of mediaList) {
        await client.query(
            `INSERT INTO media (
         id, title_romaji, title_english, title_native,
         format, status, country_of_origin, description,
         average_score, mean_score, popularity, favourites,
         chapters, volumes,
         start_year, start_month, start_day,
         cover_image_url, banner_image_url, site_url,
         is_adult, fetched_at
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,
         $13,$14,$15,$16,$17,$18,$19,$20,$21,now()
       )
       ON CONFLICT (id) DO UPDATE SET
         title_romaji      = EXCLUDED.title_romaji,
         title_english     = EXCLUDED.title_english,
         title_native      = EXCLUDED.title_native,
         format            = EXCLUDED.format,
         status            = EXCLUDED.status,
         country_of_origin = EXCLUDED.country_of_origin,
         description       = EXCLUDED.description,
         average_score     = EXCLUDED.average_score,
         mean_score        = EXCLUDED.mean_score,
         popularity        = EXCLUDED.popularity,
         favourites        = EXCLUDED.favourites,
         chapters          = EXCLUDED.chapters,
         volumes           = EXCLUDED.volumes,
         start_year        = EXCLUDED.start_year,
         start_month       = EXCLUDED.start_month,
         start_day         = EXCLUDED.start_day,
         cover_image_url   = EXCLUDED.cover_image_url,
         banner_image_url  = EXCLUDED.banner_image_url,
         site_url          = EXCLUDED.site_url,
         is_adult          = EXCLUDED.is_adult,
         fetched_at        = now()`,
            [
                m.id,
                m.title?.romaji ?? null,
                m.title?.english ?? null,
                m.title?.native ?? null,
                m.format ?? null,
                m.status ?? null,
                m.countryOfOrigin ?? null,
                stripHtml(m.description),
                m.averageScore ?? null,
                m.meanScore ?? null,
                m.popularity ?? null,
                m.favourites ?? null,
                m.chapters ?? null,
                m.volumes ?? null,
                m.startDate?.year ?? null,
                m.startDate?.month ?? null,
                m.startDate?.day ?? null,
                m.coverImage?.extraLarge || m.coverImage?.large || null,
                m.bannerImage ?? null,
                m.siteUrl ?? null,
                m.isAdult || false,
            ]
        );

        for (const tag of (m.tags || [])) {
            await client.query(
                `INSERT INTO media_tags
           (media_id, tag_id, rank, is_general_spoiler, is_media_spoiler)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT DO NOTHING`,
                [m.id, tag.id, tag.rank ?? null,
                tag.isGeneralSpoiler || false,
                tag.isMediaSpoiler || false]
            );
        }

        for (const name of (m.genres || [])) {
            const gid = genreIdMap[name];
            if (!gid) continue;
            await client.query(
                `INSERT INTO media_genres (media_id, genre_id)
         VALUES ($1,$2) ON CONFLICT DO NOTHING`,
                [m.id, gid]
            );
        }

        for (const edge of (m.relations?.edges || [])) {
            if (!edge?.node?.id || !edge.relationType) continue;
            await client.query(
                `INSERT INTO media_relations
           (source_id, target_id, relation_type, target_format)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT DO NOTHING`,
                [m.id, edge.node.id, edge.relationType, edge.node.format ?? null]
            );
        }

        for (const edge of (m.recommendations?.edges || [])) {
            const rec = edge?.node?.mediaRecommendation;
            if (!rec?.id) continue;
            await client.query(
                `INSERT INTO media_recommendations (source_id, target_id, rating)
         VALUES ($1,$2,$3)
         ON CONFLICT (source_id, target_id) DO UPDATE SET rating = EXCLUDED.rating`,
                [m.id, rec.id, edge.node.rating ?? null]
            );
        }
    }
}

async function main() {
    const { Client } = require('pg');
    const PROGRESS_FILE = './data/parse-progress.json';

    const files = getFiles();
    if (!files.length) {
        console.error('[parse] no files found in', CONFIG.RAW_DIR);
        process.exit(1);
    }

    // Load progress: set of already-completed page indices
    let done = new Set();
    if (fs.existsSync(PROGRESS_FILE)) {
        try {
            done = new Set(JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8')));
            console.log(`[parse] resuming — ${done.size} pages already completed`);
        } catch { done = new Set(); }
    }

    const remaining = files.filter((_, i) => !done.has(i));
    console.log(`[parse] ${remaining.length} pages remaining of ${files.length}`);

    const t0 = Date.now();
    let total = 0;

    for (let fi = 0; fi < files.length; fi++) {
        if (done.has(fi)) continue;

        const data = readGzip(files[fi]);
        const media = data.Page?.media || [];
        if (!media.length) {
            done.add(fi);
            continue;
        }

        // Retry up to 3 times on connection errors
        let attempts = 0;
        while (true) {
            const client = new Client({ connectionString: CONFIG.DATABASE_URL });
            try {
                await client.connect();
                await client.query('BEGIN');
                await ingestPage(client, media);
                await client.query('COMMIT');
                await client.end();

                total += media.length;
                done.add(fi);

                // Persist progress after every successful page
                fs.writeFileSync(PROGRESS_FILE, JSON.stringify([...done]));
                console.log(`[parse] ${fi + 1}/${files.length} pages -- ${total} titles`);
                break;

            } catch (err) {
                try { await client.end(); } catch { }
                attempts++;
                if (attempts >= 3) {
                    console.error(`\n[parse] failed page ${fi + 1} after 3 attempts:`, err.message);
                    throw err;
                }
                console.warn(`\n[parse] connection error on page ${fi + 1}, retrying (${attempts}/3)...`);
                await new Promise(r => setTimeout(r, 3000 * attempts));
            }
        }
    }

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`\n[parse] done in ${elapsed}s`);

    // Summary counts
    const summary = new Client({ connectionString: CONFIG.DATABASE_URL });
    await summary.connect();
    const { rows: [c] } = await summary.query(`
    SELECT
      (SELECT count(*)::int FROM media)                 AS media,
      (SELECT count(*)::int FROM tags)                  AS tags,
      (SELECT count(*)::int FROM media_tags)            AS media_tags,
      (SELECT count(*)::int FROM genres)                AS genres,
      (SELECT count(*)::int FROM media_genres)          AS media_genres,
      (SELECT count(*)::int FROM media_relations)       AS relations,
      (SELECT count(*)::int FROM media_recommendations) AS recommendations
  `);
    await summary.end();
    console.table(c);

    // Clean up progress file on full completion
    if (fs.existsSync(PROGRESS_FILE)) fs.unlinkSync(PROGRESS_FILE);
}

main().catch(err => {
    console.error('[parse] fatal:', err.message);
    process.exit(1);
});