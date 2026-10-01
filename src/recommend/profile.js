'use strict';
const { fetchUserList } = require('../anilist/user');

// ---- Score normalisation ----------------------------------------
const FORMAT_MAX = {
    POINT_100: 100,
    POINT_10_DECIMAL: 10,
    POINT_10: 10,
    POINT_5: 5,
    POINT_3: 3,
};

const STATUS_DEFAULT = {
    COMPLETED: 0.65,
    CURRENT: 0.70,
    REPEATING: 0.85,
};

const DROPPED_WEIGHT       = -0.20;
const TOP_RESULTS          = 50;
const MIN_POSITIVE_ENTRIES = 3;

function normaliseScore(raw, format) {
    if (!raw || raw === 0) return null;
    const max = FORMAT_MAX[format] || 10;
    return Math.min(raw / max, 1.0);
}

function effectiveWeight(score, status, scoreFormat) {
    if (status === 'DROPPED')  return DROPPED_WEIGHT;
    if (status === 'PLANNING' || status === 'PAUSED') return null;
    const norm = normaliseScore(score, scoreFormat);
    if (norm !== null) return norm;
    return STATUS_DEFAULT[status] ?? null;
}

// ---- Shared core: does all the Postgres work --------------------
async function _recommend(username, weights, negative, excluded, db) {
    // 3. Expand excluded to full franchises
    const { rows: franchiseRows } = await db.query(`
        SELECT DISTINCT mf2.media_id
        FROM media_franchise mf1
        JOIN media_franchise mf2 ON mf2.franchise_id = mf1.franchise_id
        WHERE mf1.media_id = ANY($1)
    `, [[...excluded]]);

    for (const { media_id } of franchiseRows) excluded.add(media_id);

    // 4. Pull precomputed neighbours
    const sourceIds = [...weights.keys()];
    const { rows: neighbourRows } = await db.query(`
        SELECT source_id, target_id, score
        FROM   neighbours
        WHERE  source_id = ANY($1)
        ORDER  BY score DESC
    `, [sourceIds]);

    // 5. Aggregate: nearest liked title wins
    const candidates = new Map();

    for (const { source_id, target_id, score } of neighbourRows) {
        if (excluded.has(target_id)) continue;
        const userWeight  = weights.get(source_id) ?? 0;
        const dropPenalty = negative.has(target_id) ? 0.5 : 1.0;
        const finalScore  = score * userWeight * dropPenalty;
        const existing    = candidates.get(target_id);
        if (!existing || finalScore > existing.score) {
            candidates.set(target_id, { score: finalScore, sourceId: source_id });
        }
    }

    if (!candidates.size) {
        const err = new Error('No recommendations found — try adding more titles.');
        err.code = 'NO_RESULTS';
        throw err;
    }

    // 6. Sort + diversity cap
    const PER_SOURCE_CAP = 5;
    const sorted      = [...candidates.entries()].sort((a, b) => b[1].score - a[1].score);
    const sourceCount = new Map();
    const ranked      = [];

    for (const [targetId, { score, sourceId }] of sorted) {
        const used = sourceCount.get(sourceId) || 0;
        if (used >= PER_SOURCE_CAP) continue;
        sourceCount.set(sourceId, used + 1);
        ranked.push([targetId, { score, sourceId }]);
        if (ranked.length >= TOP_RESULTS) break;
    }

    const targetIds = ranked.map(([id]) => id);
    const attribIds = [...new Set(ranked.map(([, { sourceId }]) => sourceId))];

    // 7. Fetch full details
    const { rows: mediaDetails } = await db.query(`
    SELECT
      m.id,
      m.title_romaji,
      m.title_english,
      m.cover_image_url,
      m.site_url,
      m.average_score,
      m.popularity,
      m.chapters,
      m.status,
      m.country_of_origin,
      array_agg(DISTINCT g.name ORDER BY g.name)
        FILTER (WHERE g.name IS NOT NULL) AS genres
    FROM media m
    LEFT JOIN media_genres mg ON mg.media_id = m.id
    LEFT JOIN genres g        ON g.id        = mg.genre_id
    WHERE m.id = ANY($1)
    GROUP BY m.id
  `, [targetIds]);

    const { rows: sourceDetails } = await db.query(`
    SELECT id, title_romaji, title_english FROM media WHERE id = ANY($1)
  `, [attribIds]);

    // Fetch top 5 IDF-weighted tags per candidate
    // Fetch top 5 IDF-weighted tags per candidate
    let tagRows = [];
    try {
        const tagResult = await db.query(`
      SELECT media_id, array_agg(name ORDER BY score DESC) AS tags
      FROM (
        SELECT
          mt.media_id,
          t.name,
          (mt.rank::float / 100 * COALESCE(t.idf_weight, 0)) AS score,
          row_number() OVER (
            PARTITION BY mt.media_id
            ORDER BY (mt.rank::float / 100 * COALESCE(t.idf_weight, 0)) DESC
          ) AS rn
        FROM media_tags mt
        JOIN tags t ON t.id = mt.tag_id
        WHERE mt.media_id = ANY($1)
          AND t.is_adult            = false
          AND mt.is_general_spoiler = false
          AND mt.is_media_spoiler   = false
          AND COALESCE(t.idf_weight, 0) > 0
          AND t.name NOT IN (
            'Full Color', 'Long Strip', 'Adaptation', 'Official Colored',
            'Web Comic', 'Doujinshi', 'Fan Colored', 'Anthology',
            '4-Koma', 'Oneshot', 'Award Winning', 'Promotional'
          )
      ) sub
      WHERE rn <= 5
      GROUP BY media_id
    `, [targetIds.length > 0 ? targetIds : [-1]]);
        tagRows = tagResult.rows;
    } catch (err) {
        console.error('[recommend] tag query failed:', err.message);
    }

    const tagsByMediaId = Object.fromEntries(
        tagRows.map(r => [r.media_id, r.tags || []])
    );

    const mediaById = Object.fromEntries(mediaDetails.map(m => [m.id, m]));
    const sourceById = Object.fromEntries(sourceDetails.map(m => [m.id, m]));
    // 8. Assemble output
    return ranked
        .map(([targetId, { score, sourceId }]) => {
            const media  = mediaById[targetId];
            const source = sourceById[sourceId];
            if (!media) return null;
            return {
                id:                media.id,
                title_romaji:      media.title_romaji,
                title_english:     media.title_english,
                cover_image_url:   media.cover_image_url,
                site_url:          media.site_url,
                average_score:     media.average_score,
                popularity:        media.popularity,
                chapters:          media.chapters,
                status:            media.status,
                country_of_origin: media.country_of_origin,
                genres:            media.genres || [],
                raw_score:         score,
                genres:            media.genres || [],
                top_tags:          tagsByMediaId[media.id] || [],
                because_of: source ? {
                    id:            source.id,
                    title_romaji:  source.title_romaji,
                    title_english: source.title_english,
                    your_weight:   weights.get(sourceId),
                } : null,
            };
        })
        .filter(Boolean);
}

