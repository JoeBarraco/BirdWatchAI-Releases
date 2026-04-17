// BirdWatchAI Community Feed - Views (feed, map, stats rendering)
// ── Render feed ──────────────────────────────────────────
function renderFeed() {
    let visible = applyClientFilters(allDetections);

    // Apply sort order
    const sortOrder = document.getElementById('sort-filter')?.value || 'recent';
    if (sortOrder === 'liked') {
        visible = [...visible].sort((a, b) => getReactionTotal(b.id) - getReactionTotal(a.id));
    } else if (sortOrder === 'commented') {
        visible = [...visible].sort((a, b) => (commentCounts[b.id] || 0) - (commentCounts[a.id] || 0));
    }

    const newTopId = visible[0]?.id ?? null;
    const hasNew   = lastTopId !== null && newTopId !== lastTopId;
    lastTopId      = newTopId;

    updateFeedCount();

    if (visible.length === 0) {
        document.getElementById('feed-view').innerHTML =
            '<div class="feed-empty">No detections match your filters.</div>';
        return;
    }

    // Compute first-of-season species set using cached full-year data
    const firstOfSeason = new Set();
    if (seasonEarliestBySpecies) {
        visible.forEach(d => {
            if (d.detected_at && seasonEarliestBySpecies[d.species] === d.detected_at) {
                firstOfSeason.add(d.id);
            }
        });
    }

    document.getElementById('feed-view').innerHTML = visible.map((d, i) => {
        const rarityClass = d.rarity
            ? 'rarity-' + d.rarity.toLowerCase().replace(/\s+/g, '-')
            : '';
        const isNew = hasNew && i === 0;
        const isFirst = firstOfSeason.has(d.id);
        const reactions = getReactions(d.id);

        const cCount = commentCounts[d.id] || 0;
        const onLifeList = currentUser && userLifeList.includes(d.species);
        const feederId = d.feeder_id || d.feeders?.id;
        const isFollowing = feederId && userFollowedFeeders.includes(feederId);

        return `
        <div class="card${isNew ? ' new' : ''}" data-id="${d.id}">
            ${d.image_url ? `<img src="${d.image_url}" alt="${esc(d.species)}" loading="lazy" data-carousel-species="${esc(d.species)}">` : ''}
            <div class="card-body">
                <div class="card-title">
                    <span class="species-link" data-species="${esc(d.species)}" style="cursor:pointer;text-decoration:underline dotted;">${esc(d.species)}</span>${d.rarity
                        ? ` <span class="${rarityClass}">· ${esc(d.rarity)}</span>` : ''}${isFirst
                        ? ' <span class="badge-first-season">🌱 First of Season</span>' : ''}${currentUser
                        ? `<button class="life-list-add-btn${onLifeList ? ' on-list' : ''}" onclick="toggleLifeListSpecies('${esc(d.species)}', '${d.id}', this)" title="${onLifeList ? 'Remove from life list' : 'Add to life list'}">${onLifeList ? '✓ Listed' : '+ Life List'}</button>` : ''}
                </div>
                <div class="card-meta">
                    🕐 ${fmtDetectedAt(d.detected_at)}${d.zip_code
                        ? ` · 📍 ${esc(d.zip_code)}` : ''}${d.temperature != null
                        ? ` · 🌡️ ${d.temperature}°F` : ''}
                </div>
                ${d.feeders?.display_name ? `<div class="card-feeder"><svg viewBox="0 0 24 24" width="1em" height="1em" aria-hidden="true" style="vertical-align:-.15em;flex-shrink:0"><rect x="5" y="11" width="14" height="10" fill="#f5b945"/><path d="M2 11L12 3L22 11Z" fill="#e68a1a"/><circle cx="12" cy="15" r="2.2" fill="#3d2a0d"/><rect x="11" y="17" width="2" height="2.5" fill="#8b5a2b"/></svg> ${esc(d.feeders.display_name)}${currentUser && feederId ? `<button class="follow-feeder-btn${isFollowing ? ' following' : ''}" onclick="toggleFollowFeeder('${feederId}', this)">${isFollowing ? '★ Following' : '☆ Follow'}</button>` : ''}</div>` : ''}
                <div class="card-reactions">
                    ${(() => {
                        const count = reactions['❤️'] || 0;
                        const reacted = isReacted(d.id, '❤️');
                        return `<button class="reaction-btn${reacted ? ' reacted' : ''}" data-reaction-id="${d.id}" data-emoji="❤️">❤️${count ? ' ' + count : ''}</button>${count ? `<button class="likers-btn" onclick="showLikers('${d.id}', this.parentElement)" title="See who liked">Liked by…</button>` : ''}`;
                    })()}
                </div>
                <div style="display:flex;align-items:center;flex-wrap:wrap;gap:0;">
                    ${d.video_url
                        ? `<a class="card-video" href="${d.video_url}" data-video-play="${d.video_url}" target="_blank" rel="noopener">🎬 Watch video</a>`
                        : ''}
                    <button class="card-ai" data-ai-species="${esc(d.species)}" title="Species info and links">🌐 Web</button>
                    <button class="card-share" data-share-id="${d.id}" title="Copy link to this detection">🔗 Share</button>
                    <button class="card-comment-btn" onclick="openComments('${d.id}')" title="Comments">💬${cCount ? ' ' + cCount : ''}</button>
                    <button class="card-flag-btn" onclick="openFlag('${d.id}')" title="Report this detection">🚩</button>
                </div>
                ${isModLoggedIn() ? `<div class="mod-actions">
                    <button onclick="openModEdit('${d.id}')">✏️ Edit</button>
                    <button class="mod-delete-btn" onclick="confirmModDelete('${d.id}')">🗑️ Delete</button>
                </div>` : ''}
            </div>
        </div>`;
    }).join('');
}

// ── Map layer toggle ─────────────────────────────────────
function setMapLayer(layer, btn) {
    mapLayer = layer;
    document.querySelectorAll('#map-layer-pins, #map-layer-heat')
        .forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    renderMap();
}

// ── Map rendering ────────────────────────────────────────
function initMap() {
    if (map) return;
    map = L.map('map').setView([39.5, -98.35], 4);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
        maxZoom: 18,
    }).addTo(map);
}

async function geocodeZip(zip) {
    if (zip in geocodeCache) return geocodeCache[zip];
    try {
        const res = await fetch(`https://api.zippopotam.us/us/${encodeURIComponent(zip)}`);
        if (!res.ok) { geocodeCache[zip] = null; return null; }
        const data = await res.json();
        const place = data.places?.[0];
        if (!place) { geocodeCache[zip] = null; return null; }
        const coords = { lat: parseFloat(place.latitude), lng: parseFloat(place.longitude) };
        geocodeCache[zip] = coords;
        return coords;
    } catch {
        geocodeCache[zip] = null;
        return null;
    }
}

// ── Species color palette ────────────────────────────────
const PALETTE = [
    '#e74c3c','#3498db','#2ecc71','#f39c12','#9b59b6',
    '#1abc9c','#e67e22','#e91e63','#00bcd4','#8bc34a',
    '#ff5722','#607d8b','#c0392b','#ff9800','#673ab7',
    '#2980b9','#27ae60','#d35400','#8e44ad','#16a085',
];
const speciesColorMap = {};
let paletteIdx = 0;

function speciesColor(species) {
    if (!speciesColorMap[species]) {
        speciesColorMap[species] = PALETTE[paletteIdx % PALETTE.length];
        paletteIdx++;
    }
    return speciesColorMap[species];
}

function makeIcon(color, count, pulse = false) {
    const label = count > 99 ? '99+' : String(count);
    return L.divIcon({
        className: '',
        html: `<div class="${pulse ? 'marker-new' : ''}" style="
            background:${color};
            width:32px;height:32px;border-radius:50%;
            display:flex;align-items:center;justify-content:center;
            color:#fff;font-weight:700;font-size:11px;font-family:sans-serif;
            border:2px solid rgba(255,255,255,0.9);
            box-shadow:0 2px 6px rgba(0,0,0,0.4);
            cursor:pointer;
        ">${label}</div>`,
        iconSize: [32, 32],
        iconAnchor: [16, 16],
        popupAnchor: [0, -20],
    });
}

function renderLegend(usedSpecies) {
    const legend = document.getElementById('map-legend');
    if (!legend) return;
    if (usedSpecies.length === 0) { legend.innerHTML = ''; return; }
    legend.innerHTML = usedSpecies.map(s =>
        `<span style="display:inline-flex;align-items:center;gap:5px;margin:3px 8px 3px 0;font-size:0.8rem;">
            <span style="display:inline-block;width:12px;height:12px;border-radius:50%;background:${speciesColor(s)};flex-shrink:0;"></span>
            ${esc(s)}
        </span>`
    ).join('');
}

