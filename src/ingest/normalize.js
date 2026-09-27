'use strict';
require('dotenv').config();
const pool = require('../db/pool');

// ================================================================
// Union-Find for connected-component franchise grouping
// ================================================================
class UnionFind {
    constructor() { this.p = new Map(); this.r = new Map(); }
    _init(x) { if (!this.p.has(x)) { this.p.set(x, x); this.r.set(x, 0); } }
    find(x) {
        this._init(x);
        if (this.p.get(x) !== x) this.p.set(x, this.find(this.p.get(x)));
        return this.p.get(x);
    }
    union(x, y) {
        const [px, py] = [this.find(x), this.find(y)];
        if (px === py) return;
        const [rx, ry] = [this.r.get(px), this.r.get(py)];
        if (rx < ry) this.p.set(px, py);
        else if (rx > ry) this.p.set(py, px);
        else { this.p.set(py, px); this.r.set(px, rx + 1); }
    }
}

// Relation types that mean "same franchise".
// ADAPTATION and CHARACTER are excluded — a manga adapted from a light
// novel, or two series sharing a character, are not the same franchise.
const FRANCHISE_RELATIONS = new Set([
    'SEQUEL', 'PREQUEL', 'PARENT', 'SIDE_STORY',
    'SPIN_OFF', 'ALTERNATIVE', 'ALTERNATIVE_VERSION',
    'COMPILATION', 'CONTAINS', 'SUMMARY',
]);

async function buildFranchises(client) {
    console.log('[M2] building franchise groups...');

    // Only link pairs where the target is also in our corpus.
    // Relations pointing outside (e.g. to an anime adaptation) are ignored.
    const { rows: edges } = await client.query(`
    SELECT r.source_id, r.target_id
    FROM   media_relations r
    JOIN   media m ON m.id = r.target_id
    WHERE  r.relation_type = ANY($1)
  `, [[...FRANCHISE_RELATIONS]]);

    const { rows: allMedia } = await client.query(
        `SELECT id, popularity FROM media`
    );

    const uf = new UnionFind();
    for (const { id } of allMedia) uf.find(id);      // seed every id
    for (const { source_id, target_id } of edges) uf.union(source_id, target_id);

    // Group by root
    const groups = new Map();
    const popById = Object.fromEntries(allMedia.map(m => [m.id, m.popularity || 0]));

    for (const { id } of allMedia) {
        const root = uf.find(id);
        if (!groups.has(root)) groups.set(root, []);
        groups.get(root).push(id);
    }

    // Clear old data so this script is safely re-runnable
    await client.query('DELETE FROM media_franchise');
    await client.query('DELETE FROM franchises');

    let totalFranchises = 0;
    let linkedTitles = 0;

    for (const members of groups.values()) {
        // Most popular entry becomes the franchise root (tiebreak: lowest id)
        members.sort((a, b) => (popById[b] - popById[a]) || (a - b));
        const rootId = members[0];

        const { rows: [{ id: fid }] } = await client.query(
            `INSERT INTO franchises (root_media_id) VALUES ($1) RETURNING id`,
            [rootId]
        );

        for (const mid of members) {
            await client.query(
                `INSERT INTO media_franchise (media_id, franchise_id) VALUES ($1,$2)`,
                [mid, fid]
            );
        }

        totalFranchises++;
        if (members.length > 1) linkedTitles += members.length;
    }

    console.log(
        `[M2] ${totalFranchises} franchises ` +
        `(${linkedTitles} titles linked into multi-entry groups, ` +
        `${allMedia.length - linkedTitles} stand-alone)`
    );
}

async function computeIdf(client) {
    console.log('[M2] computing tag IDF weights...');

    // Add columns if they don't exist (safe to re-run)
    await client.query(`ALTER TABLE tags ADD COLUMN IF NOT EXISTS doc_freq   integer`);
    await client.query(`ALTER TABLE tags ADD COLUMN IF NOT EXISTS idf_weight real`);

    const { rows: [{ n }] } = await client.query(
        `SELECT count(*)::int AS n FROM media`
    );

    // doc_freq = titles a tag appears on (excluding general-spoiler appearances,
    // since those don't surface to users and would overcount common tags)
    await client.query(`
    UPDATE tags t
    SET
      doc_freq   = sub.df,
      idf_weight = ln($1::real / GREATEST(sub.df, 1))
    FROM (
      SELECT tag_id, count(*)::int AS df
      FROM   media_tags
      WHERE  is_general_spoiler = false
      GROUP  BY tag_id
    ) sub
    WHERE t.id = sub.tag_id
    AND   t.is_adult = false
  `, [n]);

    // Tags with no non-spoiler appearances get zero weight
    await client.query(`
    UPDATE tags SET doc_freq = 0, idf_weight = 0
    WHERE doc_freq IS NULL OR is_adult = true
  `);

    // Distribution check
    const { rows: [d] } = await client.query(`
    SELECT
      round(min(idf_weight)::numeric, 3)                                    AS min,
      round(percentile_cont(0.1) WITHIN GROUP (ORDER BY idf_weight)::numeric, 3) AS p10,
      round(percentile_cont(0.5) WITHIN GROUP (ORDER BY idf_weight)::numeric, 3) AS p50,
      round(percentile_cont(0.9) WITHIN GROUP (ORDER BY idf_weight)::numeric, 3) AS p90,
      round(max(idf_weight)::numeric, 3)                                    AS max
    FROM tags
  `);
    console.log('[M2] IDF distribution:', d);

    const { rows: topTags } = await client.query(`
    SELECT name, doc_freq, round(idf_weight::numeric, 3) AS idf
    FROM   tags
    WHERE  is_adult = false
    ORDER  BY idf_weight DESC LIMIT 10
  `);
    const { rows: botTags } = await client.query(`
    SELECT name, doc_freq, round(idf_weight::numeric, 3) AS idf
    FROM   tags
    WHERE  is_adult = false AND doc_freq > 0
    ORDER  BY idf_weight ASC LIMIT 10
  `);

    console.log('[M2] most discriminative (rare, high IDF):');
    console.table(topTags);
    console.log('[M2] least discriminative (common, low IDF):');
    console.table(botTags);
}

async function main() {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await buildFranchises(client);
        await client.query('COMMIT');

        await client.query('BEGIN');
        await computeIdf(client);
        await client.query('COMMIT');

        console.log('[M2] normalisation complete');
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('[M2] FAILED:', err.message);
        process.exitCode = 1;
    } finally {
        client.release();
        await pool.end();
    }
}

main();