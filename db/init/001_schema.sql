-- ---------------------------------------------------------------
-- Core catalog. Primary keys are AniList IDs, so every write is an
-- idempotent upsert and re-crawling never duplicates.
-- ---------------------------------------------------------------

CREATE TABLE media (
    id                  integer PRIMARY KEY,
    title_romaji        text,
    title_english       text,
    title_native        text,
    format              text CHECK (format IN ('MANGA','NOVEL','ONE_SHOT')),
    status              text CHECK (status IN ('FINISHED','RELEASING','NOT_YET_RELEASED','CANCELLED','HIATUS')),
    country_of_origin   char(2),
    description         text,
    average_score       smallint,
    mean_score          smallint,
    popularity          integer,
    favourites          integer,
    chapters            integer,
    volumes             integer,
    start_year          smallint,
    start_month         smallint,
    start_day           smallint,
    cover_image_url     text,
    banner_image_url    text,
    site_url            text,
    is_adult            boolean NOT NULL DEFAULT false,
    fetched_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX media_popularity_idx     ON media (popularity DESC NULLS LAST);
CREATE INDEX media_country_idx        ON media (country_of_origin);
CREATE INDEX media_format_status_idx  ON media (format, status);
CREATE INDEX media_not_adult_idx      ON media (id) WHERE is_adult = false;

-- ---------------------------------------------------------------
-- Tags: the main signal. rank is AniList's 0-100 confidence.
-- ---------------------------------------------------------------

CREATE TABLE tags (
    id            integer PRIMARY KEY,
    name          text NOT NULL UNIQUE,
    category      text,
    description   text,
    is_adult      boolean NOT NULL DEFAULT false
);

CREATE TABLE media_tags (
    media_id            integer NOT NULL REFERENCES media(id) ON DELETE CASCADE,
    tag_id              integer NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    rank                smallint,
    is_general_spoiler  boolean NOT NULL DEFAULT false,
    is_media_spoiler    boolean NOT NULL DEFAULT false,
    PRIMARY KEY (media_id, tag_id)
);

CREATE INDEX media_tags_tag_idx ON media_tags (tag_id);

-- ---------------------------------------------------------------
-- Genres: coarse, separate channel from tags.
-- ---------------------------------------------------------------

CREATE TABLE genres (
    id    serial PRIMARY KEY,
    name  text NOT NULL UNIQUE
);

CREATE TABLE media_genres (
    media_id  integer NOT NULL REFERENCES media(id) ON DELETE CASCADE,
    genre_id  integer NOT NULL REFERENCES genres(id) ON DELETE CASCADE,
    PRIMARY KEY (media_id, genre_id)
);

CREATE INDEX media_genres_genre_idx ON media_genres (genre_id);

-- ---------------------------------------------------------------
-- Relations: input to franchise grouping (M2). target_id is NOT a
-- foreign key on purpose -- edges often point outside your corpus.
-- ---------------------------------------------------------------

CREATE TABLE media_relations (
    source_id      integer NOT NULL REFERENCES media(id) ON DELETE CASCADE,
    target_id      integer NOT NULL,
    relation_type  text NOT NULL,
    target_format  text,
    PRIMARY KEY (source_id, target_id, relation_type)
);

CREATE INDEX media_relations_target_idx ON media_relations (target_id);

-- ---------------------------------------------------------------
-- User-submitted "if you liked X, try Y" edges.
-- This is your M6 ground truth -- crawl it now, it's free.
-- ---------------------------------------------------------------

CREATE TABLE media_recommendations (
    source_id  integer NOT NULL REFERENCES media(id) ON DELETE CASCADE,
    target_id  integer NOT NULL,
    rating     integer,
    PRIMARY KEY (source_id, target_id)
);

CREATE INDEX media_recommendations_target_idx ON media_recommendations (target_id);

-- ---------------------------------------------------------------
-- Franchise grouping, populated in M2.
-- ---------------------------------------------------------------

CREATE TABLE franchises (
    id            serial PRIMARY KEY,
    root_media_id integer REFERENCES media(id) ON DELETE SET NULL,
    label         text
);

CREATE TABLE media_franchise (
    media_id      integer PRIMARY KEY REFERENCES media(id) ON DELETE CASCADE,
    franchise_id  integer NOT NULL REFERENCES franchises(id) ON DELETE CASCADE
);

CREATE INDEX media_franchise_franchise_idx ON media_franchise (franchise_id);

-- ---------------------------------------------------------------
-- Crawl bookkeeping: makes M1 resumable after a crash or 429 storm.
-- ---------------------------------------------------------------

CREATE TABLE crawl_runs (
    id            serial PRIMARY KEY,
    kind          text NOT NULL,
    started_at    timestamptz NOT NULL DEFAULT now(),
    finished_at   timestamptz,
    last_page     integer,
    pages_total   integer,
    items_seen    integer NOT NULL DEFAULT 0,
    status        text NOT NULL DEFAULT 'running'
                  CHECK (status IN ('running','done','failed','paused')),
    error         text
);

CREATE INDEX crawl_runs_kind_idx ON crawl_runs (kind, started_at DESC);

CREATE TABLE IF NOT EXISTS neighbours (
    source_id  integer NOT NULL REFERENCES media(id) ON DELETE CASCADE,
    target_id  integer NOT NULL REFERENCES media(id) ON DELETE CASCADE,
    score      real    NOT NULL,
    PRIMARY KEY (source_id, target_id)
);
CREATE INDEX neighbours_source_idx ON neighbours (source_id, score DESC);