async function renderMap() {
    initMap();

    const loading = document.getElementById('map-loading');
    const noData  = document.getElementById('map-no-data');

    if (markerGroup) { map.removeLayer(markerGroup); markerGroup = null; }
    if (heatLayer)   { map.removeLayer(heatLayer);   heatLayer   = null; }
    renderLegend([]);

    const speciesFilter = document.getElementById('map-species-filter').value;
    const visible = applyClientFilters(allDetections).filter(d =>
        !speciesFilter || d.species === speciesFilter
    );

    try {
        // Group detections by (location key, species)
        // locSpecies: "locKey|species" -> { lat, lng, species, count }
        let locSpecies = {};
        let allLatLngs = [];

        async function addDetections(detections, getKey) {
            for (const d of detections) {
                const sp  = d.species || 'Unknown';
                const key = `${getKey(d)}|${sp}`;
                if (!locSpecies[key]) {
                    locSpecies[key] = { lat: null, lng: null, species: sp, count: 0 };
                }
                locSpecies[key].count++;
                // coords set below after geocoding
            }
        }

        // ① Direct lat/lng
        const withCoords = visible.filter(d => d.latitude != null && d.longitude != null);
        if (withCoords.length > 0) {
            for (const d of withCoords) {
                const sp      = d.species || 'Unknown';
                const locKey  = `${(+d.latitude).toFixed(3)},${(+d.longitude).toFixed(3)}`;
                const fullKey = `${locKey}|${sp}`;
                if (!locSpecies[fullKey]) {
                    locSpecies[fullKey] = { lat: +d.latitude, lng: +d.longitude, species: sp, count: 0, images: [] };
                }
                locSpecies[fullKey].count++;
                locSpecies[fullKey].lat = +d.latitude;
                locSpecies[fullKey].lng = +d.longitude;
                if (d.image_url) locSpecies[fullKey].images.push(d.image_url);
            }

        // ② Zip geocoding
        } else {
            const zipDetections = {};
            for (const d of visible) {
                if (d.zip_code) {
                    if (!zipDetections[d.zip_code]) zipDetections[d.zip_code] = [];
                    zipDetections[d.zip_code].push(d);
                }
            }
            const uniqueZips = Object.keys(zipDetections);
            if (uniqueZips.length === 0) {
                noData.textContent = 'No location data for the current filters.';
                noData.style.display = '';
                return;
            }
            noData.style.display = 'none';

            loading.textContent = `Geocoding ${uniqueZips.length} location${uniqueZips.length !== 1 ? 's' : ''}…`;
            loading.style.display = 'block';
            const coords = await Promise.all(uniqueZips.map(z => geocodeZip(z)));
            loading.style.display = 'none';

            uniqueZips.forEach((zip, i) => {
                if (!coords[i]) return;
                for (const d of zipDetections[zip]) {
                    const sp      = d.species || 'Unknown';
                    const fullKey = `${zip}|${sp}`;
                    if (!locSpecies[fullKey]) {
                        locSpecies[fullKey] = { lat: coords[i].lat, lng: coords[i].lng, species: sp, count: 0, images: [] };
                    }
                    locSpecies[fullKey].count++;
                    if (d.image_url) locSpecies[fullKey].images.push(d.image_url);
                }
            });
        }

        const entries = Object.values(locSpecies).filter(e => e.lat != null);
        if (entries.length === 0) {
            noData.textContent = 'Could not resolve any locations. Check that zip codes are valid US zip codes.';
            noData.style.display = '';
            return;
        }
        noData.style.display = 'none';

        const usedSpecies = [...new Set(entries.map(e => e.species))].sort();
        const bounds = L.latLngBounds(entries.map(e => [e.lat, e.lng]));

        if (mapLayer === 'heat') {
            // ── Heatmap layer ──────────────────────────────────
            const heatPoints = entries.map(e => [e.lat, e.lng, e.count]);
            heatLayer = L.heatLayer(heatPoints, {
                radius: 35, blur: 25, maxZoom: 12,
                gradient: { 0.2: '#4575b4', 0.4: '#91cf60', 0.65: '#fee090', 0.85: '#f46d43', 1.0: '#a50026' },
            }).addTo(map);
            renderLegend([]);
        } else {
            // ── Pin layer ──────────────────────────────────────
            markerGroup = L.layerGroup().addTo(map);

            // Determine the newest detection's location key for pulse
            const newestD   = visible.slice().sort((a,b) => new Date(b.detected_at) - new Date(a.detected_at))[0];
            const newestKey = newestD
                ? (newestD.latitude != null
                    ? `${(+newestD.latitude).toFixed(3)},${(+newestD.longitude).toFixed(3)}`
                    : newestD.zip_code || '')
                : '';

            // Slight offset when multiple species share the same lat/lng
            const locOffset = {};
            for (const e of entries) {
                const locKey  = `${e.lat.toFixed(3)},${e.lng.toFixed(3)}`;
                const isNewest = e.locKey === newestKey || locKey === newestKey;
                if (!locOffset[locKey]) locOffset[locKey] = 0;
                const idx    = locOffset[locKey]++;
                const angle  = (idx * 137.5 * Math.PI) / 180; // golden angle spread
                const radius = idx === 0 ? 0 : 0.015;
                const lat    = e.lat + radius * Math.cos(angle);
                const lng    = e.lng + radius * Math.sin(angle);

                const color  = speciesColor(e.species);
                const marker = L.marker([lat, lng], { icon: makeIcon(color, e.count, isNewest) });

                const thumbs = e.images.slice(0, 6).map(url =>
                    `<img src="${url}" style="width:72px;height:54px;object-fit:cover;border-radius:4px;flex-shrink:0;" loading="lazy">`
                ).join('');
                const thumbGrid = thumbs
                    ? `<div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:6px;">${thumbs}</div>`
                    : '';

                marker.bindPopup(
                    `<div style="min-width:160px;">` +
                    `<strong style="font-size:0.95rem;">${esc(e.species)}</strong><br>` +
                    `<span style="font-size:0.8rem;color:#777;">${e.count} detection${e.count !== 1 ? 's' : ''}</span>` +
                    thumbGrid +
                    `<div style="margin-top:8px;">` +
                    `<a href="#" style="font-size:0.8rem;color:#2d5a3d;font-weight:600;" ` +
                    `onclick="event.preventDefault();filterBySpeciesFromMap(${JSON.stringify(e.species)})">` +
                    `View in feed →</a></div>` +
                    `</div>`,
                    { maxWidth: 260 }
                );
                marker.addTo(markerGroup);
            }
            renderLegend(usedSpecies);
        }

        // Fit map to all data points
        map.invalidateSize();
        map.fitBounds(bounds.pad(0.5), { maxZoom: 12 });

    } catch (err) {
        loading.style.display = 'none';
        noData.textContent = `Map error: ${err.message}`;
        noData.style.display = '';
    }
}

// ── View switching ───────────────────────────────────────
function switchView(view, btn) {
    // Manually switching tabs clears the back-to-stats context
    clearStatsContext();
    currentView = view;
    document.querySelectorAll('.view-tab').forEach(t => { t.classList.remove('active'); t.setAttribute('aria-selected', 'false'); });
    btn.classList.add('active');
    btn.setAttribute('aria-selected', 'true');

    document.getElementById('feed-view').style.display    = view === 'feed'    ? 'grid'  : 'none';
    document.getElementById('map-view').style.display     = view === 'map'     ? 'block' : 'none';
    document.getElementById('gallery-view').style.display = view === 'gallery' ? 'block' : 'none';
    document.getElementById('stats-view').style.display   = view === 'stats'   ? 'block' : 'none';

    // Stop likes polling when leaving stats view
    if (view !== 'stats') stopLikesPoll();

    if (view === 'map') {
        // Double rAF: wait for the browser to actually paint the div
        // before Leaflet measures its dimensions
        requestAnimationFrame(() => requestAnimationFrame(() => {
            if (!map) initMap();
            map.invalidateSize();
            renderMap();
        }));
    } else if (view === 'gallery') {
        loadAllThenRenderGallery();
    } else if (view === 'stats') {
        loadAllThenRenderStats();
    }
}

// ── Stats ────────────────────────────────────────────────
let activeStatsTab = 'life-list';

function stopLikesPoll() {
    clearInterval(likesPollInterval);
    likesPollInterval = null;
    clearTimeout(likesResortTimer);
    likesResortTimer = null;
}

// Auto-poll disabled: it caused a visible refresh flash every few seconds.
// The Likes panel now only updates in response to user actions (clicking a
// reaction triggers the debounced animated re-sort), switching to the
// Likes tab, or feed auto-refresh routing through resortLikesPanel below.
function startLikesPoll() { /* no-op */ }