// ---- Public: called by local Express server (fetches AniList itself)
async function recommend(username, db) {
    const { scoreFormat, entries } = await fetchUserList(username);
    return recommendFromEntries(username, scoreFormat, entries, db);
}

// ---- Public: called by Cloudflare Worker (browser already fetched AniList)
async function recommendFromEntries(username, scoreFormat, entries, db) {
    if (!entries.length) {
        const err = new Error(`${username}'s manga list is empty`);
        err.code = 'EMPTY_LIST';
        throw err;
    }

    const weights  = new Map();
    const negative = new Map();
    const excluded = new Set();

    for (const { mediaId, score, status } of entries) {
        excluded.add(mediaId);
        const w = effectiveWeight(score, status, scoreFormat);
        if (w === null) continue;
        if (w < 0) negative.set(mediaId, w);
        else       weights.set(mediaId, w);
    }

    if (weights.size < MIN_POSITIVE_ENTRIES) {
        const err = new Error(
            `Need at least ${MIN_POSITIVE_ENTRIES} completed/reading titles. ` +
            `"${username}" has ${weights.size}.`
        );
        err.code = 'INSUFFICIENT_DATA';
        throw err;
    }

    return _recommend(username, weights, negative, excluded, db);
}

module.exports = { recommend, recommendFromEntries };
