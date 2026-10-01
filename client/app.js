'use strict';

const form = document.getElementById('searchForm');
const usernameInput = document.getElementById('usernameInput');
const searchBtn = document.getElementById('searchBtn');
const btnText = searchBtn.querySelector('.btn-text');
const btnSpinner = searchBtn.querySelector('.btn-spinner');
const emptyState = document.getElementById('emptyState');
const errorState = document.getElementById('errorState');
const errorMessage = document.getElementById('errorMessage');
const resultsSection = document.getElementById('resultsSection');
const resultsTitle = document.getElementById('resultsTitle');
const resultsMeta = document.getElementById('resultsMeta');
const resultsGrid = document.getElementById('resultsGrid');

// ---- Match ring ---------------------------------------------
function buildRingSVG(pct) {
    const R = 17;
    const C = +(2 * Math.PI * R).toFixed(2);     // ≈ 106.81
    const offset = +(C * (1 - pct / 100)).toFixed(2);

    // Green ≥ 80, amber 60–79, red < 60
    const color = pct >= 80 ? '#2ecc71' : pct >= 60 ? '#f39c12' : '#e63946';

    return `<svg class="match-badge" viewBox="0 0 44 44" xmlns="http://www.w3.org/2000/svg">
    <circle cx="22" cy="22" r="19" class="ring-bg"/>
    <circle cx="22" cy="22" r="${R}" class="ring-track"/>
    <circle cx="22" cy="22" r="${R}" class="ring-fill"
      stroke="${color}"
      stroke-dasharray="${C}"
      stroke-dashoffset="${offset}"/>
    <text x="22" y="22" class="ring-label">${pct}%</text>
  </svg>`;
}

// ---- Card ---------------------------------------------------
function buildCard(r) {
    const title = r.title_english || r.title_romaji || 'Unknown title';
    const genres = (r.genres || []).slice(0, 3).join(' · ');
    const topTags = (r.top_tags || []).slice(0, 4);
    const because = r.because_of
        ? (r.because_of.title_english || r.because_of.title_romaji)
        : null;
    const href = r.site_url || `https://anilist.co/manga/${r.id}`;

    const coverHTML = r.cover_image_url
        ? `<img class="card-cover" src="${r.cover_image_url}" alt="" loading="lazy">`
        : `<div class="cover-placeholder">${title}</div>`;

    return `
    <article class="card" data-id="${r.id}">
      <a class="card-link" href="${href}" target="_blank" rel="noopener noreferrer">
        <div class="card-cover-wrap">
          ${coverHTML}
          ${buildRingSVG(r.match_pct)}
        </div>
        <div class="card-body">
          <h3 class="card-title">${title}</h3>
          ${genres ? `<p class="card-genres">${genres}</p>` : ''}
          ${topTags.length ? `<div class="card-tags">${topTags.map(t => `<span class="card-tag">${t}</span>`).join('')}</div>` : ''}
          ${because ? `<p class="card-attribution">Because you liked <strong>${because}</strong></p>` : ''}
        </div>
      </a>
    </article>`;
}

// ---- UI state helpers ---------------------------------------
function setLoading(on) {
    searchBtn.disabled = on;
    btnText.textContent = on ? 'Loading…' : 'Recommend';
    btnSpinner.classList.toggle('hidden', !on);
}

function showError(msg) {
    emptyState.classList.add('hidden');
    resultsSection.classList.add('hidden');
    errorState.classList.remove('hidden');
    errorMessage.textContent = msg;
}

function showResults(data) {
    emptyState.classList.add('hidden');
    errorState.classList.add('hidden');
    resultsSection.classList.remove('hidden');

    resultsTitle.textContent = `Recommendations for ${data.username}`;
    resultsMeta.textContent =
        `${data.count} manga · ranked by similarity to your library` +
        (data.cached ? ' · cached result' : '');

    resultsGrid.innerHTML = data.results.map(buildCard).join('');
}

// ---- Fetch --------------------------------------------------
const ANILIST_ENDPOINT = 'https://graphql.anilist.co';

const USER_LIST_QUERY = `
query ($username: String) {
  User(name: $username) {
    name
    mediaListOptions { scoreFormat }
  }
  MediaListCollection(userName: $username, type: MANGA) {
    lists {
      entries {
        mediaId
        score
        status
      }
    }
  }
}`;

async function fetchAniListUserData(username) {
    const res = await fetch(ANILIST_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ query: USER_LIST_QUERY, variables: { username } }),
    });
    const data = await res.json();
    if (data.errors?.length) throw new Error(data.errors[0].message);
    if (!data.data?.User) throw new Error(`User "${username}" not found on AniList`);
    if (!data.data?.MediaListCollection) throw new Error(`${username}'s list is private`);
    const scoreFormat = data.data.User.mediaListOptions?.scoreFormat || 'POINT_10';
    const entries = data.data.MediaListCollection.lists.flatMap(l => l.entries).filter(Boolean);
    return { username: data.data.User.name, scoreFormat, entries };
}

async function fetchRecommendations(username) {
    setLoading(true);
    try {
        // Step 1: fetch user list directly from AniList (browser → AniList, no Worker involved)
        const userData = await fetchAniListUserData(username);

        // Step 2: send to our Worker which only does Postgres queries
        const res = await fetch('/api/recommend', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(userData),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Something went wrong — please try again.');
        showResults(data);
    } catch (err) {
        showError(err.message);
    } finally {
        setLoading(false);
    }
}

// ---- Form submit --------------------------------------------
form.addEventListener('submit', e => {
    e.preventDefault();
    const username = usernameInput.value.trim();
    if (username) fetchRecommendations(username);
});

// ---- Direct link: ?u=username -------------------------------
const urlUser = new URLSearchParams(window.location.search).get('u');
if (urlUser) {
    usernameInput.value = urlUser;
    fetchRecommendations(urlUser);
}