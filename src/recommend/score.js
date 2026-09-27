'use strict';

// ----------------------------------------------------------------
// Converts raw similarity scores into display percentages.
//
// Raw scores cluster in a narrow band (roughly 0.3–0.7) and mean
// nothing to a user. Min-max normalization within each result set
// spreads them across a legible display range, so the best match
// looks meaningfully different from the weakest one.
//
// DISPLAY_MAX is 97, not 100 — a perfect score would imply an
// exact duplicate, which is never the intent of a recommendation.
// DISPLAY_MIN is 40 — anything in your top 50 is a real match,
// so the weakest result shouldn't look like a bad suggestion.
// ----------------------------------------------------------------

const DISPLAY_MAX = 97;
const DISPLAY_MIN = 40;

function applyDisplayScores(results) {
    if (!results.length) return results;

    const scores = results.map(r => r.raw_score);
    const min = Math.min(...scores);
    const max = Math.max(...scores);
    const range = max - min;

    return results.map(r => {
        const normalized = range === 0 ? 1 : (r.raw_score - min) / range;
        const match_pct = Math.round(DISPLAY_MIN + (DISPLAY_MAX - DISPLAY_MIN) * normalized);
        return { ...r, match_pct };
    });
}

module.exports = { applyDisplayScores };