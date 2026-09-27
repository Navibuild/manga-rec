'use strict';
require('dotenv').config();
const pool = require('../db/pool');

const K_VALUES = [10, 20, 50];

function popcount(x) {
    x = x - ((x >> 1) & 0x55555555);
    x = (x & 0x33333333) + ((x >> 2) & 0x33333333);
    x = (x + (x >> 4)) & 0x0f0f0f0f;
    return (Math.imul(x, 0x01010101) >>> 24);
}

function genreJaccard(maskA, maskB) {
    const u = popcount(maskA | maskB);
    return u === 0 ? 0 : popcount(maskA & maskB) / u;
}

async function main() {
    const client = await pool.connect();

    try {
        // ---- 1. Corpus set ------------------------------------------
        console.log('[eval] loading corpus...');
        const { rows: corpusRows } = await client.query('SELECT id FROM media');
        const corpus = new Set(corpusRows.map(r => r.id));
        console.log(`[eval] ${corpus.size} titles in corpus`);

        // ---- 2. Ground truth ----------------------------------------
        // AniList community recommendations where both ends are in corpus
        // and the community voted the pair as positive (rating > 0).
        console.log('[eval] loading ground truth...');
        const { rows: gtRows } = await client.query(`
      SELECT source_id, target_id
      FROM   media_recommendations
      WHERE  rating > 0
    `);

        const groundTruth = new Map(); // source_id -> Set<target_id>
        for (const { source_id, target_id } of gtRows) {
            if (!corpus.has(source_id) || !corpus.has(target_id)) continue;
            if (!groundTruth.has(source_id)) groundTruth.set(source_id, new Set());
            groundTruth.get(source_id).add(target_id);
        }

        const sourcesWithGT = [...groundTruth.keys()];
        const totalPairs = sourcesWithGT.reduce((acc, id) => acc + groundTruth.get(id).size, 0);
        console.log(`[eval] ${sourcesWithGT.length} sources | ${totalPairs} ground-truth pairs\n`);

        // ---- 3. Our engine rankings (precomputed neighbours) ---------
        console.log('[eval] loading neighbour rankings...');
        const { rows: neighbourRows } = await client.query(`
      SELECT source_id, target_id
      FROM   neighbours
      ORDER  BY source_id, score DESC
    `);

        // source_id -> Map(target_id -> rank)  (0-indexed)
        const ourRankMaps = new Map();
        for (const { source_id, target_id } of neighbourRows) {
            if (!ourRankMaps.has(source_id)) ourRankMaps.set(source_id, new Map());
            const m = ourRankMaps.get(source_id);
            m.set(target_id, m.size); // insertion order = score DESC
        }

        // ---- 4. Genre-only baseline ----------------------------------
        // Jaccard on genre overlap, all 5000 corpus titles ranked per source.
        // This is what a "just match genres" system would give you.
        console.log('[eval] building genre baseline...');
        const { rows: genreRows } = await client.query('SELECT id FROM genres ORDER BY id');
        const genreIndex = new Map(genreRows.map((r, i) => [r.id, i]));

        const genreMasks = new Map();
        for (const id of corpus) genreMasks.set(id, 0);
        const { rows: mgRows } = await client.query('SELECT media_id, genre_id FROM media_genres');
        for (const { media_id, genre_id } of mgRows) {
            const gi = genreIndex.get(genre_id);
            if (gi === undefined) continue;
            genreMasks.set(media_id, (genreMasks.get(media_id) || 0) | (1 << gi));
        }

        const corpusArr = [...corpus];

        // Precompute baseline rank Maps only for sources that have ground truth
        // (no point computing for others)
        const baselineRankMaps = new Map();
        const t0 = Date.now();

        for (let i = 0; i < sourcesWithGT.length; i++) {
            const sourceId = sourcesWithGT[i];
            const sourceMask = genreMasks.get(sourceId) || 0;

            const ranked = corpusArr
                .filter(id => id !== sourceId)
                .map(id => [id, genreJaccard(sourceMask, genreMasks.get(id) || 0)])
                .sort((a, b) => b[1] - a[1]);

            baselineRankMaps.set(sourceId, new Map(ranked.map(([id], rank) => [id, rank])));

            if ((i + 1) % 100 === 0) {
                process.stdout.write(`\r[eval] baseline ${i + 1}/${sourcesWithGT.length}`);
            }
        }
        console.log(`\r[eval] baseline built in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);

        // ---- 5. Compute metrics -------------------------------------
        const mkAcc = () => ({ rr: 0, hits: Object.fromEntries(K_VALUES.map(k => [k, 0])) });
        const our = mkAcc();
        const baseline = mkAcc();
        let pairs = 0;

        // Track a few cases where baseline beats us (useful for write-up)
        const baselineWins = [];

        for (const sourceId of sourcesWithGT) {
            const targets = groundTruth.get(sourceId);
            const ourMap = ourRankMaps.get(sourceId) || new Map();
            const baselineMap = baselineRankMaps.get(sourceId) || new Map();

            for (const targetId of targets) {
                const ourRank = ourMap.has(targetId) ? ourMap.get(targetId) : Infinity;
                const baseRank = baselineMap.has(targetId) ? baselineMap.get(targetId) : Infinity;

                // Our engine
                if (isFinite(ourRank)) {
                    our.rr += 1 / (ourRank + 1);
                    for (const k of K_VALUES) if (ourRank < k) our.hits[k]++;
                }

                // Baseline
                if (isFinite(baseRank)) {
                    baseline.rr += 1 / (baseRank + 1);
                    for (const k of K_VALUES) if (baseRank < k) baseline.hits[k]++;
                }

                // Log cases where baseline beats us in top 10
                if (baseRank < 10 && ourRank >= 10 && baselineWins.length < 10) {
                    baselineWins.push({ sourceId, targetId, ourRank, baseRank });
                }

                pairs++;
            }
        }

        // ---- 6. Print results ----------------------------------------
        const mrr = acc => (acc.rr / pairs).toFixed(4);
        const rec = (acc, k) => ((acc.hits[k] / pairs) * 100).toFixed(2) + '%';
        const lift = (a, b, k) => {
            if (b.hits[k] === 0) return 'N/A';
            return ((a.hits[k] / b.hits[k] - 1) * 100).toFixed(1) + '%';
        };

        console.log(`${'═'.repeat(58)}`);
        console.log(` Evaluation over ${pairs} ground-truth pairs`);
        console.log(`${'═'.repeat(58)}`);
        console.log(
            `${'Metric'.padEnd(18)} ${'Our Engine'.padEnd(16)} ${'Genre Baseline'.padEnd(16)} Lift`
        );
        console.log('─'.repeat(58));
        console.log(`${'MRR'.padEnd(18)} ${mrr(our).padEnd(16)} ${mrr(baseline).padEnd(16)}`);
        for (const k of K_VALUES) {
            const label = `Recall@${k}`;
            console.log(
                `${label.padEnd(18)} ${rec(our, k).padEnd(16)} ${rec(baseline, k).padEnd(16)} ${lift(our, baseline, k)}`
            );
        }
        console.log(`${'═'.repeat(58)}\n`);

        // ---- 7. Failure cases ----------------------------------------
        if (baselineWins.length > 0) {
            const sourceIds = [...new Set(baselineWins.map(b => b.sourceId))];
            const targetIds = [...new Set(baselineWins.map(b => b.targetId))];
            const { rows: titles } = await client.query(
                `SELECT id, title_romaji FROM media WHERE id = ANY($1)`,
                [[...sourceIds, ...targetIds]]
            );
            const titleById = Object.fromEntries(titles.map(t => [t.id, t.title_romaji]));

            console.log('Cases where genre baseline beat our engine in top 10:');
            console.log('(useful for the CV write-up — honest about limitations)\n');
            for (const { sourceId, targetId, ourRank, baseRank } of baselineWins) {
                console.log(
                    `  ${titleById[sourceId]} → ${titleById[targetId]}`
                );
                console.log(
                    `  our rank: ${ourRank === Infinity ? '>100' : ourRank + 1}  |  baseline rank: ${baseRank + 1}\n`
                );
            }
        }

        // ---- 8. Plain-English summary --------------------------------
        const liftMRR = ((our.rr / baseline.rr) - 1) * 100;
        const lift10 = ((our.hits[10] / Math.max(baseline.hits[10], 1)) - 1) * 100;

        console.log('── Summary ──────────────────────────────────────────────');
        console.log(
            `Tag+IDF similarity finds ${lift10.toFixed(1)}% more correct recommendations`
        );
        console.log(`in the top 10 than genre matching alone.`);
        console.log(
            `On average, our engine ranks correct answers ${liftMRR.toFixed(1)}% higher (MRR).`
        );
        console.log('\nThese numbers go in the README and case study.');

    } catch (err) {
        console.error('[eval] FAILED:', err.message);
        process.exitCode = 1;
    } finally {
        client.release();
        await pool.end();
    }
}

main();