async function renderFullStats() {
    renderStats();
    if (activeStatsTab === 'calendar') renderCalendar();
    if (activeStatsTab === 'records')  renderRecords();
    if (activeStatsTab === 'pairs')    renderPairs();
    if (activeStatsTab === 'compare')  renderCompare();
    if (activeStatsTab === 'trend')    renderTrend();
    if (activeStatsTab === 'likes') {
        // Surgical update only — avoids the "Loading reaction data…" flash
        // that renderLikesPanel would cause. If the panel hasn't been
        // rendered yet (no tbody), fall back to a full render.
        const panel = document.getElementById('stats-likes');
        if (panel && panel.querySelector('tbody')) {
            await resortLikesPanel();
        } else {
            await renderLikesPanel();
        }
    }
}

function switchStatsTab(tabName, btn) {
    activeStatsTab = tabName;
    document.querySelectorAll('.stats-tab').forEach(t => { t.classList.remove('active'); t.setAttribute('aria-selected', 'false'); });
    btn.classList.add('active');
    btn.setAttribute('aria-selected', 'true');
    // On mobile, scroll the active tab into view
    btn.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
    document.querySelectorAll('.stats-panel').forEach(p => p.style.display = 'none');
    document.getElementById('stats-' + tabName).style.display = '';
    if (tabName === 'calendar') renderCalendar();
    if (tabName === 'records')  renderRecords();
    if (tabName === 'pairs')    renderPairs();
    if (tabName === 'compare')  renderCompare();
    if (tabName === 'trend')    renderTrend();
    if (tabName === 'likes') {
        renderLikesPanel();
    } else {
        stopLikesPoll();
    }
}

function fmtHour(h) {
    if (h === 0)  return '12am';
    if (h < 12)   return h + 'am';
    if (h === 12) return '12pm';
    return (h - 12) + 'pm';
}

async function loadAllDetections() {
    if (feedExhausted) return;
    const { period } = getFilters();
    const since = periodToISO(period);
    let offset = allDetections.length;
    let done = false;
    while (!done) {
        let url = `${SUPABASE_URL}/rest/v1/community_detections?select=*,feeders(display_name)&limit=${PAGE_SIZE}&offset=${offset}&order=detected_at.desc`;
        if (since) url += `&detected_at=gte.${encodeURIComponent(since)}`;
        try {
            const res = await fetch(url, {
                headers: { apikey: ANON_KEY, Authorization: `Bearer ${ANON_KEY}` }
            });
            if (!res.ok) break;
            const page = await res.json();
            allDetections = [...allDetections, ...page];
            deduplicateDetections();
            offset += page.length;
            feedOffset = offset;
            if (page.length < PAGE_SIZE) { feedExhausted = true; done = true; }
        } catch (e) { done = true; }
    }
}

async function loadAllThenRenderStats() {
    await loadAllDetections();
    renderFullStats();
}

