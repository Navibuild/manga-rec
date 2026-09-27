'use strict';
require('dotenv').config();
const pool = require('../db/pool');

// ============================================================
//  TUNABLES — adjust after seeing first results
// ============================================================
const TAG_WEIGHT = 0.75;  // tag cosine similarity proportion
const GENRE_WEIGHT = 0.25;  // genre Jaccard similarity proportion
const TOP_N = 100;   // neighbours stored per title
const MIN_SCORE = 0.05;  // discard near-zero pairs
// ============================================================

// 32-bit popcount — powers fast genre Jaccard via bitmask
function popcount(x) {
    x = x - ((x >> 1) & 0x55555555);
    x = (x & 0x33333333) + ((x >> 2) & 0x33333333);
    x = (x + (x >> 4)) & 0x0f0f0f0f;
    return (Math.imul(x, 0x01010101) >>> 24);
}

async function main() {
    const client = await pool.connect();

    try {
        // ---- Schema (safe to re-run) ----------------------------------
        await client.query(`
      CREATE TABLE IF NOT EXISTS neighbours (
        source_id  integer NOT NULL REFERENCES media(id) ON DELETE CASCADE,
        target_id  integer NOT NULL REFERENCES media(id) ON DELETE CASCADE,
        score      real    NOT NULL,
        PRIMARY KEY (source_id, target_id)
      )
    `);
        await client.query(`
      CREATE INDEX IF NOT EXISTS neighbours_source_idx
      ON neighbours (source_id, score DESC)
    `);

        // ---- Load media IDs ------------------------------------------
        const { rows: mediaRows } = await client.query(`SELECT id FROM media ORDER BY id`);
        const mediaIds = mediaRows.map(r => r.id);
        const N = mediaIds.length;
        const mediaIndex = new Map(mediaIds.map((id, i) => [id, i]));

        // ---- Load non-adult tags with positive IDF -------------------
        const { rows: tagRows } = await client.query(`
      SELECT id, idf_weight::real AS idf
      FROM   tags
      WHERE  is_adult = false AND idf_weight > 0
      ORDER  BY id
    `);
        const T = tagRows.length;
        const tagIndex = new Map(tagRows.map((r, i) => [r.id, i]));
        const tagIdf = tagRows.map(r => parseFloat(r.idf));

        // ---- Load genres (max 31 — bitmask fits in Int32) ------------
        const { rows: genreRows } = await client.query(`SELECT id FROM genres ORDER BY id`);
        if (genreRows.length > 31) throw new Error('more than 31 genres — widen the bitmask');
        const G = genreRows.length;
        const genreIndex = new Map(genreRows.map((r, i) => [r.id, i]));

        console.log(`[M3] ${N} titles | ${T} tags (non-adult, IDF>0) | ${G} genres`);

        // ---- Build sparse tag vectors and inverted index -------------
        // tagVectors[mi] = [{ti, w}]   — what this title has
        // invertedIdx[ti] = [{mi, w}]  — which titles share this tag
        const tagVectors = Array.from({ length: N }, () => []);
        const invertedIdx = Array.from({ length: T }, () => []);

        const { rows: tagAssignments } = await client.query(`
      SELECT mt.media_id, mt.tag_id, mt.rank
      FROM   media_tags mt
      JOIN   tags t ON t.id = mt.tag_id
      WHERE  t.is_adult            = false
        AND  t.idf_weight          > 0
        AND  mt.is_general_spoiler = false
        AND  mt.is_media_spoiler   = false
    `);

        for (const { media_id, tag_id, rank } of tagAssignments) {
            const mi = mediaIndex.get(media_id);
            const ti = tagIndex.get(tag_id);
            if (mi === undefined || ti === undefined) continue;
            const w = (rank / 100) * tagIdf[ti];
            if (w <= 0) continue;
            tagVectors[mi].push({ ti, w });
            invertedIdx[ti].push({ mi, w });
        }

        // ---- Tag L2 norms --------------------------------------------
        const tagNorms = new Float32Array(N);
        for (let mi = 0; mi < N; mi++) {
            let sq = 0;
            for (const { w } of tagVectors[mi]) sq += w * w;
            tagNorms[mi] = Math.sqrt(sq);
        }

        // ---- Genre bitmasks ------------------------------------------
        const genreMasks = new Int32Array(N);
        const { rows: genreAssignments } = await client.query(
            `SELECT media_id, genre_id FROM media_genres`
        );
        for (const { media_id, genre_id } of genreAssignments) {
            const mi = mediaIndex.get(media_id);
            const gi = genreIndex.get(genre_id);
            if (mi === undefined || gi === undefined) continue;
            genreMasks[mi] |= (1 << gi);
        }

        // ---- Pairwise similarity via inverted index ------------------
        // The inverted index means we only touch (tag, title) pairs that
        // actually share a tag — ~7M ops instead of 9.5B for a dense loop.
        console.log('[M3] computing similarities...');
        await client.query('TRUNCATE neighbours');

        const t0 = Date.now();
        const dots = new Float32Array(N); // scratch buffer, reused each iteration

        for (let i = 0; i < N; i++) {
            // Accumulate tag dot products: only non-zero intersections
            dots.fill(0);
            for (const { ti, w: wi } of tagVectors[i]) {
                for (const { mi: j, w: wj } of invertedIdx[ti]) {
                    dots[j] += wi * wj;
                }
            }

            const normI = tagNorms[i];
            const maskI = genreMasks[i];
            const scores = [];

            for (let j = 0; j < N; j++) {
                if (i === j) continue;

                // Tag cosine similarity
                let tagSim = 0;
                if (dots[j] > 0 && normI > 0 && tagNorms[j] > 0) {
                    tagSim = dots[j] / (normI * tagNorms[j]);
                }

                // Genre Jaccard via bitmask popcount (fast for 18 genres)
                let genreSim = 0;
                const maskJ = genreMasks[j];
                const unionBits = popcount(maskI | maskJ);
                if (unionBits > 0) {
                    genreSim = popcount(maskI & maskJ) / unionBits;
                }

                const score = TAG_WEIGHT * tagSim + GENRE_WEIGHT * genreSim;
                if (score >= MIN_SCORE) scores.push([j, score]);
            }

            // Partial sort: top-N only
            scores.sort((a, b) => b[1] - a[1]);
            const top = scores.slice(0, TOP_N);

            if (top.length > 0) {
                await client.query(`
          INSERT INTO neighbours (source_id, target_id, score)
          SELECT * FROM unnest($1::int[], $2::int[], $3::real[])
          ON CONFLICT DO NOTHING
        `, [
                    top.map(() => mediaIds[i]),
                    top.map(([j]) => mediaIds[j]),
                    top.map(([, s]) => s),
                ]);
            }

            if ((i + 1) % 250 === 0 || i === N - 1) {
                const elapsed = (Date.now() - t0) / 1000;
                const pct = ((i + 1) / N * 100).toFixed(1);
                const eta = ((elapsed / (i + 1)) * (N - i - 1)).toFixed(0);
                process.stdout.write(
                    `\r[M3] ${i + 1}/${N} (${pct}%)  ${elapsed.toFixed(1)}s elapsed  ~${eta}s left   `
                );
            }
        }

        const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
        console.log(`\n[M3] done in ${elapsed}s`);

        // ---- Sanity checks -------------------------------------------
        const { rows: [{ count }] } = await client.query(
            `SELECT count(*)::int FROM neighbours`
        );
        console.log(`[M3] ${count} neighbour pairs stored`);

        // Score distribution — tells you if MIN_SCORE needs adjusting
        const { rows: [dist] } = await client.query(`
      SELECT
        round(min(score)::numeric,   4) AS min,
        round(avg(score)::numeric,   4) AS avg,
        round(percentile_cont(0.5) WITHIN GROUP (ORDER BY score)::numeric, 4) AS p50,
        round(percentile_cont(0.9) WITHIN GROUP (ORDER BY score)::numeric, 4) AS p90,
        round(max(score)::numeric,   4) AS max
      FROM neighbours
    `);
        console.log('[M3] score distribution:', dist);

        // Show neighbours for the most popular title
        const { rows: [anchor] } = await client.query(
            `SELECT id, title_romaji FROM media ORDER BY popularity DESC LIMIT 1`
        );
        const { rows: sample } = await client.query(`
      SELECT m.title_romaji, round(n.score::numeric, 4) AS score
      FROM   neighbours n
      JOIN   media m ON m.id = n.target_id
      WHERE  n.source_id = $1
      ORDER  BY n.score DESC LIMIT 10
    `, [anchor.id]);

        console.log(`\n[M3] top 10 neighbours for "${anchor.title_romaji}":`);
        console.table(sample);

        // And for something mid-tier — Vinland Saga if in corpus
        const { rows: [mid] } = await client.query(
            `SELECT id, title_romaji FROM media WHERE title_romaji ILIKE '%vinland%' LIMIT 1`
        );
        if (mid) {
            const { rows: midSample } = await client.query(`
        SELECT m.title_romaji, round(n.score::numeric, 4) AS score
        FROM   neighbours n
        JOIN   media m ON m.id = n.target_id
        WHERE  n.source_id = $1
        ORDER  BY n.score DESC LIMIT 10
      `, [mid.id]);
            console.log(`\n[M3] top 10 neighbours for "${mid.title_romaji}":`);
            console.table(midSample);
        }

    } catch (err) {
        console.error('[M3] FAILED:', err.message);
        process.exitCode = 1;
    } finally {
        client.release();
        await pool.end();
    }
}

main();