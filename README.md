# Personal Recommendation Machine

Personalised manga recommendations powered by your AniList reading history.

Enter your AniList username and get up to 50 ranked recommendations, each with a match percentage and an explanation of which title in your library drove the suggestion.

**[Live demo →](https://manga-rec.arnavhbal.workers.dev)**

---

## How it works

MangaMatch is a content-based recommendation engine built on three signals:

**Tag similarity (75%)** — AniList assigns every manga a set of tags (e.g. *Time Loop*, *Revenge*, *Political*) with a confidence rank from 0–100. Each title is represented as a weighted vector of these tags, with IDF weighting so rare tags carry more signal than common ones like *Shounen*. Similarity between titles is computed as cosine distance between these vectors.

**Genre similarity (25%)** — Jaccard overlap across AniList's 18 genre labels, encoded as a bitmask for fast computation.

**User weighting** — your AniList scores are normalised to a 0–1 scale (handling all scoring formats: 100-point, 10-point, 5-star, smiley) and used to weight how much each title in your library contributes to your recommendations. Dropped titles apply a mild negative signal. A per-source diversity cap ensures no single title in your library dominates the results.

Similarity is precomputed at ingest time (top 100 neighbours per title) and stored in Postgres, so serving a recommendation set requires only a handful of indexed lookups — no vector math at request time.

---

## Evaluation

Evaluated against **29,324 community-sourced recommendation pairs** from AniList (pairs where the community voted a title as a good match for another).

| Metric | MangaMatch | Genre-only baseline | Lift |
|---|---|---|---|
| MRR | 0.0597 | 0.0293 | +104% |
| Recall@10 | 12.70% | 5.79% | **+119%** |
| Recall@20 | 19.37% | 9.17% | +111% |
| Recall@50 | 31.94% | 15.78% | +103% |

Tag similarity with IDF weighting finds correct recommendations at more than **double the rate** of genre matching alone across all evaluated cutoffs.

---

## Stack

- **Backend** — Node.js, Express (local), Hono (Cloudflare Workers)
- **Database** — PostgreSQL via Neon
- **Data** — AniList GraphQL API (no scraping, no third-party wrappers)
- **Frontend** — vanilla HTML / CSS / JS, no build step
- **Deployment** — Cloudflare Workers

---

## Running locally

### Prerequisites

- Node.js 18+
- PostgreSQL 14+

### Setup

```bash
git clone https://github.com/Navibuild/manga-rec.git
cd manga-rec
npm install
cp .env.example .env
```

Edit `.env` with your Postgres connection string:

```bash
DATABASE_URL=postgresql://manga:localdev@127.0.0.1:5432/mangarec
```

Create the database and apply the schema:

```bash
psql -U postgres -c "CREATE USER manga WITH PASSWORD 'localdev';"
psql -U postgres -c "CREATE DATABASE mangarec OWNER manga;"
psql -U manga -d mangarec -f db/init/001_schema.sql
```

### Build the catalog

Run these in order. Each step is idempotent and safe to re-run.

```bash
# 1. Crawl AniList (~25 min, top 5000 manga by popularity)
npm run crawl

# 2. Parse raw archive into Postgres
npm run parse

# 3. Compute franchise groups and IDF weights
npm run normalise

# 4. Precompute pairwise similarity (neighbour table)
npm run similarity
```

### Start the server

```bash
npm start
```

Open [http://localhost:3000](http://localhost:3000) and enter your AniList username.

You can also link directly to results:

```
http://localhost:3000?u=YourAniListUsername
```

### Evaluate

```bash
npm run eval
```

Runs recall and MRR against AniList's community recommendation pairs and compares against a genre-only baseline.

---

## Project structure

```
manga-rec/
├── client/             # Frontend (HTML / CSS / JS)
├── db/
│   └── init/           # Schema — applied once on fresh DB
├── src/
│   ├── anilist/        # GraphQL client, rate limiter, crawl loop, user list fetch
│   ├── db/             # Postgres pool and Neon serverless client
│   ├── ingest/         # Parse, normalise (IDF + franchises), similarity
│   ├── recommend/      # Profile builder, scoring, display normalisation
│   ├── eval/           # Recall / MRR evaluation harness
│   └── api/            # Express server (local) and Cloudflare Worker
└── data/
    └── raw/            # Gzipped AniList JSON archive (gitignored)
```

---

## Limitations

- **Content-based only** — no collaborative filtering, so the engine can't learn that two titles are similar because the same readers tend to enjoy both. Tag overlap is a proxy for taste, not a substitute for behaviour data.
- **Top 5000 corpus** — AniList's API caps popularity-sorted pagination at 5000 entries. Titles outside this range won't appear as recommendations.
- **Cold start for short lists** — users with fewer than 3 completed/reading titles get an insufficient data error. The engine needs a minimum signal to work from.
- **No description embeddings** — synopsis similarity was evaluated but manga descriptions on AniList are short and formulaic, so tag vectors carry most of the signal. Embeddings are a planned addition.

---

## Roadmap

- [ ] Comment sentiment analysis — parse the top 50 community comments per title (25 positive, 25 negative), extract adjectives and frequency-ranked terms to surface tone and reader sentiment alongside the match percentage
- [ ] User comment profiling — parse a user's own AniList activity comments to infer preferences beyond scores
- [ ] Manhwa / manhua filter — country-of-origin toggle (JP / KR / CN)
- [ ] Anime adaptation links — surface when a recommended manga has an anime
- [ ] Description embeddings as a third similarity channel

---

## Data attribution

All manga metadata, tags, genres, and community recommendations sourced from [AniList](https://anilist.co) via their public GraphQL API.