function renderStats() {
    if (currentView !== 'stats') return;
    const visible = applyClientFilters(allDetections);
    const total   = visible.length;

    // ── Month-over-month helpers ──────────────────────────
    const now        = new Date();
    const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1).toISOString();
    const lastMonthEnd   = thisMonthStart;

    const thisMo = applyClientFilters(allDetections).filter(d => d.detected_at >= thisMonthStart);
    const lastMo = applyClientFilters(allDetections).filter(d => d.detected_at >= lastMonthStart && d.detected_at < lastMonthEnd);

    function momDelta(curr, prev) {
        if (!prev) return '';
        const pct = Math.round(((curr - prev) / prev) * 100);
        if (pct === 0) return '';
        const arrow = pct > 0 ? '↑' : '↓';
        const color = pct > 0 ? '#2d5a3d' : '#c62828';
        return `<span style="font-size:0.7rem;color:${color};display:block;margin-top:2px;">${arrow}${Math.abs(pct)}% vs last month</span>`;
    }

    // ── Summary KPIs ─────────────────────────────────────
    const uniqueSpecies = new Set(visible.map(d => d.species).filter(Boolean));
    const uniqueZips    = new Set(visible.map(d => d.zip_code).filter(Boolean));
    const withTemp      = visible.filter(d => d.temperature != null);
    const avgTemp       = withTemp.length
        ? (withTemp.reduce((s, d) => s + d.temperature, 0) / withTemp.length).toFixed(1)
        : null;

    const thisTotal   = thisMo.length;
    const lastTotal   = lastMo.length;
    const thisSpecies = new Set(thisMo.map(d => d.species).filter(Boolean)).size;
    const lastSpecies = new Set(lastMo.map(d => d.species).filter(Boolean)).size;

    document.getElementById('stats-summary').innerHTML = `
        <div class="stats-kpi-row">
            <div class="stats-kpi">
                <div class="stats-kpi-value" id="kpi-total">0</div>
                <div class="stats-kpi-label">Total Detections</div>
                ${momDelta(thisTotal, lastTotal)}
            </div>
            <div class="stats-kpi">
                <div class="stats-kpi-value" id="kpi-species">0</div>
                <div class="stats-kpi-label">Species Seen</div>
                ${momDelta(thisSpecies, lastSpecies)}
            </div>
            <div class="stats-kpi">
                <div class="stats-kpi-value" id="kpi-locations">0</div>
                <div class="stats-kpi-label">Locations</div>
            </div>
            ${avgTemp !== null ? `<div class="stats-kpi">
                <div class="stats-kpi-value" id="kpi-temp">0</div>
                <div class="stats-kpi-label">Avg Temperature</div>
            </div>` : ''}
        </div>`;

    // Animate KPI values
    animateCount(document.getElementById('kpi-total'),     total);
    animateCount(document.getElementById('kpi-species'),   uniqueSpecies.size);
    animateCount(document.getElementById('kpi-locations'), uniqueZips.size);
    if (avgTemp !== null) {
        const tempEl = document.getElementById('kpi-temp');
        if (tempEl) {
            animateCount(tempEl, parseFloat(avgTemp));
            setTimeout(() => { if (tempEl) tempEl.textContent = avgTemp + '°F'; }, 700);
        }
    }

    // ── Life List ─────────────────────────────────────────
    const spMap = {};
    visible.forEach(d => {
        const sp = d.species || 'Unknown';
        if (!spMap[sp]) spMap[sp] = { count: 0, hours: new Array(24).fill(0), rarity: '' };
        spMap[sp].count++;
        spMap[sp].hours[new Date(d.detected_at).getHours()]++;
        if (!spMap[sp].rarity && d.rarity) spMap[sp].rarity = d.rarity;
    });

    const maxCount = Math.max(...Object.values(spMap).map(s => s.count), 1);
    const lifeList = Object.entries(spMap)
        .map(([name, data]) => ({
            name,
            count: data.count,
            pct: total > 0 ? ((data.count / total) * 100).toFixed(1) : '0.0',
            peakHour: data.hours.indexOf(Math.max(...data.hours)),
            rarity: data.rarity,
        }))
        .sort((a, b) => b.count - a.count);

    // ── Rarity mix (stacked bar at top of Life List) ──────
    const RARITY_ORDER = [
        { key: 'Very Rare', cls: 'very-rare', color: '#c62828' },
        { key: 'Rare',      cls: 'rare',      color: '#e65100' },
        { key: 'Uncommon',  cls: 'uncommon',  color: '#9e9e9e' },
        { key: 'Common',    cls: 'common',    color: '#2e7d32' },
    ];
    const rarityCounts = {};
    visible.forEach(d => {
        const r = d.rarity || 'Unknown';
        rarityCounts[r] = (rarityCounts[r] || 0) + 1;
    });
    const rarityTotal = Object.values(rarityCounts).reduce((a, b) => a + b, 0);
    const rarityMixHtml = rarityTotal === 0 ? '' : (() => {
        const segments = RARITY_ORDER
            .filter(r => rarityCounts[r.key])
            .map(r => {
                const c   = rarityCounts[r.key];
                const pct = (c / rarityTotal) * 100;
                return `<div class="rarity-mix-seg" style="width:${pct.toFixed(2)}%;background:${r.color};"
                           title="${r.key}: ${c.toLocaleString()} (${pct.toFixed(1)}%)"></div>`;
            }).join('');
        const unknown = rarityCounts['Unknown'];
        const unknownSeg = unknown
            ? `<div class="rarity-mix-seg" style="width:${((unknown / rarityTotal) * 100).toFixed(2)}%;background:#c8c4bd;"
                   title="Unknown: ${unknown.toLocaleString()}"></div>`
            : '';
        const legend = RARITY_ORDER
            .filter(r => rarityCounts[r.key])
            .map(r => {
                const c   = rarityCounts[r.key];
                const pct = ((c / rarityTotal) * 100).toFixed(1);
                return `<span class="rarity-mix-legend-item">
                    <span class="rarity-mix-swatch" style="background:${r.color};"></span>
                    ${r.key} · ${c.toLocaleString()} <span class="rarity-mix-pct">${pct}%</span>
                </span>`;
            }).join('') + (unknown
                ? `<span class="rarity-mix-legend-item">
                    <span class="rarity-mix-swatch" style="background:#c8c4bd;"></span>
                    Unknown · ${unknown.toLocaleString()}
                </span>`
                : '');
        return `
            <div class="rarity-mix-wrap">
                <div class="stats-section-title" style="margin-bottom:0.5rem;">Rarity Mix</div>
                <div class="rarity-mix-bar">${segments}${unknownSeg}</div>
                <div class="rarity-mix-legend">${legend}</div>
            </div>`;
    })();

    document.getElementById('stats-life-list').innerHTML = lifeList.length === 0
        ? '<div class="feed-empty">No data for the current filters.</div>'
        : `${rarityMixHtml}<table class="stats-table">
            <thead><tr>
                <th class="stats-rank">#</th><th>Species</th><th class="stats-count">Detections</th>
                <th class="stats-pct">% of Total</th><th class="stats-peak">Peak Hour</th><th></th>
            </tr></thead>
            <tbody>${lifeList.map((s, i) => `
                <tr>
                    <td class="stats-rank">${i + 1}</td>
                    <td class="stats-species-name">${esc(s.name)}${s.rarity
                        ? ` <span class="rarity-badge rarity-${s.rarity.toLowerCase().replace(/\s+/g,'-')}">${esc(s.rarity)}</span>`
                        : ''}</td>
                    <td class="stats-count">${s.count.toLocaleString()}</td>
                    <td class="stats-pct">
                        <span class="pct-bar-wrap"><span class="pct-bar" style="width:${(s.count/maxCount*100).toFixed(1)}%"></span></span>
                        ${s.pct}%
                    </td>
                    <td class="stats-peak">${fmtHour(s.peakHour)}</td>
                    <td><button class="stats-view-btn" data-species="${esc(s.name)}" onclick="filterBySpecies(this)">View</button></td>
                </tr>`).join('')}
            </tbody>
        </table>`;

    // ── Hourly & Daily Activity ───────────────────────────
    const hourCounts = new Array(24).fill(0);
    const dayCounts  = new Array(7).fill(0);
    visible.forEach(d => {
        const dt = new Date(d.detected_at);
        hourCounts[dt.getHours()]++;
        dayCounts[dt.getDay()]++;
    });
    const maxHour = Math.max(...hourCounts, 1);
    const maxDay  = Math.max(...dayCounts,  1);
    const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

    // Cache per-species hour buckets for the picker below (reuses spMap.hours)
    window._activitySpMap = spMap;

    // Species picker: default to the current species filter if set, otherwise the top species
    const activitySpeciesList = Object.entries(spMap)
        .sort((a, b) => b[1].count - a[1].count)
        .map(e => e[0]);
    const prevPick = document.getElementById('activity-species-pick')?.value;
    const defaultPick = activitySpeciesList.includes(prevPick)
        ? prevPick
        : (activitySpeciesList.includes(selectedSpecies) ? selectedSpecies : (activitySpeciesList[0] || ''));

    document.getElementById('stats-activity').innerHTML = `
        <div class="stats-section-title">Detections by Hour of Day</div>
        <div class="bar-chart-h">${hourCounts.map((c, h) => `
            <div class="bar-row">
                <div class="bar-label">${fmtHour(h)}</div>
                <div class="bar-track"><div class="bar-fill" style="width:${(c/maxHour*100).toFixed(1)}%"></div></div>
                <div class="bar-value">${c}</div>
            </div>`).join('')}
        </div>
        <div class="stats-section-title" style="margin-top:2rem;">Detections by Day of Week</div>
        <div class="bar-chart-h">${dayCounts.map((c, d) => `
            <div class="bar-row">
                <div class="bar-label">${DAY_NAMES[d]}</div>
                <div class="bar-track"><div class="bar-fill" style="width:${(c/maxDay*100).toFixed(1)}%"></div></div>
                <div class="bar-value">${c}</div>
            </div>`).join('')}
        </div>
        ${activitySpeciesList.length > 0 ? `
        <div class="stats-section-title" style="margin-top:2rem;display:flex;flex-wrap:wrap;align-items:center;gap:0.75rem;">
            <span>Diurnal Pattern by Species</span>
            <select id="activity-species-pick" class="filter-select" style="font-size:0.8rem;"
                    onchange="renderActivitySpeciesChart()">
                ${activitySpeciesList.map(sp => `
                    <option value="${esc(sp)}"${sp === defaultPick ? ' selected' : ''}>${esc(sp)}</option>`).join('')}
            </select>
        </div>
        <div id="activity-species-chart"></div>` : ''}`;

    if (activitySpeciesList.length > 0) renderActivitySpeciesChart();

    // ── Hotspots ──────────────────────────────────────────
    const zipStats = {};
    visible.forEach(d => {
        if (!d.zip_code) return;
        if (!zipStats[d.zip_code]) zipStats[d.zip_code] = { count: 0, species: new Set() };
        zipStats[d.zip_code].count++;
        if (d.species) zipStats[d.zip_code].species.add(d.species);
    });
    const maxZip   = Math.max(...Object.values(zipStats).map(z => z.count), 1);
    const hotspots = Object.entries(zipStats)
        .map(([zip, data]) => ({ zip, count: data.count, species: data.species.size }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 25);

    document.getElementById('stats-hotspots').innerHTML = hotspots.length === 0
        ? '<div class="feed-empty">No location data for the current filters.</div>'
        : `<table class="stats-table">
            <thead><tr>
                <th class="stats-rank">#</th><th>Zip Code</th><th class="stats-count">Detections</th>
                <th class="stats-pct">% of Total</th><th class="stats-count">Unique Species</th>
            </tr></thead>
            <tbody>${hotspots.map((h, i) => `
                <tr>
                    <td class="stats-rank">${i + 1}</td>
                    <td class="stats-species-name">${esc(h.zip)}</td>
                    <td class="stats-count">${h.count.toLocaleString()}</td>
                    <td class="stats-pct">
                        <span class="pct-bar-wrap"><span class="pct-bar" style="width:${(h.count/maxZip*100).toFixed(1)}%"></span></span>
                        ${total > 0 ? ((h.count/total)*100).toFixed(1) : '0.0'}%
                    </td>
                    <td class="stats-count">${h.species}</td>
                </tr>`).join('')}
            </tbody>
        </table>`;

    // ── Temperature ───────────────────────────────────────
    const TEMP_RANGES = [
        { label: 'Below 32°F', min: -Infinity, max: 32,       count: 0, species: new Set(), spCounts: {} },
        { label: '32 – 50°F',  min: 32,        max: 50,       count: 0, species: new Set(), spCounts: {} },
        { label: '50 – 70°F',  min: 50,        max: 70,       count: 0, species: new Set(), spCounts: {} },
        { label: '70 – 85°F',  min: 70,        max: 85,       count: 0, species: new Set(), spCounts: {} },
        { label: 'Above 85°F', min: 85,        max: Infinity, count: 0, species: new Set(), spCounts: {} },
    ];
    let tempTotal = 0;
    visible.forEach(d => {
        if (d.temperature == null) return;
        tempTotal++;
        const r = TEMP_RANGES.find(r => d.temperature >= r.min && d.temperature < r.max);
        if (r) {
            r.count++;
            if (d.species) {
                r.species.add(d.species);
                r.spCounts[d.species] = (r.spCounts[d.species] || 0) + 1;
            }
        }
    });
    const maxTemp = Math.max(...TEMP_RANGES.map(r => r.count), 1);

    const topSpFor = r => Object.entries(r.spCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([sp, c]) => `<span class="temp-topsp-chip">${esc(sp)} <span class="temp-topsp-count">${c}</span></span>`)
        .join('');

    document.getElementById('stats-temperature').innerHTML = tempTotal === 0
        ? '<div class="feed-empty">No temperature data for the current filters.</div>'
        : `<div class="stats-section-title">Detections by Temperature Range</div>
           <div class="bar-chart-h">${TEMP_RANGES.map(r => `
               <div class="bar-row">
                   <div class="bar-label-wide">${r.label}</div>
                   <div class="bar-track"><div class="bar-fill" style="width:${(r.count/maxTemp*100).toFixed(1)}%"></div></div>
                   <div class="bar-value">${r.count} <span class="bar-sub">${r.species.size} sp.</span></div>
               </div>`).join('')}
           </div>
           <div class="stats-section-title" style="margin-top:2rem;">Top Species by Temperature Band</div>
           <table class="stats-table temp-topsp-table">
               <thead><tr><th>Temperature</th><th>Top 3 Species</th></tr></thead>
               <tbody>${TEMP_RANGES.filter(r => r.count > 0).map(r => `
                   <tr>
                       <td class="stats-species-name" style="white-space:nowrap;">${r.label}</td>
                       <td>${topSpFor(r) || '<span style="color:var(--color-gray-500);">—</span>'}</td>
                   </tr>`).join('')}
               </tbody>
           </table>`;

    // ── Leaderboard ───────────────────────────────────────
    const feederStats = {};
    visible.forEach(d => {
        const name = d.feeders?.display_name;
        if (!name) return;
        if (!feederStats[name]) feederStats[name] = { count: 0, species: new Set(), rareCount: 0, days: new Set() };
        feederStats[name].count++;
        if (d.species) feederStats[name].species.add(d.species);
        if (d.rarity === 'Rare' || d.rarity === 'Very Rare') feederStats[name].rareCount++;
        feederStats[name].days.add(d.detected_at.slice(0, 10));
    });

    function calcStreak(daysSet) {
        const sorted = [...daysSet].sort().reverse();
        if (!sorted.length) return 0;
        const today     = new Date().toISOString().slice(0, 10);
        const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
        if (sorted[0] !== today && sorted[0] !== yesterday) return 0;
        let streak = 1;
        for (let i = 1; i < sorted.length; i++) {
            const diff = Math.round((new Date(sorted[i-1]) - new Date(sorted[i])) / 86400000);
            if (diff === 1) streak++; else break;
        }
        return streak;
    }

    const maxFeeder = Math.max(...Object.values(feederStats).map(f => f.count), 1);
    const leaderboard = Object.entries(feederStats)
        .map(([name, data]) => ({
            name, count: data.count, species: data.species.size,
            rareCount: data.rareCount, streak: calcStreak(data.days),
        }))
        .sort((a, b) => b.count - a.count);

    const medals = ['🥇', '🥈', '🥉'];

    document.getElementById('stats-leaderboard').innerHTML = leaderboard.length === 0
        ? '<div class="feed-empty">No feeder data for the current filters.</div>'
        : `<table class="stats-table">
            <thead><tr>
                <th class="stats-rank">#</th><th>Feeder</th><th class="stats-count">Detections</th>
                <th class="stats-pct">% of Total</th><th class="stats-count">Species</th><th class="stats-count">Streak</th><th class="stats-count">Rare / Very Rare</th>
            </tr></thead>
            <tbody>${leaderboard.map((f, i) => `
                <tr>
                    <td class="stats-rank">${medals[i] ?? i + 1}</td>
                    <td class="stats-species-name">${esc(f.name)}</td>
                    <td class="stats-count">${f.count.toLocaleString()}</td>
                    <td class="stats-pct">
                        <span class="pct-bar-wrap"><span class="pct-bar" style="width:${(f.count/maxFeeder*100).toFixed(1)}%"></span></span>
                        ${total > 0 ? ((f.count/total)*100).toFixed(1) : '0.0'}%
                    </td>
                    <td class="stats-count">${f.species}</td>
                    <td class="stats-count">${f.streak >= 7 ? `🔥 ${f.streak}d <span class="streak-badge">HOT</span>` : f.streak > 0 ? `🔥 ${f.streak}d` : '—'}</td>
                    <td class="stats-count">${f.rareCount > 0 ? `<span style="color:#d32f2f;font-weight:600;">${f.rareCount}</span>` : '—'}</td>
                </tr>`).join('')}
            </tbody>
        </table>`;
}

