'use strict';
const CONFIG = require('../config');

// ---- The one query the media crawl uses -------------------------
// ---- Keyset pagination: id_greater advances, depth stays at 1 ----
const MEDIA_PAGE_QUERY = `
query ($page: Int, $perPage: Int) {
  Page(page: $page, perPage: $perPage) {
    pageInfo { currentPage lastPage hasNextPage perPage total }
    media(type: MANGA, format: MANGA, isAdult: false, sort: POPULARITY_DESC) {
      id
      title { romaji english native }
      format
      status
      countryOfOrigin
      description(asHtml: false)
      averageScore
      meanScore
      popularity
      favourites
      chapters
      volumes
      startDate { year month day }
      coverImage { large extraLarge }
      bannerImage
      siteUrl
      isAdult
      genres
      tags {
        id name category description rank
        isGeneralSpoiler isMediaSpoiler isAdult
      }
      relations {
        edges { relationType node { id type format } }
      }
      recommendations(perPage: 10, sort: RATING_DESC) {
        edges { node { rating mediaRecommendation { id } } }
      }
    }
  }
}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let lastRequestAt = 0;

async function throttle() {
    const wait = CONFIG.MIN_INTERVAL_MS - (Date.now() - lastRequestAt);
    if (wait > 0) await sleep(wait);
    lastRequestAt = Date.now();
}

/**
 * POST a GraphQL query, honouring AniList's rate limit headers.
 * Retries on 429, 5xx, and network/timeout errors.
 */
async function request(query, variables) {
    let attempt = 0;

    for (; ;) {
        await throttle();

        let res;
        try {
            const ac = new AbortController();
            const timer = setTimeout(() => ac.abort(), CONFIG.REQUEST_TIMEOUT_MS);
            try {
                res = await fetch(CONFIG.ENDPOINT, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        Accept: 'application/json',
                        'User-Agent': CONFIG.USER_AGENT,
                    },
                    body: JSON.stringify({ query, variables }),
                    signal: ac.signal,
                });
            } finally {
                clearTimeout(timer);
            }
        } catch (err) {
            attempt++;
            if (attempt > CONFIG.MAX_RETRIES) throw new Error(`network failure: ${err.message}`);
            const back = Math.min(CONFIG.BACKOFF_BASE_MS * 2 ** (attempt - 1), CONFIG.BACKOFF_MAX_MS);
            console.warn(`[api] ${err.message} -- retry ${attempt}/${CONFIG.MAX_RETRIES} in ${back}ms`);
            await sleep(back);
            continue;
        }

        const remaining = res.headers.get('x-ratelimit-remaining');
        if (remaining !== null && Number(remaining) <= 2) {
            console.warn(`[api] rate budget low (${remaining} left), easing off`);
            await sleep(5000);
        }

        if (res.status === 429) {
            const retryAfter = Number(res.headers.get('retry-after') || 60);
            console.warn(`[api] 429 -- sleeping ${retryAfter}s`);
            await sleep((retryAfter + 1) * 1000);
            continue; // 429s don't count against the retry budget
        }

        if (res.status >= 500) {
            attempt++;
            if (attempt > CONFIG.MAX_RETRIES) throw new Error(`server error ${res.status} after ${attempt} tries`);
            const back = Math.min(CONFIG.BACKOFF_BASE_MS * 2 ** (attempt - 1), CONFIG.BACKOFF_MAX_MS);
            console.warn(`[api] HTTP ${res.status} -- retry ${attempt}/${CONFIG.MAX_RETRIES} in ${back}ms`);
            await sleep(back);
            continue;
        }

        const body = await res.json().catch(() => null);

        if (!res.ok) {
            const msg = body?.errors?.map((e) => e.message).join('; ') || `HTTP ${res.status}`;
            throw new Error(`AniList error: ${msg}`);
        }
        if (body?.errors?.length) {
            throw new Error(`AniList GraphQL error: ${body.errors.map((e) => e.message).join('; ')}`);
        }
        return body.data;
    }
}

module.exports = { request, MEDIA_PAGE_QUERY };