// ── Per-species diurnal chart (Activity tab) ─────────────
function renderActivitySpeciesChart() {
    const chartEl = document.getElementById('activity-species-chart');
    const pick    = document.getElementById('activity-species-pick')?.value;
    const spMap   = window._activitySpMap || {};
    if (!chartEl || !pick || !spMap[pick]) return;
    const hours  = spMap[pick].hours;
    const maxVal = Math.max(...hours, 1);
    chartEl.innerHTML = `
        <div class="bar-chart-h">${hours.map((c, h) => `
            <div class="bar-row">
                <div class="bar-label">${fmtHour(h)}</div>
                <div class="bar-track"><div class="bar-fill" style="width:${(c/maxVal*100).toFixed(1)}%"></div></div>
                <div class="bar-value">${c}</div>
            </div>`).join('')}
        </div>`;
}

// ── Trend chart ──────────────────────────────────────────
let trendPeriod      = '';        // '' = all time
let trendHiddenSp    = new Set(); // species toggled off by user

function setTrendPeriod(period, btn) {
    trendPeriod = period;
    document.querySelectorAll('.trend-period-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    renderTrend();
}

function toggleTrendSpecies(sp) {
    if (trendHiddenSp.has(sp)) trendHiddenSp.delete(sp);
    else trendHiddenSp.add(sp);
    renderTrendChart();   // only redraw chart + legend, keep controls
}

function renderTrend() {
    const visible = applyClientFilters(allDetections);
    const panel   = document.getElementById('stats-trend');
    if (!visible.length) {
        panel.innerHTML = '<div class="feed-empty">No data for the current filters.</div>';
        return;
    }

    // Apply trend-specific time filter
    let since = null;
    if (trendPeriod) {
        const now = new Date();
        if (trendPeriod === '7d')  { const d = new Date(now); d.setDate(d.getDate() - 7);  since = d.toISOString(); }
        if (trendPeriod === '14d') { const d = new Date(now); d.setDate(d.getDate() - 14); since = d.toISOString(); }
        if (trendPeriod === '30d') { const d = new Date(now); d.setDate(d.getDate() - 30); since = d.toISOString(); }
        if (trendPeriod === '90d') { const d = new Date(now); d.setDate(d.getDate() - 90); since = d.toISOString(); }
    }
    const filtered = since ? visible.filter(d => d.detected_at >= since) : visible;

    if (!filtered.length) {
        panel.innerHTML = '<div class="feed-empty">No data for the selected timeframe.</div>';
        return;
    }

    // Build species totals (all species, sorted by count)
    const spTotals = {};
    filtered.forEach(d => { spTotals[d.species || 'Unknown'] = (spTotals[d.species || 'Unknown'] || 0) + 1; });
    window._trendAllSpecies = Object.entries(spTotals).sort((a,b) => b[1]-a[1]).map(e => e[0]);
    window._trendFiltered   = filtered;

    // Build controls + chart container
    panel.innerHTML = `
        <div class="stats-section-title">Detections Over Time</div>
        <div class="trend-controls">
            <button class="trend-period-btn period-btn${trendPeriod === '' ? ' active' : ''}" onclick="setTrendPeriod('', this)">All Time</button>
            <button class="trend-period-btn period-btn${trendPeriod === '7d' ? ' active' : ''}" onclick="setTrendPeriod('7d', this)">7 Days</button>
            <button class="trend-period-btn period-btn${trendPeriod === '14d' ? ' active' : ''}" onclick="setTrendPeriod('14d', this)">14 Days</button>
            <button class="trend-period-btn period-btn${trendPeriod === '30d' ? ' active' : ''}" onclick="setTrendPeriod('30d', this)">30 Days</button>
            <button class="trend-period-btn period-btn${trendPeriod === '90d' ? ' active' : ''}" onclick="setTrendPeriod('90d', this)">90 Days</button>
        </div>
        <div id="trend-legend" style="margin-bottom:0.75rem;"></div>
        <div id="trend-chart"></div>`;

    renderTrendChart();
}

function renderTrendChart() {
    const allSpecies = window._trendAllSpecies || [];
    const filtered   = window._trendFiltered   || [];
    const shownSpecies = allSpecies.filter(sp => !trendHiddenSp.has(sp));

    // Day buckets
    const dayMap = {};
    filtered.forEach(d => {
        const day = d.detected_at.slice(0, 10);
        if (!dayMap[day]) dayMap[day] = {};
        const sp = d.species || 'Unknown';
        dayMap[day][sp] = (dayMap[day][sp] || 0) + 1;
    });
    const days = Object.keys(dayMap).sort();

    // Legend (clickable)
    const legendEl = document.getElementById('trend-legend');
    if (legendEl) {
        legendEl.innerHTML = allSpecies.map((sp, i) => {
            const color = PALETTE[i % PALETTE.length];
            const hidden = trendHiddenSp.has(sp);
            return `<span onclick="toggleTrendSpecies('${esc(sp).replace(/'/g, "\\'")}')"
                style="display:inline-flex;align-items:center;gap:5px;margin-right:14px;font-size:0.8rem;cursor:pointer;${hidden ? 'opacity:0.3;text-decoration:line-through;' : ''}">
                <span style="display:inline-block;width:18px;height:3px;background:${color};border-radius:2px;"></span>${esc(sp)}
            </span>`;
        }).join('');
    }

    const chartEl = document.getElementById('trend-chart');
    if (!chartEl) return;

    if (days.length < 2) {
        chartEl.innerHTML = '<div class="feed-empty">Not enough data to draw a trend (need at least 2 days).</div>';
        return;
    }

    // Use stable color indices based on position in allSpecies
    const spColorIdx = {};
    allSpecies.forEach((sp, i) => { spColorIdx[sp] = i; });

    // SVG dimensions
    const W = 700, H = 260, PAD = { top: 20, right: 20, bottom: 50, left: 45 };
    const chartW = W - PAD.left - PAD.right;
    const chartH = H - PAD.top  - PAD.bottom;

    const maxVal = Math.max(...shownSpecies.map(sp => Math.max(...days.map(d => dayMap[d][sp] || 0))), 1);

    const xScale = i => PAD.left + (i / (days.length - 1)) * chartW;
    const yScale = v => PAD.top  + chartH - (v / maxVal) * chartH;

    // Y grid lines
    const yTicks = 4;
    let gridLines = '', yLabels = '';
    for (let t = 0; t <= yTicks; t++) {
        const v = Math.round((t / yTicks) * maxVal);
        const y = yScale(v);
        gridLines += `<line x1="${PAD.left}" y1="${y}" x2="${PAD.left + chartW}" y2="${y}" stroke="#e8e4de" stroke-width="1"/>`;
        yLabels   += `<text x="${PAD.left - 6}" y="${y + 4}" text-anchor="end" font-size="11" fill="#7a756d">${v}</text>`;
    }

    // X axis labels
    let xLabels = '';
    const labelStep = Math.max(1, Math.floor(days.length / 10));
    days.forEach((day, i) => {
        if (i % labelStep !== 0 && i !== days.length - 1) return;
        const x = xScale(i);
        const label = day.slice(5);
        xLabels += `<text x="${x}" y="${H - PAD.bottom + 16}" text-anchor="middle" font-size="10" fill="#7a756d">${label}</text>`;
    });

    // Polylines per shown species
    let polylines = '', dots = '';
    shownSpecies.forEach(sp => {
        const color = PALETTE[spColorIdx[sp] % PALETTE.length];
        const pts = days.map((d, i) => `${xScale(i)},${yScale(dayMap[d][sp] || 0)}`).join(' ');
        polylines += `<polyline points="${pts}" fill="none" stroke="${color}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round" opacity="0.85"/>`;
        days.forEach((d, i) => {
            const v = dayMap[d][sp] || 0;
            if (v > 0) dots += `<circle cx="${xScale(i)}" cy="${yScale(v)}" r="3.5" fill="${color}" stroke="white" stroke-width="1.5"><title>${sp}: ${v} on ${d}</title></circle>`;
        });
    });

    // Rarity markers — show Rare / Very Rare as distinctive symbols above the baseline
    // so unusual sightings are easy to spot even when their species line is hidden.
    const RARE_COLOR      = '#e65100';
    const VERY_RARE_COLOR = '#c62828';
    const dayIdx = {};
    days.forEach((d, i) => { dayIdx[d] = i; });
    const rareByDay = {};  // day -> {rare:[species], veryRare:[species]}
    filtered.forEach(d => {
        if (!d.rarity || (d.rarity !== 'Rare' && d.rarity !== 'Very Rare')) return;
        const day = d.detected_at.slice(0, 10);
        if (!(day in dayIdx)) return;
        if (!rareByDay[day]) rareByDay[day] = { rare: [], veryRare: [] };
        const bucket = d.rarity === 'Very Rare' ? rareByDay[day].veryRare : rareByDay[day].rare;
        if (d.species && !bucket.includes(d.species)) bucket.push(d.species);
    });
    let rarityMarkers = '';
    Object.entries(rareByDay).forEach(([day, data]) => {
        const x = xScale(dayIdx[day]);
        const y = PAD.top + chartH - 6;
        if (data.veryRare.length) {
            const title = `Very Rare on ${day}: ${data.veryRare.join(', ')}`;
            rarityMarkers += `<polygon points="${x - 5},${y + 4} ${x + 5},${y + 4} ${x},${y - 6}"
                fill="${VERY_RARE_COLOR}" stroke="white" stroke-width="1.25">
                <title>${esc(title)}</title></polygon>`;
        }
        if (data.rare.length && !data.veryRare.length) {
            const title = `Rare on ${day}: ${data.rare.join(', ')}`;
            rarityMarkers += `<polygon points="${x - 5},${y + 4} ${x + 5},${y + 4} ${x},${y - 6}"
                fill="${RARE_COLOR}" stroke="white" stroke-width="1.25">
                <title>${esc(title)}</title></polygon>`;
        }
    });
    const hasAnyRare     = Object.values(rareByDay).some(r => r.rare.length);
    const hasAnyVeryRare = Object.values(rareByDay).some(r => r.veryRare.length);
    const rarityLegend = (hasAnyRare || hasAnyVeryRare)
        ? `<div class="trend-rarity-legend">
            ${hasAnyVeryRare ? `<span class="trend-rarity-legend-item">
                <span class="trend-rarity-swatch" style="border-bottom-color:${VERY_RARE_COLOR};"></span>Very Rare
            </span>` : ''}
            ${hasAnyRare ? `<span class="trend-rarity-legend-item">
                <span class="trend-rarity-swatch" style="border-bottom-color:${RARE_COLOR};"></span>Rare
            </span>` : ''}
        </div>`
        : '';

    chartEl.innerHTML = `
        <div class="trend-svg-wrap">
            <svg viewBox="0 0 ${W} ${H}" width="100%" style="max-width:${W}px;display:block;">
                ${gridLines}${yLabels}
                <line x1="${PAD.left}" y1="${PAD.top}" x2="${PAD.left}" y2="${PAD.top+chartH}" stroke="#d0cbc3" stroke-width="1"/>
                <line x1="${PAD.left}" y1="${PAD.top+chartH}" x2="${PAD.left+chartW}" y2="${PAD.top+chartH}" stroke="#d0cbc3" stroke-width="1"/>
                ${xLabels}${polylines}${dots}
                ${rarityMarkers}
            </svg>
            ${rarityLegend}
        </div>`;
}

// ── Calendar heatmap ─────────────────────────────────────
function renderCalendar() {
    const panel = document.getElementById('stats-calendar');
    if (!panel) return;
    const visible = applyClientFilters(allDetections);
    if (!visible.length) {
        panel.innerHTML = '<div class="feed-empty">No data for the current filters.</div>';
        return;
    }

    // Count detections per local day (YYYY-MM-DD)
    const dayCounts = {};
    visible.forEach(d => {
        const key = d.detected_at.slice(0, 10);
        dayCounts[key] = (dayCounts[key] || 0) + 1;
    });

    // Always show a full 53-week span ending at the most recent detection
    // (GitHub-style). This keeps the heatmap a consistent width even when
    // only a few weeks of data exist.
    const keys = Object.keys(dayCounts).sort();
    // Use UTC throughout so slicing detected_at (UTC ISO) lines up with cells
    const firstDay = new Date(keys[0] + 'T00:00:00Z');
    const lastDay  = new Date(keys[keys.length - 1] + 'T00:00:00Z');
    const spanDays = 53 * 7;
    const startDate = new Date(lastDay.getTime() - (spanDays - 1) * 86400000);

    // Align start to the preceding Sunday (UTC) so weeks line up as columns
    const alignedStart = new Date(startDate);
    alignedStart.setUTCDate(alignedStart.getUTCDate() - alignedStart.getUTCDay());

    // Build cells week-by-week
    const MS = 86400000;
    const cells = [];
    for (let t = alignedStart.getTime(); t <= lastDay.getTime(); t += MS) {
        const d   = new Date(t);
        const key = d.toISOString().slice(0, 10);
        cells.push({ date: d, key, count: dayCounts[key] || 0, inRange: d >= startDate });
    }

    // Compute color scale from non-zero days
    const nonZero = cells.map(c => c.count).filter(c => c > 0);
    const maxCount = nonZero.length ? Math.max(...nonZero) : 1;
    function shade(c) {
        if (c === 0) return 'var(--color-gray-100)';
        const ratio = c / maxCount;
        if (ratio < 0.25) return '#c8e6c9';
        if (ratio < 0.50) return '#81c784';
        if (ratio < 0.75) return '#4caf50';
        return '#2d5a3d';
    }

    // SVG layout
    const CELL = 12, GAP = 2, STEP = CELL + GAP;
    const weeks = Math.ceil(cells.length / 7);
    const W = 40 + weeks * STEP;
    const H = 20 + 7 * STEP + 14;  // +14 for bottom padding

    // Month labels at the top
    const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    let monthLabels = '';
    let prevMonth = -1;
    for (let w = 0; w < weeks; w++) {
        const cell = cells[w * 7];
        if (!cell) continue;
        const m = cell.date.getUTCMonth();
        if (m !== prevMonth) {
            prevMonth = m;
            monthLabels += `<text x="${40 + w * STEP}" y="12" font-size="10" fill="#7a756d">${MONTHS[m]}</text>`;
        }
    }

    // Day-of-week labels
    const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const dowLabels = DOW.map((name, i) =>
        (i % 2 === 1)
            ? `<text x="34" y="${20 + i * STEP + CELL - 2}" text-anchor="end" font-size="9" fill="#7a756d">${name}</text>`
            : ''
    ).join('');

    // Cell rects
    let rects = '';
    cells.forEach((c, idx) => {
        if (!c.inRange) return;
        const w   = Math.floor(idx / 7);
        const dow = idx % 7;
        const x   = 40 + w * STEP;
        const y   = 20 + dow * STEP;
        const title = c.count === 0
            ? `${c.key} — no detections`
            : `${c.key} — ${c.count} detection${c.count === 1 ? '' : 's'}`;
        rects += `<rect x="${x}" y="${y}" width="${CELL}" height="${CELL}" rx="2" ry="2"
                    fill="${shade(c.count)}" stroke="var(--border)" stroke-width="0.5">
                    <title>${title}</title>
                  </rect>`;
    });

    // Legend (shade scale)
    const legendShades = [0, 1, Math.round(maxCount * 0.375), Math.round(maxCount * 0.625), maxCount];
    const legendRects = legendShades.map((c, i) => `
        <rect x="${i * (CELL + 2)}" y="0" width="${CELL}" height="${CELL}" rx="2" ry="2"
              fill="${shade(c)}" stroke="var(--border)" stroke-width="0.5"/>
    `).join('');

    // Summary totals
    const daysWithActivity = Object.keys(dayCounts).length;
    const totalDays = Math.round((lastDay - startDate) / MS) + 1;
    const activePct = totalDays > 0 ? ((daysWithActivity / totalDays) * 100).toFixed(0) : 0;
    const bestDay = cells.reduce((best, c) => c.count > (best?.count || 0) ? c : best, null);

    panel.innerHTML = `
        <div class="stats-section-title">Detection Calendar</div>
        <div style="font-size:0.8rem;color:var(--color-gray-500);margin-bottom:0.75rem;">
            ${daysWithActivity} active day${daysWithActivity === 1 ? '' : 's'} out of ${totalDays}
            (${activePct}% coverage)${bestDay
                ? ` &middot; busiest day: <strong>${bestDay.key}</strong> with ${bestDay.count} detections`
                : ''}
        </div>
        <div class="calendar-wrap">
            <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet"
                 style="display:block;width:100%;height:auto;max-height:240px;">
                ${monthLabels}
                ${dowLabels}
                ${rects}
            </svg>
        </div>
        <div class="calendar-legend">
            <span style="font-size:0.72rem;color:var(--color-gray-500);">Less</span>
            <svg width="${(CELL + 2) * legendShades.length}" height="${CELL}" style="vertical-align:middle;">
                ${legendRects}
            </svg>
            <span style="font-size:0.72rem;color:var(--color-gray-500);">More</span>
        </div>`;
}

// ── Records ──────────────────────────────────────────────
function renderRecords() {
    const panel = document.getElementById('stats-records');
    if (!panel) return;
    const visible = applyClientFilters(allDetections);
    if (!visible.length) {
        panel.innerHTML = '<div class="feed-empty">No data for the current filters.</div>';
        return;
    }

    // Group by day + hour
    const byDay  = {};  // day -> { count, species:Set }
    const byHour = {};  // 'YYYY-MM-DD HH' -> count
    const firstSeen = {};  // species -> earliest ISO
    const lastSeen  = {};  // species -> latest ISO
    visible.forEach(d => {
        const day = d.detected_at.slice(0, 10);
        const hk  = d.detected_at.slice(0, 13);
        if (!byDay[day]) byDay[day] = { count: 0, species: new Set() };
        byDay[day].count++;
        if (d.species) byDay[day].species.add(d.species);
        byHour[hk] = (byHour[hk] || 0) + 1;
        if (d.species) {
            if (!firstSeen[d.species] || d.detected_at < firstSeen[d.species]) firstSeen[d.species] = d.detected_at;
            if (!lastSeen[d.species]  || d.detected_at > lastSeen[d.species])  lastSeen[d.species]  = d.detected_at;
        }
    });

    // Biggest day / biggest species-on-day / biggest hour
    const sortedDays = Object.entries(byDay).sort((a, b) => b[1].count - a[1].count);
    const bigDay     = sortedDays[0];
    const mostSpDay  = Object.entries(byDay).sort((a, b) => b[1].species.size - a[1].species.size)[0];
    const bigHourEntry = Object.entries(byHour).sort((a, b) => b[1] - a[1])[0];
    const bigHourLabel = bigHourEntry
        ? `${bigHourEntry[0].slice(0, 10)} ${fmtHour(parseInt(bigHourEntry[0].slice(11, 13), 10))}`
        : '—';

    // Streaks (active-day streaks based on consecutive days)
    const daySet    = new Set(Object.keys(byDay));
    const sortedAsc = [...daySet].sort();
    let longestStreak = 0, runLen = 0, prevDate = null;
    sortedAsc.forEach(day => {
        if (prevDate) {
            const diff = Math.round((new Date(day) - new Date(prevDate)) / 86400000);
            if (diff === 1) runLen++;
            else runLen = 1;
        } else {
            runLen = 1;
        }
        if (runLen > longestStreak) longestStreak = runLen;
        prevDate = day;
    });
    // Current streak (must include today or yesterday)
    const todayKey     = new Date().toISOString().slice(0, 10);
    const yesterdayKey = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    let currentStreak = 0;
    if (daySet.has(todayKey) || daySet.has(yesterdayKey)) {
        let cursor = daySet.has(todayKey) ? new Date(todayKey) : new Date(yesterdayKey);
        while (daySet.has(cursor.toISOString().slice(0, 10))) {
            currentStreak++;
            cursor.setDate(cursor.getDate() - 1);
        }
    }

    // New arrivals: species whose first detection (within the loaded data) is in the past 14 days
    const cutoffNew = new Date(Date.now() - 14 * 86400000).toISOString();
    const arrivals = Object.entries(firstSeen)
        .filter(([, iso]) => iso >= cutoffNew)
        .sort((a, b) => b[1].localeCompare(a[1]))
        .slice(0, 10);

    // Dormant: species whose last detection was > 30 days ago
    const cutoffDormant = new Date(Date.now() - 30 * 86400000).toISOString();
    const dormant = Object.entries(lastSeen)
        .filter(([, iso]) => iso < cutoffDormant)
        .sort((a, b) => a[1].localeCompare(b[1]))  // longest-dormant first
        .slice(0, 10);

    const fmtDaysAgo = (iso) => {
        const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
        if (days === 0) return 'today';
        if (days === 1) return 'yesterday';
        return `${days}d ago`;
    };

    panel.innerHTML = `
        <div class="stats-section-title">Records &amp; Highlights</div>
        <div class="records-grid">
            <div class="record-card">
                <div class="record-label">Busiest day</div>
                <div class="record-value">${bigDay ? bigDay[1].count.toLocaleString() : '—'}</div>
                <div class="record-sub">${bigDay ? bigDay[0] : ''}</div>
            </div>
            <div class="record-card">
                <div class="record-label">Most species in a day</div>
                <div class="record-value">${mostSpDay ? mostSpDay[1].species.size : '—'}</div>
                <div class="record-sub">${mostSpDay ? mostSpDay[0] : ''}</div>
            </div>
            <div class="record-card">
                <div class="record-label">Busiest hour</div>
                <div class="record-value">${bigHourEntry ? bigHourEntry[1].toLocaleString() : '—'}</div>
                <div class="record-sub">${bigHourLabel}</div>
            </div>
            <div class="record-card">
                <div class="record-label">Current streak</div>
                <div class="record-value">${currentStreak > 0 ? '🔥 ' + currentStreak + 'd' : '—'}</div>
                <div class="record-sub">${currentStreak >= 7 ? 'on fire!' : 'consecutive active days'}</div>
            </div>
            <div class="record-card">
                <div class="record-label">Longest streak</div>
                <div class="record-value">${longestStreak > 0 ? longestStreak + 'd' : '—'}</div>
                <div class="record-sub">best run in this window</div>
            </div>
            <div class="record-card">
                <div class="record-label">Active days</div>
                <div class="record-value">${daySet.size}</div>
                <div class="record-sub">days with detections</div>
            </div>
        </div>

        <div class="records-lists">
            <div class="records-list-col">
                <div class="stats-section-title" style="margin-top:1.5rem;">🆕 New Arrivals (first seen in last 14 days)</div>
                ${arrivals.length === 0
                    ? '<div style="color:var(--color-gray-500);font-size:0.875rem;padding:0.5rem 0;">No new species in the past 14 days.</div>'
                    : `<table class="stats-table">
                        <thead><tr><th>Species</th><th class="stats-count">First Seen</th><th></th></tr></thead>
                        <tbody>${arrivals.map(([sp, iso]) => `
                            <tr>
                                <td class="stats-species-name">${esc(sp)}</td>
                                <td class="stats-count">${fmtDaysAgo(iso)}</td>
                                <td style="text-align:right;">
                                    <button class="stats-view-btn" data-species="${esc(sp)}" onclick="filterBySpecies(this)">View</button>
                                </td>
                            </tr>`).join('')}
                        </tbody>
                    </table>`}
            </div>
            <div class="records-list-col">
                <div class="stats-section-title" style="margin-top:1.5rem;">💤 Dormant (not seen in 30+ days)</div>
                ${dormant.length === 0
                    ? '<div style="color:var(--color-gray-500);font-size:0.875rem;padding:0.5rem 0;">No dormant species — every bird has been active recently.</div>'
                    : `<table class="stats-table">
                        <thead><tr><th>Species</th><th class="stats-count">Last Seen</th><th></th></tr></thead>
                        <tbody>${dormant.map(([sp, iso]) => `
                            <tr>
                                <td class="stats-species-name">${esc(sp)}</td>
                                <td class="stats-count">${fmtDaysAgo(iso)}</td>
                                <td style="text-align:right;">
                                    <button class="stats-view-btn" data-species="${esc(sp)}" onclick="filterBySpecies(this)">View</button>
                                </td>
                            </tr>`).join('')}
                        </tbody>
                    </table>`}
            </div>
        </div>`;
}

// ── Species co-occurrence (Pairs) ────────────────────────
function renderPairs() {
    const panel = document.getElementById('stats-pairs');
    if (!panel) return;
    const visible = applyClientFilters(allDetections);
    if (!visible.length) {
        panel.innerHTML = '<div class="feed-empty">No data for the current filters.</div>';
        return;
    }

    // Bucket species by day
    const daySpecies = {};  // day -> Set(species)
    visible.forEach(d => {
        if (!d.species) return;
        const day = d.detected_at.slice(0, 10);
        if (!daySpecies[day]) daySpecies[day] = new Set();
        daySpecies[day].add(d.species);
    });

    // Count co-occurrences
    const pairCounts = {};
    Object.values(daySpecies).forEach(set => {
        const arr = [...set].sort();
        for (let i = 0; i < arr.length; i++) {
            for (let j = i + 1; j < arr.length; j++) {
                const key = arr[i] + '\u0000' + arr[j];
                pairCounts[key] = (pairCounts[key] || 0) + 1;
            }
        }
    });

    const top = Object.entries(pairCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 25)
        .map(([k, c]) => {
            const [a, b] = k.split('\u0000');
            return { a, b, days: c };
        });

    if (top.length === 0) {
        panel.innerHTML = `
            <div class="stats-section-title">Species Co-occurrence</div>
            <div class="feed-empty">Not enough overlap to show species pairs — need multiple species on the same day.</div>`;
        return;
    }

    const totalDays = Object.keys(daySpecies).length;
    const maxDays   = top[0].days;

    panel.innerHTML = `
        <div class="stats-section-title">Species Co-occurrence</div>
        <div style="font-size:0.8rem;color:var(--color-gray-500);margin-bottom:0.75rem;">
            Species pairs that appear on the same day most often
            (${totalDays} day${totalDays === 1 ? '' : 's'} of data).
        </div>
        <table class="stats-table">
            <thead><tr>
                <th class="stats-rank">#</th>
                <th>Species A</th>
                <th>Species B</th>
                <th class="stats-count">Days Together</th>
                <th class="stats-pct">% of Active Days</th>
            </tr></thead>
            <tbody>${top.map((p, i) => {
                const pct = totalDays > 0 ? ((p.days / totalDays) * 100).toFixed(1) : '0.0';
                return `
                <tr>
                    <td class="stats-rank">${i + 1}</td>
                    <td class="stats-species-name">${esc(p.a)}</td>
                    <td class="stats-species-name">${esc(p.b)}</td>
                    <td class="stats-count">${p.days}</td>
                    <td class="stats-pct">
                        <span class="pct-bar-wrap"><span class="pct-bar" style="width:${(p.days/maxDays*100).toFixed(1)}%"></span></span>
                        ${pct}%
                    </td>
                </tr>`;
            }).join('')}
            </tbody>
        </table>`;
}

// ── CSV export ───────────────────────────────────────────
function exportCSV() {
    const visible = applyClientFilters(allDetections);
    if (!visible.length) { alert('No detections to export.'); return; }
    const cols = ['detected_at', 'species', 'rarity', 'zip_code', 'temperature', 'feeder', 'likes', 'image_url', 'video_url'];
    const header = cols.join(',');
    const rows = visible.map(d => [
        d.detected_at,
        d.species || '',
        d.rarity || '',
        d.zip_code || '',
        d.temperature != null ? d.temperature : '',
        d.feeders?.display_name || '',
        getReactionTotal(d.id) || '',
        d.image_url || '',
        d.video_url || '',
    ].map(v => `"${String(v).replace(/"/g, '""')}"`).join(','));
    const csv  = [header, ...rows].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `birdwatchai-detections-${new Date().toISOString().slice(0,10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
}

// ── Back-to-Stats banner ─────────────────────────────────
// When the user clicks "View" on a species row in a stats panel, we
// remember where they came from so they can pop straight back instead
// of having to manually clear the species filter and re-navigate.
let previousStatsContext = null;

const STATS_TAB_LABELS = {
    'life-list':  'Life List',
    'activity':   'Activity',
    'calendar':   'Calendar',
    'hotspots':   'Hotspots',
    'temperature':'Temperature',
    'leaderboard':'Leaderboard',
    'trend':      'Trend',
    'records':    'Records',
    'pairs':      'Pairs',
    'compare':    'Compare',
    'likes':      'Likes',
};

function showBackToStatsBanner(speciesName) {
    const banner = document.getElementById('back-to-stats-banner');
    if (!banner || !previousStatsContext) return;
    document.getElementById('back-banner-target').textContent =
        STATS_TAB_LABELS[previousStatsContext.statsTab] || 'Stats';
    document.getElementById('back-banner-species').textContent = speciesName;
    banner.style.display = '';
}

function hideBackToStatsBanner() {
    const banner = document.getElementById('back-to-stats-banner');
    if (banner) banner.style.display = 'none';
}

function clearStatsContext() {
    previousStatsContext = null;
    hideBackToStatsBanner();
}

function backToStats() {
    if (!previousStatsContext) return;
    const ctx = previousStatsContext;
    previousStatsContext = null;
    hideBackToStatsBanner();

    // Restore the previous species filter (whatever was in effect before
    // the user clicked "View" — usually empty / All Species).
    selectedSpecies = ctx.previousSpecies || '';
    const specSel = document.getElementById('species-filter');
    if (specSel) specSel.value = selectedSpecies;

    // Switch back to the Stats view and the original sub-tab.
    const statsTabBtn = Array.from(document.querySelectorAll('.view-tab'))
        .find(b => /switchView\('stats'/.test(b.getAttribute('onclick') || ''));
    if (statsTabBtn) switchView('stats', statsTabBtn);

    const subTabBtn = Array.from(document.querySelectorAll('.stats-tab'))
        .find(b => new RegExp(`switchStatsTab\\('${ctx.statsTab}'`).test(b.getAttribute('onclick') || ''));
    if (subTabBtn) switchStatsTab(ctx.statsTab, subTabBtn);
}

function captureStatsContextIfActive() {
    // Only capture context when the user is actually on a stats sub-tab.
    if (currentView !== 'stats') return;
    previousStatsContext = {
        statsTab: activeStatsTab,
        previousSpecies: selectedSpecies,
    };
}

function filterBySpeciesFromMap(speciesName) {
    // Map clicks aren't from the stats view, so no back-context here.
    clearStatsContext();
    selectedSpecies = speciesName;
    document.getElementById('species-filter').value = speciesName;
    switchView('feed', document.querySelector('.view-tab'));
}

function filterBySpecies(btn) {
    const speciesName = btn.dataset.species;
    captureStatsContextIfActive();
    selectedSpecies = speciesName;
    document.getElementById('species-filter').value = speciesName;
    currentView = 'feed';
    document.querySelectorAll('.view-tab').forEach(t => t.classList.remove('active'));
    document.querySelector('.view-tab').classList.add('active');
    document.getElementById('feed-view').style.display    = 'grid';
    document.getElementById('map-view').style.display     = 'none';
    document.getElementById('gallery-view').style.display = 'none';
    document.getElementById('stats-view').style.display   = 'none';
    renderFeed();
    showBackToStatsBanner(speciesName);
}

