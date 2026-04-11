// BirdWatchAI Community Feed - Auth, moderation, community features, init
// ── Handle URL query params on load ──────────────────────
// ?feeder=Name  → pre-select that feeder in the dropdown
(function handleUrlParams() {
    const params = new URLSearchParams(location.search);
    const feeder = params.get('feeder');
    if (feeder) {
        // Wait for feeder dropdown to be populated, then select
        const trySelect = () => {
            const sel = document.getElementById('feeder-filter');
            const opt = [...sel.options].find(o => o.value === feeder);
            if (opt) { sel.value = feeder; renderFeed(); }
            else setTimeout(trySelect, 300);
        };
        setTimeout(trySelect, 600);
    }
})();

// Scroll to and highlight a shared detection on page load
async function handleSharedId() {
    const id = new URLSearchParams(location.search).get('id');
    if (!id) return;

    function scrollToCard(card) {
        card.classList.add('shared-highlight');
        card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }

    // Resets filter UI and re-renders WITHOUT re-fetching
    // (clearFilters() calls loadFeed() async which would clobber allDetections)
    function resetFiltersAndRender() {
        document.querySelectorAll('.period-btn').forEach(b => b.classList.remove('active'));
        document.querySelector('.period-btn[data-period=""]').classList.add('active');
        selectedSpecies = '';
        document.getElementById('species-filter').value = '';
        document.getElementById('rarity-filter').value  = '';
        document.getElementById('feeder-filter').value  = '';
        document.getElementById('zip-filter').value     = '';
        favoritesOnly = false;
        document.getElementById('fav-toggle').classList.remove('active');
        renderFeed();
    }

    // 1. Already in the rendered DOM
    let card = document.querySelector(`.card[data-id="${id}"]`);
    if (card) { scrollToCard(card); return; }

    // 2. In allDetections but hidden by active filters — reset and re-render
    if (allDetections.find(x => String(x.id) === id)) {
        resetFiltersAndRender();
        card = document.querySelector(`.card[data-id="${id}"]`);
        if (card) { scrollToCard(card); return; }
    }

    // 3. Not in the current batch — fetch just this one record
    try {
        const res = await fetch(
            `${SUPABASE_URL}/rest/v1/community_detections?select=*,feeders(display_name)&id=eq.${encodeURIComponent(id)}`,
            { headers: { apikey: ANON_KEY, Authorization: `Bearer ${ANON_KEY}` } }
        );
        const rows = await res.json();
        if (!Array.isArray(rows) || !rows.length) { showToast('Detection not found'); return; }
        allDetections = [...rows, ...allDetections];
        resetFiltersAndRender();
        card = document.querySelector(`.card[data-id="${id}"]`);
        if (card) scrollToCard(card);
    } catch (e) { showToast('fetch error: ' + e.message); }
}

// ── Dark mode ────────────────────────────────────────────
(function initTheme() {
    const saved = localStorage.getItem('bwai-theme');
    if (saved) document.documentElement.setAttribute('data-theme', saved);
})();

function toggleTheme() {
    const current = document.documentElement.getAttribute('data-theme');
    const next    = current === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('bwai-theme', next);
    document.getElementById('theme-toggle').textContent = next === 'dark' ? '☀️ Theme' : '🌙 Theme';
}

// Set initial icon based on current theme
window.addEventListener('DOMContentLoaded', () => {
    const theme = document.documentElement.getAttribute('data-theme') ||
        (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    document.getElementById('theme-toggle').textContent = theme === 'dark' ? '☀️ Theme' : '🌙 Theme';
});

// ── Bird of the Day ──────────────────────────────────────
function dismissBotd() {
    const today = new Date().toISOString().slice(0, 10);
    localStorage.setItem('bwai-botd-dismissed', today);
    document.getElementById('botd-banner').classList.remove('visible');
}

function renderBirdOfTheDay(detections) {
    // Pick today's rarest detection (Very Rare > Rare > most-detected species)
    const today  = new Date().toISOString().slice(0, 10);

    // Don't re-show if user already dismissed today
    if (localStorage.getItem('bwai-botd-dismissed') === today) return;

    const todays = detections.filter(d => d.detected_at.slice(0, 10) === today);
    if (!todays.length) return;

    const byRarity = r => r === 'Very Rare' ? 3 : r === 'Rare' ? 2 : r === 'Uncommon' ? 1 : 0;
    const best = todays.slice().sort((a, b) => byRarity(b.rarity) - byRarity(a.rarity))[0];

    document.getElementById('botd-species').textContent = best.species || 'Unknown';
    document.getElementById('botd-meta').textContent =
        [best.rarity, best.feeders?.display_name, best.zip_code].filter(Boolean).join(' · ');

    const img = document.getElementById('botd-img');
    if (best.image_url) { img.src = best.image_url; img.alt = best.species || ''; img.style.display = ''; }
    else                { img.style.display = 'none'; }

    document.getElementById('botd-banner').classList.add('visible');
}

// ── Sound on new detection ────────────────────────────────
let soundEnabled = false;
let audioCtx     = null;

function toggleSound() {
    soundEnabled = !soundEnabled;
    const btn = document.getElementById('sound-toggle');
    btn.textContent      = soundEnabled ? '🔊 Sound' : '🔇 Sound';
    btn.style.background = soundEnabled ? '#2d5a3d' : 'var(--color-gray-500)';
    if (soundEnabled && !audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
}

function playChime() {
    if (!soundEnabled || !audioCtx) return;
    // Simple two-tone pleasant chime using Web Audio API
    [880, 1108].forEach((freq, i) => {
        const osc  = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.connect(gain); gain.connect(audioCtx.destination);
        osc.type      = 'sine';
        osc.frequency.value = freq;
        const t = audioCtx.currentTime + i * 0.18;
        gain.gain.setValueAtTime(0, t);
        gain.gain.linearRampToValueAtTime(0.18, t + 0.04);
        gain.gain.exponentialRampToValueAtTime(0.001, t + 0.6);
        osc.start(t); osc.stop(t + 0.65);
    });
}

// ── Keyboard shortcuts ────────────────────────────────────
let kbdHintVisible = false;

function toggleKbdHint() {
    kbdHintVisible = !kbdHintVisible;
    document.getElementById('kbd-hint').classList.toggle('visible', kbdHintVisible);
}

// Card focus tracking for j/k navigation
let focusedCardIdx = -1;
function getCards() { return [...document.querySelectorAll('#feed-view .card')]; }

function focusCard(idx) {
    const cards = getCards();
    if (!cards.length) return;
    focusedCardIdx = Math.max(0, Math.min(idx, cards.length - 1));
    cards.forEach((c, i) => c.style.outline = i === focusedCardIdx ? '2px solid var(--color-primary)' : '');
    cards[focusedCardIdx].scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

document.addEventListener('keydown', e => {
    // Skip shortcuts when typing in an input
    if (['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName)) return;

    if (e.key === 'Escape') {
        closeLightbox();
        closeCarousel();
        closeSlideshow();
        closeDetailModal();
        kbdHintVisible = false;
        document.getElementById('kbd-hint').classList.remove('visible');
        return;
    }
    if (e.key === 'j') { focusCard(focusedCardIdx + 1); return; }
    if (e.key === 'k') { focusCard(focusedCardIdx - 1); return; }
    if (e.key === '/') { e.preventDefault(); document.getElementById('search-input').focus(); return; }
    if (e.key === 'f') { toggleFavorites(); return; }
    if (e.key === 'r') { loadFeed(); return; }
    if (e.key === '1') { switchView('feed',    document.querySelectorAll('.view-tab')[0]); return; }
    if (e.key === '2') { switchView('map',     document.querySelectorAll('.view-tab')[1]); return; }
    if (e.key === '3') { switchView('gallery', document.querySelectorAll('.view-tab')[2]); return; }
    if (e.key === '4') { switchView('stats',   document.querySelectorAll('.view-tab')[3]); return; }
});

// ── Arrow-key navigation for tab lists (ARIA tabs pattern) ──
document.querySelectorAll('[role="tablist"]').forEach(tablist => {
    tablist.addEventListener('keydown', e => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
        const tabs = [...tablist.querySelectorAll('[role="tab"]')];
        const idx = tabs.indexOf(document.activeElement);
        if (idx < 0) return;
        e.preventDefault();
        let next;
        if (e.key === 'ArrowRight') next = tabs[(idx + 1) % tabs.length];
        else if (e.key === 'ArrowLeft') next = tabs[(idx - 1 + tabs.length) % tabs.length];
        else if (e.key === 'Home') next = tabs[0];
        else if (e.key === 'End') next = tabs[tabs.length - 1];
        if (next) { next.focus(); next.click(); }
    });
});

// ── Service Worker registration ───────────────────────────
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('/docs/sw.js').catch(() => {});
    });
}

// ── Detection detail modal ────────────────────────────────
const detailModal = document.getElementById('detail-modal');

function closeDetailModal() {
    detailModal.classList.remove('open');
    unlockScroll();
}

document.getElementById('detail-close').addEventListener('click', closeDetailModal);
detailModal.addEventListener('click', e => {
    if (e.target === detailModal) closeDetailModal();
});

function openDetailModal(id) {
    const d = allDetections.find(x => String(x.id) === String(id));
    if (!d) return;

    const img = document.getElementById('detail-img');
    if (d.image_url) { img.src = d.image_url; img.alt = d.species; img.style.display = ''; }
    else img.style.display = 'none';

    const rarityClass = d.rarity ? 'rarity-' + d.rarity.toLowerCase().replace(/\s+/g, '-') : '';
    document.getElementById('detail-title').innerHTML =
        `${esc(d.species)}${d.rarity ? ` <span class="${rarityClass}" style="font-size:0.9rem;">· ${esc(d.rarity)}</span>` : ''}`;

    const time = new Date(d.detected_at).toLocaleString('en-US', {
        timeZone: 'America/New_York',
        month: 'long', day: 'numeric', year: 'numeric',
        hour: 'numeric', minute: '2-digit', timeZoneName: 'short'
    });
    const metaRows = [
        `<span>🕐 ${time}</span>`,
        d.feeders?.display_name ? `<span>📡 ${esc(d.feeders.display_name)}</span>` : '',
        d.zip_code              ? `<span>📍 ZIP ${esc(d.zip_code)}</span>` : '',
        d.temperature != null   ? `<span>🌡️ ${d.temperature}°F</span>` : '',
    ].filter(Boolean).join('');
    document.getElementById('detail-meta').innerHTML = metaRows;

    const actions = document.getElementById('detail-actions');
    actions.innerHTML = '';
    if (d.video_url) {
        const a = document.createElement('a');
        a.href = d.video_url; a.target = '_blank'; a.rel = 'noopener';
        a.textContent = '🎬 Watch video'; actions.appendChild(a);
    }
    const shareBtn = document.createElement('button');
    shareBtn.textContent = '🔗 Share';
    shareBtn.onclick = () => { closeDetailModal(); shareDetection(d.id, null); };
    actions.appendChild(shareBtn);
    const audioBtn = document.createElement('button');
    audioBtn.textContent = '🔊 Play call';
    audioBtn.onclick = () => playBirdCall(d.species, audioBtn);
    actions.appendChild(audioBtn);
    const wikiLink = document.createElement('a');
    wikiLink.href = `https://en.wikipedia.org/wiki/${encodeURIComponent(d.species)}`;
    wikiLink.target = '_blank';
    wikiLink.rel = 'noopener';
    wikiLink.textContent = '📖 Wikipedia';
    actions.appendChild(wikiLink);
    const aiResearchBtn = document.createElement('button');
    aiResearchBtn.textContent = '🤖 AI Research';
    aiResearchBtn.onclick = () => { closeDetailModal(); openAIResearch(d.species); };
    actions.appendChild(aiResearchBtn);

    // Reactions in detail modal
    const rxDiv = document.createElement('div');
    rxDiv.className = 'card-reactions';
    rxDiv.style.marginTop = '0.75rem';
    const reactions = getReactions(d.id);
    EMOJI_LIST.forEach(emoji => {
        const count = reactions[emoji] || 0;
        const reacted = isReacted(d.id, emoji);
        const btn = document.createElement('button');
        btn.className = 'reaction-btn' + (reacted ? ' reacted' : '');
        btn.dataset.reactionId = d.id;
        btn.dataset.emoji = emoji;
        btn.textContent = emoji + (count ? ' ' + count : '');
        btn.onclick = () => toggleReaction(d.id, emoji, btn);
        rxDiv.appendChild(btn);
    });
    actions.parentElement.appendChild(rxDiv);

    if (isModLoggedIn()) {
        const editBtn = document.createElement('button');
        editBtn.textContent = '✏️ Edit';
        editBtn.style.borderColor = '#e67e22';
        editBtn.style.color = '#e67e22';
        editBtn.onclick = () => { closeDetailModal(); openModEdit(d.id); };
        actions.appendChild(editBtn);

        const delBtn = document.createElement('button');
        delBtn.textContent = '🗑️ Delete';
        delBtn.style.borderColor = '#e74c3c';
        delBtn.style.color = '#e74c3c';
        delBtn.onclick = () => { closeDetailModal(); confirmModDelete(d.id); };
        actions.appendChild(delBtn);
    }

    lockScroll();
    detailModal.classList.add('open');
}


// ── Moderator system ───────────────────────────────────────
function isModLoggedIn() {
    return !!sessionStorage.getItem('bwai-mod-user');
}

function isAdmin() {
    return sessionStorage.getItem('bwai-mod-role') === 'admin';
}

function getModCreds() {
    return {
        email: sessionStorage.getItem('bwai-mod-user'),
        password: sessionStorage.getItem('bwai-mod-pass'),
    };
}

// Bridge moderator/admin session into a community user so they
// can use life lists, comments, follow feeders, etc. without
// needing a separate magic-link sign-in.
function bridgeModAsCommunityUser(email, role, modId) {
    const label = role === 'admin' ? 'Admin' : 'Moderator';
    currentUser = { id: modId, email: email, role: 'moderator' };
    currentProfile = { id: modId, display_name: `${label}: ${email.split('@')[0]}`, bio: '' };
    isModAsCommunityUser = true;
    updateCommunityUI();
}

function updateModUI() {
    const loggedIn = isModLoggedIn();
    const admin = isAdmin();
    // Navbar auth buttons
    document.getElementById('navbar-login-btn').style.display = loggedIn ? 'none' : '';
    document.getElementById('navbar-logout-btn').style.display = loggedIn ? '' : 'none';
    document.getElementById('navbar-changepw-btn').style.display = loggedIn ? '' : 'none';
    document.getElementById('navbar-admin-btn').style.display = (loggedIn && admin) ? '' : 'none';
    document.getElementById('navbar-flags-btn').style.display = loggedIn ? '' : 'none';
    // Show logged-in user
    const userEl = document.getElementById('navbar-user');
    if (loggedIn) {
        const email = sessionStorage.getItem('bwai-mod-user');
        const role = sessionStorage.getItem('bwai-mod-role');
        const label = role === 'admin' ? 'Admin' : 'Moderator';
        userEl.textContent = `${label}: ${email}`;
        userEl.style.display = '';
    } else {
        userEl.style.display = 'none';
        userEl.textContent = '';
    }
}

function toggleModLogin() {
    if (isModLoggedIn()) {
        sessionStorage.removeItem('bwai-mod-user');
        sessionStorage.removeItem('bwai-mod-pass');
        sessionStorage.removeItem('bwai-mod-role');
        // Clear bridged community user if it came from mod login
        if (isModAsCommunityUser) {
            currentUser = null;
            currentProfile = null;
            userLifeList = [];
            userFollowedFeeders = [];
            isModAsCommunityUser = false;
            updateCommunityUI();
        }
        updateModUI();
        showToast('Moderator logged out');
        renderFeed();
        return;
    }
    document.getElementById('mod-login-modal').classList.add('open');
    document.getElementById('mod-username').focus();
}

function closeModLogin() {
    document.getElementById('mod-login-modal').classList.remove('open');
    document.getElementById('mod-login-error').style.display = 'none';
    document.getElementById('mod-username').value = '';
    document.getElementById('mod-password').value = '';
}

async function doModLogin() {
    const email = document.getElementById('mod-username').value.trim();
    const password = document.getElementById('mod-password').value;
    if (!email || !password) return;

    try {
        const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/moderator_login`, {
            method: 'POST',
            headers: {
                apikey: ANON_KEY,
                Authorization: `Bearer ${ANON_KEY}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ p_email: email, p_password: password }),
        });
        const data = await res.json();
        if (!data || !data.id) {
            document.getElementById('mod-login-error').style.display = 'block';
            return;
        }
        sessionStorage.setItem('bwai-mod-user', email);
        sessionStorage.setItem('bwai-mod-pass', password);
        sessionStorage.setItem('bwai-mod-role', data.role);
        // Bridge: give moderators community user access automatically
        bridgeModAsCommunityUser(email, data.role, data.id);
        updateModUI();
        closeModLogin();
        showToast(`Logged in as ${data.role}: ${email}`);
        renderFeed();

        // Force password change if using a temporary password
        if (data.must_change_password) {
            showMustChangePassword();
        }
    } catch (err) {
        document.getElementById('mod-login-error').textContent = 'Login failed: ' + err.message;
        document.getElementById('mod-login-error').style.display = 'block';
    }
}

// Allow Enter key in login modal
document.getElementById('mod-password').addEventListener('keydown', e => {
    if (e.key === 'Enter') doModLogin();
});

// Close login modal on backdrop click
document.getElementById('mod-login-modal').addEventListener('click', e => {
    if (e.target.id === 'mod-login-modal') closeModLogin();
});

// ── Admin: manage moderators ─────────────────────────────
async function openAdminPanel() {
    if (!isAdmin()) return;
    document.getElementById('mod-admin-modal').classList.add('open');
    await refreshModUserList();
}

function closeAdminPanel() {
    document.getElementById('mod-admin-modal').classList.remove('open');
}

document.getElementById('mod-admin-modal').addEventListener('click', e => {
    if (e.target.id === 'mod-admin-modal') closeAdminPanel();
});

async function refreshModUserList() {
    const { email, password } = getModCreds();
    const list = document.getElementById('mod-user-list');
    try {
        const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/moderator_list_users`, {
            method: 'POST',
            headers: {
                apikey: ANON_KEY,
                Authorization: `Bearer ${ANON_KEY}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ p_email: email, p_password: password }),
        });
        if (!res.ok) throw new Error('Failed to load');
        const users = await res.json();
        if (!users || !users.length) {
            list.innerHTML = '<li style="color:var(--color-gray-500)">No moderators found.</li>';
            return;
        }
        list.innerHTML = users.map(u => `
            <li>
                <div class="mod-user-info">
                    <strong>${esc(u.email)}</strong>
                    <span class="mod-role-tag ${u.role}">${u.role}</span>
                </div>
                ${u.email !== email
                    ? `<button class="mod-remove-btn" onclick="doAdminRemoveUser('${u.id}', '${esc(u.email)}')">Remove</button>`
                    : '<span style="font-size:0.75rem;color:var(--color-gray-500);">you</span>'}
            </li>
        `).join('');
    } catch (err) {
        list.innerHTML = `<li style="color:#e74c3c">Error: ${esc(err.message)}</li>`;
    }
}

async function doAdminAddUser() {
    const { email, password } = getModCreds();
    const newEmail = document.getElementById('mod-add-email').value.trim();
    const newRole = document.getElementById('mod-add-role').value;
    const statusEl = document.getElementById('mod-add-status');

    if (!newEmail) { showToast('Email address is required'); return; }

    statusEl.textContent = 'Sending invite...';
    statusEl.style.color = 'var(--color-gray-500)';
    statusEl.style.display = 'block';

    try {
        const functionsUrl = SUPABASE_URL.replace('.supabase.co', '.supabase.co/functions/v1');
        const res = await fetch(`${functionsUrl}/send-temp-password`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                apikey: ANON_KEY,
                Authorization: `Bearer ${ANON_KEY}`,
            },
            body: JSON.stringify({
                action: 'invite',
                admin_email: email,
                admin_password: password,
                new_email: newEmail,
                new_role: newRole,
            }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Failed to add user');

        document.getElementById('mod-add-email').value = '';
        if (data.email_sent) {
            statusEl.textContent = `Invite sent to ${newEmail}`;
            statusEl.style.color = '#2eaa4f';
        } else {
            statusEl.textContent = `User created but email could not be sent. Share temp password manually.`;
            statusEl.style.color = '#e6a817';
        }
        showToast(`Invited ${newRole}: ${newEmail}`);
        await refreshModUserList();
    } catch (err) {
        statusEl.textContent = 'Error: ' + err.message;
        statusEl.style.color = '#e74c3c';
        showToast('Error: ' + err.message);
    }
}

async function doAdminRemoveUser(targetId, targetName) {
    if (!confirm(`Remove moderator "${targetName}"?`)) return;
    const { email, password } = getModCreds();

    try {
        const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/moderator_remove_user`, {
            method: 'POST',
            headers: {
                apikey: ANON_KEY,
                Authorization: `Bearer ${ANON_KEY}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                p_email: email,
                p_password: password,
                p_target_id: targetId,
            }),
        });
        if (!res.ok) {
            const err = await res.json();
            throw new Error(err.message || 'Failed to remove user');
        }
        showToast(`Removed: ${targetName}`);
        await refreshModUserList();
    } catch (err) {
        showToast('Error: ' + err.message);
    }
}

// Pending media deletions for the currently open mod edit modal
let modEditDeletePhoto = false;
let modEditDeleteVideo = false;

function openModEdit(detectionId) {
    const d = allDetections.find(x => String(x.id) === String(detectionId));
    if (!d) return;
    // Populate species select from all loaded detections
    const speciesList = [...new Set(allDetections.map(x => x.species).filter(Boolean))].sort();
    const sel = document.getElementById('mod-edit-species-select');
    const customInput = document.getElementById('mod-edit-species-custom');
    sel.innerHTML = speciesList.map(s => `<option value="${esc(s)}">${esc(s)}</option>`).join('') +
        '<option value="__custom__">Other (type manually)…</option>';
    // Pre-select current species, or show custom input if not in list
    if (d.species && speciesList.includes(d.species)) {
        sel.value = d.species;
        customInput.style.display = 'none';
        customInput.value = '';
    } else {
        sel.value = '__custom__';
        customInput.style.display = '';
        customInput.value = d.species || '';
    }
    document.getElementById('mod-edit-id').value = d.id;
    document.getElementById('mod-edit-rarity').value = d.rarity || 'Common';

    // Reset pending media deletions
    modEditDeletePhoto = false;
    modEditDeleteVideo = false;

    // Photo section
    const photoRow    = document.getElementById('mod-edit-photo-row');
    const photoThumb  = document.getElementById('mod-edit-photo-thumb');
    const photoDel    = document.getElementById('mod-edit-photo-del');
    const photoMarked = document.getElementById('mod-edit-photo-marked');
    if (d.image_url) {
        photoRow.style.display = '';
        photoThumb.src = d.image_url;
        photoDel.parentElement.style.display = '';
        photoMarked.style.display = 'none';
    } else {
        photoRow.style.display = 'none';
    }

    // Video section
    const videoRow    = document.getElementById('mod-edit-video-row');
    const videoLink   = document.getElementById('mod-edit-video-link');
    const videoDel    = document.getElementById('mod-edit-video-del');
    const videoMarked = document.getElementById('mod-edit-video-marked');
    if (d.video_url) {
        videoRow.style.display = '';
        videoLink.href = d.video_url;
        videoDel.parentElement.style.display = '';
        videoMarked.style.display = 'none';
    } else {
        videoRow.style.display = 'none';
    }

    document.getElementById('mod-edit-modal').classList.add('open');
}

function toggleModDeleteMedia(kind) {
    if (kind === 'photo') {
        modEditDeletePhoto = !modEditDeletePhoto;
        const preview = document.getElementById('mod-edit-photo-del').parentElement;
        const marked  = document.getElementById('mod-edit-photo-marked');
        preview.style.display = modEditDeletePhoto ? 'none' : '';
        marked.style.display  = modEditDeletePhoto ? '' : 'none';
    } else if (kind === 'video') {
        modEditDeleteVideo = !modEditDeleteVideo;
        const preview = document.getElementById('mod-edit-video-del').parentElement;
        const marked  = document.getElementById('mod-edit-video-marked');
        preview.style.display = modEditDeleteVideo ? 'none' : '';
        marked.style.display  = modEditDeleteVideo ? '' : 'none';
    }
}

document.getElementById('mod-edit-species-select').addEventListener('change', function() {
    const customInput = document.getElementById('mod-edit-species-custom');
    if (this.value === '__custom__') {
        customInput.style.display = '';
        customInput.focus();
    } else {
        customInput.style.display = 'none';
        customInput.value = '';
    }
});

function closeModEdit() {
    document.getElementById('mod-edit-modal').classList.remove('open');
}

document.getElementById('mod-edit-modal').addEventListener('click', e => {
    if (e.target.id === 'mod-edit-modal') closeModEdit();
});

async function doModSave() {
    const { email, password } = getModCreds();
    const detectionId = document.getElementById('mod-edit-id').value;
    const selVal = document.getElementById('mod-edit-species-select').value;
    const species = (selVal === '__custom__'
        ? document.getElementById('mod-edit-species-custom').value
        : selVal).trim();
    const rarity = document.getElementById('mod-edit-rarity').value;

    if (!species) { showToast('Species name is required'); return; }

    // When media is being deleted we go through the edge function so that
    // the files are also removed from Supabase Storage. Otherwise we call
    // the RPC directly (cheaper, no edge-function round trip).
    const deletingMedia = modEditDeletePhoto || modEditDeleteVideo;

    try {
        let res;
        if (deletingMedia) {
            const functionsUrl = SUPABASE_URL.replace('.supabase.co', '.supabase.co/functions/v1');
            res = await fetch(`${functionsUrl}/moderator-delete-media`, {
                method: 'POST',
                headers: {
                    apikey: ANON_KEY,
                    Authorization: `Bearer ${ANON_KEY}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    action: 'update',
                    email,
                    password,
                    detection_id: detectionId,
                    species,
                    rarity,
                    delete_image: modEditDeletePhoto,
                    delete_video: modEditDeleteVideo,
                }),
            });
        } else {
            res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/moderator_update_detection`, {
                method: 'POST',
                headers: {
                    apikey: ANON_KEY,
                    Authorization: `Bearer ${ANON_KEY}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    p_email: email,
                    p_password: password,
                    p_detection_id: detectionId,
                    p_species: species,
                    p_rarity: rarity,
                }),
            });
        }
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.error || err.message || 'Update failed');
        }
        // Update local data
        const d = allDetections.find(x => String(x.id) === String(detectionId));
        if (d) {
            d.species = species;
            d.rarity = rarity;
            if (modEditDeletePhoto) d.image_url = null;
            if (modEditDeleteVideo) d.video_url = null;
        }
        closeModEdit();
        renderFeed();
        showToast(deletingMedia ? 'Detection updated (media removed)' : 'Detection updated');
    } catch (err) {
        showToast('Error: ' + err.message);
    }
}

async function confirmModDelete(detectionId) {
    const d = allDetections.find(x => String(x.id) === String(detectionId));
    if (!d) return;
    if (!confirm(`Delete detection of "${d.species}"?\nThis cannot be undone.`)) return;

    const { email, password } = getModCreds();
    try {
        // Always route through the edge function so any attached photo /
        // video files are also removed from Supabase Storage, not just
        // the DB row.
        const functionsUrl = SUPABASE_URL.replace('.supabase.co', '.supabase.co/functions/v1');
        const res = await fetch(`${functionsUrl}/moderator-delete-media`, {
            method: 'POST',
            headers: {
                apikey: ANON_KEY,
                Authorization: `Bearer ${ANON_KEY}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                action: 'delete',
                email,
                password,
                detection_id: detectionId,
            }),
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.error || err.message || 'Delete failed');
        }
        // Remove from local data
        allDetections = allDetections.filter(x => String(x.id) !== String(detectionId));
        renderFeed();
        showToast('Detection deleted');
    } catch (err) {
        showToast('Error: ' + err.message);
    }
}

// ── Forgot password ────────────────────────────────────────
function showForgotPassword() {
    closeModLogin();
    document.getElementById('mod-forgot-modal').style.display = 'flex';
    document.getElementById('mod-forgot-email').focus();
}

function closeForgotPassword() {
    document.getElementById('mod-forgot-modal').style.display = 'none';
    document.getElementById('mod-forgot-error').style.display = 'none';
    document.getElementById('mod-forgot-success').style.display = 'none';
    document.getElementById('mod-forgot-email').value = '';
}

document.getElementById('mod-forgot-modal').addEventListener('click', e => {
    if (e.target.id === 'mod-forgot-modal') closeForgotPassword();
});

document.getElementById('mod-forgot-email').addEventListener('keydown', e => {
    if (e.key === 'Enter') doForgotPassword();
});

async function doForgotPassword() {
    const emailInput = document.getElementById('mod-forgot-email');
    const errorEl = document.getElementById('mod-forgot-error');
    const successEl = document.getElementById('mod-forgot-success');
    const emailVal = emailInput.value.trim();

    if (!emailVal) return;

    errorEl.style.display = 'none';
    successEl.style.display = 'none';

    try {
        const functionsUrl = SUPABASE_URL.replace('.supabase.co', '.supabase.co/functions/v1');
        const res = await fetch(`${functionsUrl}/send-temp-password`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                apikey: ANON_KEY,
                Authorization: `Bearer ${ANON_KEY}`,
            },
            body: JSON.stringify({ action: 'reset', email: emailVal }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Request failed');

        successEl.textContent = 'If that email is registered, a temporary password has been sent. Check your inbox.';
        successEl.style.display = 'block';
        emailInput.value = '';
    } catch (err) {
        errorEl.textContent = 'Error: ' + err.message;
        errorEl.style.display = 'block';
    }
}

// ── Change password ──────────────────────────────────────────
function showChangePassword() {
    const modal = document.getElementById('mod-changepw-modal');
    document.getElementById('mod-changepw-title').textContent = 'Change Password';
    document.getElementById('mod-changepw-msg').textContent = 'Enter your current password and choose a new one.';
    document.getElementById('mod-changepw-cancel').style.display = '';
    modal.style.display = 'flex';
    document.getElementById('mod-changepw-current').focus();
}

function showMustChangePassword() {
    const modal = document.getElementById('mod-changepw-modal');
    document.getElementById('mod-changepw-title').textContent = 'Set Your Password';
    document.getElementById('mod-changepw-msg').textContent = 'You are using a temporary password. Please set a new password to continue.';
    document.getElementById('mod-changepw-cancel').style.display = 'none';
    modal.style.display = 'flex';
    document.getElementById('mod-changepw-current').value = sessionStorage.getItem('bwai-mod-pass') || '';
    document.getElementById('mod-changepw-new').focus();
}

function closeChangePassword() {
    document.getElementById('mod-changepw-modal').style.display = 'none';
    document.getElementById('mod-changepw-error').style.display = 'none';
    document.getElementById('mod-changepw-current').value = '';
    document.getElementById('mod-changepw-new').value = '';
    document.getElementById('mod-changepw-confirm').value = '';
}

document.getElementById('mod-changepw-modal').addEventListener('click', e => {
    if (e.target.id === 'mod-changepw-modal') {
        // Only allow closing via backdrop if cancel button is visible
        if (document.getElementById('mod-changepw-cancel').style.display !== 'none') {
            closeChangePassword();
        }
    }
});

document.getElementById('mod-changepw-confirm').addEventListener('keydown', e => {
    if (e.key === 'Enter') doChangePassword();
});

async function doChangePassword() {
    const { email } = getModCreds();
    const currentPw = document.getElementById('mod-changepw-current').value;
    const newPw = document.getElementById('mod-changepw-new').value;
    const confirmPw = document.getElementById('mod-changepw-confirm').value;
    const errorEl = document.getElementById('mod-changepw-error');

    errorEl.style.display = 'none';

    if (!currentPw || !newPw || !confirmPw) {
        errorEl.textContent = 'All fields are required.';
        errorEl.style.display = 'block';
        return;
    }
    if (newPw.length < 8) {
        errorEl.textContent = 'Password must be at least 8 characters.';
        errorEl.style.display = 'block';
        return;
    }
    if (newPw !== confirmPw) {
        errorEl.textContent = 'Passwords do not match.';
        errorEl.style.display = 'block';
        return;
    }

    try {
        const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/moderator_change_password`, {
            method: 'POST',
            headers: {
                apikey: ANON_KEY,
                Authorization: `Bearer ${ANON_KEY}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                p_email: email,
                p_password: currentPw,
                p_new_password: newPw,
            }),
        });
        if (!res.ok) {
            const err = await res.json();
            throw new Error(err.message || 'Failed to change password');
        }
        // Update stored password
        sessionStorage.setItem('bwai-mod-pass', newPw);
        closeChangePassword();
        showToast('Password changed successfully');
    } catch (err) {
        errorEl.textContent = err.message;
        errorEl.style.display = 'block';
    }
}

// ── Community User Auth (Supabase Auth magic link) ─────────
function updateCommunityUI() {
    const loggedIn = !!currentUser;
    document.getElementById('navbar-community-login').style.display = loggedIn ? 'none' : '';
    document.getElementById('navbar-community-logout').style.display = loggedIn ? '' : 'none';
    document.getElementById('navbar-community-profile').style.display = loggedIn ? '' : 'none';
    document.getElementById('navbar-life-list').style.display = loggedIn ? '' : 'none';
    const userSpan = document.getElementById('navbar-community-user');
    if (loggedIn && currentProfile) {
        userSpan.textContent = currentProfile.display_name || currentUser.email;
        userSpan.style.display = '';
    } else {
        userSpan.style.display = 'none';
    }
}

async function initCommunityAuth() {
    // Check for magic-link token fragments in the URL (Supabase Auth callback)
    try {
        const hash = window.location.hash;
        if (hash && hash.includes('access_token=')) {
            const params = new URLSearchParams(hash.substring(1));
            authAccessToken = params.get('access_token');
            authRefreshToken = params.get('refresh_token');
            if (authAccessToken) {
                localStorage.setItem('bwai-auth-token', authAccessToken);
                if (authRefreshToken) localStorage.setItem('bwai-auth-refresh', authRefreshToken);
                // Fetch user info
                const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
                    headers: { apikey: ANON_KEY, Authorization: `Bearer ${authAccessToken}` }
                });
                if (res.ok) {
                    const user = await res.json();
                    currentUser = user;
                    isModAsCommunityUser = false;
                    await loadUserProfile();
                    await loadUserLifeList();
                    await loadUserFollowedFeeders();
                    updateCommunityUI();
                    showToast('Signed in as ' + (currentProfile?.display_name || user.email));
                }
                // Clean up URL hash
                history.replaceState(null, '', window.location.pathname + window.location.search);
            }
        }
    } catch (e) { console.warn('Magic link callback failed:', e); }

    // Restore saved auth token (always check — overrides mod bridge if present)
    const savedToken = localStorage.getItem('bwai-auth-token');
    if (savedToken && !authAccessToken) {
        try {
            const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
                headers: { apikey: ANON_KEY, Authorization: `Bearer ${savedToken}` }
            });
            if (res.ok) {
                authAccessToken = savedToken;
                authRefreshToken = localStorage.getItem('bwai-auth-refresh');
                currentUser = await res.json();
                isModAsCommunityUser = false;
                await loadUserProfile();
                await loadUserLifeList();
                await loadUserFollowedFeeders();
            } else {
                // Token expired — try refresh
                const refreshed = await refreshAuthToken();
                if (refreshed) {
                    await loadUserProfile();
                    await loadUserLifeList();
                    await loadUserFollowedFeeders();
                } else {
                    localStorage.removeItem('bwai-auth-token');
                    localStorage.removeItem('bwai-auth-refresh');
                }
            }
        } catch (_) {}
    }
    updateCommunityUI();
}

async function refreshAuthToken() {
    const refreshToken = localStorage.getItem('bwai-auth-refresh');
    if (!refreshToken) return false;
    try {
        const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
            method: 'POST',
            headers: { apikey: ANON_KEY, 'Content-Type': 'application/json' },
            body: JSON.stringify({ refresh_token: refreshToken }),
        });
        if (!res.ok) return false;
        const data = await res.json();
        authAccessToken = data.access_token;
        authRefreshToken = data.refresh_token;
        localStorage.setItem('bwai-auth-token', authAccessToken);
        localStorage.setItem('bwai-auth-refresh', authRefreshToken);
        // Fetch user
        const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
            headers: { apikey: ANON_KEY, Authorization: `Bearer ${authAccessToken}` }
        });
        if (userRes.ok) {
            currentUser = await userRes.json();
            isModAsCommunityUser = false;
            return true;
        }
    } catch (_) {}
    return false;
}

async function loadUserProfile() {
    if (!currentUser) return;
    if (isModAsCommunityUser) return; // mod bridge sets profile directly
    try {
        const res = await fetch(
            `${SUPABASE_URL}/rest/v1/user_profiles?id=eq.${currentUser.id}&select=*`,
            { headers: sbHeaders(true) }
        );
        if (res.ok) {
            const rows = await res.json();
            currentProfile = rows[0] || null;
            // Auto-create profile if it doesn't exist yet
            if (!currentProfile && currentUser.email) {
                const displayName = currentUser.email.split('@')[0] || 'Birder';
                const createRes = await fetch(`${SUPABASE_URL}/rest/v1/user_profiles`, {
                    method: 'POST',
                    headers: { ...sbHeaders(true), Prefer: 'return=representation' },
                    body: JSON.stringify({ id: currentUser.id, display_name: displayName, bio: '' }),
                });
                if (createRes.ok) {
                    const created = await createRes.json();
                    currentProfile = created[0] || { id: currentUser.id, display_name: displayName, bio: '' };
                }
            }
        }
    } catch (_) {}
}

function openUserLogin() {
    document.getElementById('user-login-modal').classList.add('open');
    document.getElementById('user-login-email').focus();
    const status = document.getElementById('user-login-status');
    status.style.display = 'none';
}

function closeUserLogin() {
    document.getElementById('user-login-modal').classList.remove('open');
    document.getElementById('user-login-email').value = '';
}

document.getElementById('user-login-modal').addEventListener('click', e => {
    if (e.target.id === 'user-login-modal') closeUserLogin();
});

document.getElementById('user-login-email').addEventListener('keydown', e => {
    if (e.key === 'Enter') doUserLogin();
});

async function doUserLogin() {
    const email = document.getElementById('user-login-email').value.trim();
    const status = document.getElementById('user-login-status');
    if (!email) { status.textContent = 'Please enter an email.'; status.className = 'user-login-status error'; status.style.display = ''; return; }

    status.textContent = 'Sending magic link...';
    status.className = 'user-login-status';
    status.style.display = '';

    try {
        const res = await fetch(`${SUPABASE_URL}/auth/v1/magiclink`, {
            method: 'POST',
            headers: { apikey: ANON_KEY, 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, options: { emailRedirectTo: window.location.href.split('#')[0].split('?')[0] } }),
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            status.textContent = err.msg || err.error_description || 'Failed to send magic link.';
            status.className = 'user-login-status error';
        } else {
            status.textContent = 'Check your email for a magic link to sign in!';
            status.className = 'user-login-status success';
        }
    } catch (e) {
        status.textContent = 'Network error: ' + e.message;
        status.className = 'user-login-status error';
    }
}

async function doUserLogout() {
    if (authAccessToken) {
        try {
            await fetch(`${SUPABASE_URL}/auth/v1/logout`, {
                method: 'POST',
                headers: { apikey: ANON_KEY, Authorization: `Bearer ${authAccessToken}` },
            });
        } catch (_) {}
    }
    authAccessToken = null;
    authRefreshToken = null;
    localStorage.removeItem('bwai-auth-token');
    localStorage.removeItem('bwai-auth-refresh');
    currentUser = null;
    currentProfile = null;
    userLifeList = [];
    userFollowedFeeders = [];
    isModAsCommunityUser = false;
    updateCommunityUI();
    renderFeed();
    showToast('Signed out');
}

// ── User profile editing ─────────────────────────────────
function openUserProfile() {
    if (!currentUser) return;
    document.getElementById('user-profile-name').value = currentProfile?.display_name || '';
    document.getElementById('user-profile-bio').value = currentProfile?.bio || '';
    document.getElementById('user-profile-status').style.display = 'none';
    document.getElementById('user-profile-modal').classList.add('open');
}

function closeUserProfile() {
    document.getElementById('user-profile-modal').classList.remove('open');
}

document.getElementById('user-profile-modal').addEventListener('click', e => {
    if (e.target.id === 'user-profile-modal') closeUserProfile();
});

async function saveUserProfile() {
    const name = document.getElementById('user-profile-name').value.trim();
    const bio = document.getElementById('user-profile-bio').value.trim();
    const status = document.getElementById('user-profile-status');

    if (!name) { status.textContent = 'Display name is required.'; status.className = 'user-login-status error'; status.style.display = ''; return; }
    if (!authAccessToken) { status.textContent = 'Sign in required.'; status.className = 'user-login-status error'; status.style.display = ''; return; }

    try {
        const res = await fetch(`${SUPABASE_URL}/rest/v1/user_profiles?id=eq.${currentUser.id}`, {
            method: 'PATCH',
            headers: sbHeaders(true),
            body: JSON.stringify({ display_name: name, bio }),
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.message || 'Failed to save');
        }
        currentProfile = { ...currentProfile, display_name: name, bio };
        updateCommunityUI();
        closeUserProfile();
        showToast('Profile saved');
    } catch (e) {
        status.textContent = e.message;
        status.className = 'user-login-status error';
        status.style.display = '';
    }
}

// ── Life list ────────────────────────────────────────────
async function loadUserLifeList() {
    if (!currentUser) { userLifeList = []; return; }
    if (isModAsCommunityUser) { userLifeList = []; return; }
    const { data } = await sbRpc('get_life_list', { p_user_id: currentUser.id }, true);
    if (Array.isArray(data)) {
        userLifeList = data.map(item => item.species);
    }
}

async function toggleLifeListSpecies(species, detectionId, btn) {
    if (!currentUser) { openUserLogin(); return; }

    const isOnList = userLifeList.includes(species);
    if (isOnList) {
        if (isModAsCommunityUser) {
            const c = getModCreds();
            await sbRpc('mod_remove_from_life_list', { p_email: c.email, p_password: c.password, p_user_id: currentUser.id, p_species: species }, false);
        } else {
            await sbRpc('remove_from_life_list', { p_species: species }, true);
        }
        userLifeList = userLifeList.filter(s => s !== species);
        if (btn) { btn.classList.remove('on-list'); btn.textContent = '+ Life List'; btn.title = 'Add to life list'; }
        showToast(`${species} removed from life list`);
    } else {
        if (isModAsCommunityUser) {
            const c = getModCreds();
            await sbRpc('mod_add_to_life_list', { p_email: c.email, p_password: c.password, p_user_id: currentUser.id, p_species: species, p_detection_id: detectionId || null, p_notes: '' }, false);
        } else {
            await sbRpc('add_to_life_list', { p_species: species, p_detection_id: detectionId || null, p_notes: '' }, true);
        }
        userLifeList.push(species);
        if (btn) { btn.classList.add('on-list'); btn.textContent = '✓ Listed'; btn.title = 'Remove from life list'; }
        showToast(`${species} added to life list!`);
    }
}

function openLifeList(userId) {
    const targetId = userId || currentUser?.id;
    if (!targetId) { openUserLogin(); return; }
    const isOwn = targetId === currentUser?.id;
    document.getElementById('life-list-title').textContent = isOwn ? 'My Life List' : 'Life List';
    document.getElementById('life-list-share-btn').style.display = isOwn ? '' : 'none';
    document.getElementById('life-list-modal').classList.add('open');
    loadAndRenderLifeList(targetId, isOwn);
}

function closeLifeList() {
    document.getElementById('life-list-modal').classList.remove('open');
}

document.getElementById('life-list-modal').addEventListener('click', e => {
    if (e.target.id === 'life-list-modal') closeLifeList();
});

async function loadAndRenderLifeList(userId, isOwn) {
    const content = document.getElementById('life-list-content');
    content.innerHTML = '<div class="life-list-empty">Loading...</div>';

    const { data } = await sbRpc('get_life_list', { p_user_id: userId }, false);
    const list = data || [];
    document.getElementById('life-list-count').textContent = `${list.length} species`;

    if (!list.length) {
        content.innerHTML = `<div class="life-list-empty">${isOwn ? 'Your life list is empty. Add species from detection cards!' : 'This birder hasn\'t added any species yet.'}</div>`;
        return;
    }

    content.innerHTML = `<div class="life-list-grid">${list.map(item => `
        <div class="life-list-item">
            <span class="species-name">${esc(item.species)}</span>
            <span class="first-seen">${new Date(item.first_seen).toLocaleDateString()}</span>
            ${isOwn ? `<button class="life-list-remove" onclick="removeFromLifeListModal('${esc(item.species)}', this)" title="Remove">✕</button>` : ''}
        </div>
    `).join('')}</div>`;
}

async function removeFromLifeListModal(species, btn) {
    if (isModAsCommunityUser) {
        const c = getModCreds();
        await sbRpc('mod_remove_from_life_list', { p_email: c.email, p_password: c.password, p_user_id: currentUser.id, p_species: species }, false);
    } else {
        await sbRpc('remove_from_life_list', { p_species: species }, true);
    }
    userLifeList = userLifeList.filter(s => s !== species);
    btn.closest('.life-list-item').remove();
    const count = document.querySelectorAll('.life-list-item').length;
    document.getElementById('life-list-count').textContent = `${count} species`;
    showToast(`${species} removed`);
}

function shareLifeList() {
    if (!currentUser) return;
    const url = `${window.location.href.split('?')[0]}?lifelist=${currentUser.id}`;
    navigator.clipboard.writeText(url).then(() => showToast('Life list link copied!')).catch(() => {});
}

// Handle ?lifelist=UUID in URL
function handleLifeListLink() {
    const params = new URLSearchParams(window.location.search);
    const lifeListId = params.get('lifelist');
    if (lifeListId) openLifeList(lifeListId);
}

// ── Follow a Feeder ──────────────────────────────────────
async function loadUserFollowedFeeders() {
    if (!currentUser) { userFollowedFeeders = []; return; }
    if (isModAsCommunityUser) { userFollowedFeeders = []; return; }
    const { data } = await sbRpc('get_followed_feeders', {}, true);
    if (Array.isArray(data)) {
        userFollowedFeeders = data.map(f => f.feeder_id);
    }
}

async function toggleFollowFeeder(feederId, btn) {
    if (!currentUser) { openUserLogin(); return; }

    let data;
    if (isModAsCommunityUser) {
        const c = getModCreds();
        ({ data } = await sbRpc('mod_toggle_feeder_follow', { p_email: c.email, p_password: c.password, p_user_id: currentUser.id, p_feeder_id: feederId }, false));
    } else {
        ({ data } = await sbRpc('toggle_feeder_follow', { p_feeder_id: feederId }, true));
    }
    if (data?.following) {
        userFollowedFeeders.push(feederId);
        if (btn) { btn.classList.add('following'); btn.textContent = '★ Following'; }
        showToast('Now following this feeder!');
    } else {
        userFollowedFeeders = userFollowedFeeders.filter(id => id !== feederId);
        if (btn) { btn.classList.remove('following'); btn.textContent = '☆ Follow'; }
        showToast('Unfollowed feeder');
    }
}

// ── Comments ─────────────────────────────────────────────
let activeCommentDetectionId = null;

async function loadCommentCounts(detectionIds) {
    if (!detectionIds.length) return;
    try {
        const { data } = await sbRpc('get_comment_counts', { p_detection_ids: detectionIds }, false);
        if (data && typeof data === 'object') {
            Object.assign(commentCounts, data);
        }
    } catch (_) { /* non-critical */ }
}

function openComments(detectionId) {
    activeCommentDetectionId = detectionId;
    document.getElementById('comments-modal').classList.add('open');
    loadAndRenderComments(detectionId);
}

function closeComments() {
    document.getElementById('comments-modal').classList.remove('open');
    activeCommentDetectionId = null;
}

document.getElementById('comments-modal').addEventListener('click', e => {
    if (e.target.id === 'comments-modal') closeComments();
});

async function loadAndRenderComments(detectionId) {
    const list = document.getElementById('comments-list');
    const compose = document.getElementById('comment-compose-area');
    list.innerHTML = '<div style="text-align:center;color:var(--color-gray-500);padding:1rem;">Loading...</div>';

    const { data } = await sbRpc('get_comments', { p_detection_id: detectionId }, false);
    const comments = data || [];

    if (!comments.length) {
        list.innerHTML = '<div style="text-align:center;color:var(--color-gray-500);padding:1rem;">No comments yet. Be the first!</div>';
    } else {
        // Build threaded comments: top-level first, then replies
        const topLevel = comments.filter(c => !c.parent_id);
        const replies = comments.filter(c => c.parent_id);
        const replyMap = {};
        replies.forEach(r => {
            if (!replyMap[r.parent_id]) replyMap[r.parent_id] = [];
            replyMap[r.parent_id].push(r);
        });

        list.innerHTML = topLevel.map(c => renderCommentItem(c, replyMap, detectionId)).join('');
    }

    // Compose area
    if (currentUser) {
        compose.innerHTML = `
            <div class="comment-compose">
                <textarea id="comment-input" placeholder="Add a comment..." maxlength="2000"></textarea>
                <button onclick="submitComment('${detectionId}')">Post</button>
            </div>`;
    } else {
        compose.innerHTML = `<div class="comment-login-prompt"><a onclick="closeComments();openUserLogin();">Sign in</a> to post a comment.</div>`;
    }
}

function renderCommentItem(comment, replyMap, detectionId) {
    const isOwn = currentUser && comment.user_id === currentUser.id;
    const childReplies = replyMap[comment.id] || [];
    const ago = timeAgo(comment.created_at);

    return `
        <div class="comment-item" data-comment-id="${comment.id}">
            <span class="comment-author">${esc(comment.display_name || 'Birder')}</span>
            <span class="comment-time">${ago}</span>
            <div class="comment-body">${esc(comment.body)}</div>
            <div class="comment-actions">
                ${currentUser ? `<button onclick="startReply('${comment.id}', '${esc(comment.display_name)}')">Reply</button>` : ''}
                ${isOwn ? `<button onclick="deleteComment('${comment.id}', '${detectionId}')">Delete</button>` : ''}
            </div>
            ${childReplies.map(r => `<div class="comment-reply">${renderCommentItem(r, replyMap, detectionId)}</div>`).join('')}
        </div>`;
}

function timeAgo(dateStr) {
    const diff = Date.now() - new Date(dateStr).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.floor(hrs / 24);
    if (days < 30) return `${days}d ago`;
    return new Date(dateStr).toLocaleDateString();
}

function startReply(parentId, authorName) {
    const input = document.getElementById('comment-input');
    if (input) {
        input.dataset.parentId = parentId;
        input.placeholder = `Replying to ${authorName}...`;
        input.focus();
    }
}

async function submitComment(detectionId) {
    const input = document.getElementById('comment-input');
    if (!input || !currentUser) return;
    const body = input.value.trim();
    if (!body) return;

    const parentId = input.dataset.parentId || null;
    const btn = input.nextElementSibling;
    btn.disabled = true;

    let data, error;
    if (isModAsCommunityUser) {
        const c = getModCreds();
        ({ data, error } = await sbRpc('mod_post_comment', { p_email: c.email, p_password: c.password, p_user_id: currentUser.id, p_detection_id: detectionId, p_body: body, p_parent_id: parentId }, false));
    } else {
        ({ data, error } = await sbRpc('post_comment', { p_detection_id: detectionId, p_body: body, p_parent_id: parentId }, true));
    }

    btn.disabled = false;

    if (error) {
        showToast('Failed to post comment: ' + (error.message || JSON.stringify(error)));
    } else {
        input.value = '';
        input.dataset.parentId = '';
        input.placeholder = 'Add a comment...';
        commentCounts[detectionId] = (commentCounts[detectionId] || 0) + 1;
        loadAndRenderComments(detectionId);
        // Update card button
        document.querySelectorAll(`.card[data-id="${detectionId}"] .card-comment-btn`).forEach(btn => {
            btn.textContent = `💬 ${commentCounts[detectionId]}`;
        });
    }
}

async function deleteComment(commentId, detectionId) {
    if (isModAsCommunityUser) {
        const c = getModCreds();
        await sbRpc('mod_delete_comment', { p_email: c.email, p_password: c.password, p_comment_id: commentId }, false);
    } else {
        await sbRpc('delete_comment', { p_comment_id: commentId }, true);
    }
    commentCounts[detectionId] = Math.max(0, (commentCounts[detectionId] || 1) - 1);
    loadAndRenderComments(detectionId);
}

// ── Flagging / reporting ─────────────────────────────────
function openFlag(detectionId) {
    if (!currentUser) { openUserLogin(); return; }
    document.getElementById('flag-detection-id').value = detectionId;
    document.getElementById('flag-reason').value = 'wrong_species';
    document.getElementById('flag-details').value = '';
    document.getElementById('flag-status').style.display = 'none';
    document.getElementById('flag-modal').classList.add('open');
}

function closeFlag() {
    document.getElementById('flag-modal').classList.remove('open');
}

document.getElementById('flag-modal').addEventListener('click', e => {
    if (e.target.id === 'flag-modal') closeFlag();
});

async function submitFlag() {
    const detectionId = document.getElementById('flag-detection-id').value;
    const reason = document.getElementById('flag-reason').value;
    const details = document.getElementById('flag-details').value.trim();
    const status = document.getElementById('flag-status');

    if (isModAsCommunityUser) {
        // Moderators can already edit/delete detections directly
        showToast('As a moderator you can edit or delete detections directly.');
        closeFlag();
        return;
    }

    const { data, error } = await sbRpc('flag_detection', {
        p_detection_id: detectionId,
        p_reason: reason,
        p_details: details
    }, true);

    if (error) {
        status.textContent = error.message || JSON.stringify(error);
        status.className = 'user-login-status error';
        status.style.display = '';
    } else {
        showToast('Report submitted. Thank you!');
        closeFlag();
    }
}

// ── Mod: flag queue ──────────────────────────────────────
function openFlagQueue() {
    if (!isModLoggedIn()) return;
    document.getElementById('flag-queue-modal').classList.add('open');
    loadFlagQueue();
}

function closeFlagQueue() {
    document.getElementById('flag-queue-modal').classList.remove('open');
}

document.getElementById('flag-queue-modal').addEventListener('click', e => {
    if (e.target.id === 'flag-queue-modal') closeFlagQueue();
});

async function loadFlagQueue() {
    const list = document.getElementById('flag-queue-list');
    list.innerHTML = '<div style="text-align:center;color:var(--color-gray-500);padding:1rem;">Loading...</div>';

    const creds = getModCreds();
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/get_flag_queue`, {
        method: 'POST',
        headers: { apikey: ANON_KEY, Authorization: `Bearer ${ANON_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ p_email: creds.email, p_password: creds.password }),
    });
    const flags = await res.json();

    if (!Array.isArray(flags) || !flags.length) {
        list.innerHTML = '<div style="text-align:center;color:var(--color-gray-500);padding:1rem;">No pending flags. All clear!</div>';
        return;
    }

    const reasonLabels = { wrong_species: 'Wrong Species', inappropriate: 'Inappropriate', duplicate: 'Duplicate', spam: 'Spam', other: 'Other' };
    list.innerHTML = flags.map(f => `
        <div class="flag-queue-item" data-flag-id="${f.flag_id}">
            ${f.image_url ? `<img src="${f.image_url}" alt="">` : '<div style="width:60px;height:60px;background:var(--bg-input);border-radius:6px;"></div>'}
            <div class="flag-queue-info">
                <div class="species">${esc(f.species || 'Unknown')}</div>
                <div class="reason">${reasonLabels[f.reason] || f.reason}${f.flag_count > 1 ? ` (${f.flag_count} reports)` : ''}</div>
                ${f.details ? `<div class="details">${esc(f.details)}</div>` : ''}
                <div class="reporter">Reported by ${esc(f.reporter_name || 'user')} · ${timeAgo(f.created_at)}</div>
            </div>
            <div class="flag-queue-actions">
                <button class="btn-resolve" onclick="resolveFlag('${f.flag_id}', 'reviewed')">✓ Reviewed</button>
                <button class="btn-dismiss" onclick="resolveFlag('${f.flag_id}', 'dismissed')">✕ Dismiss</button>
            </div>
        </div>
    `).join('');
}

async function resolveFlag(flagId, action) {
    const creds = getModCreds();
    await fetch(`${SUPABASE_URL}/rest/v1/rpc/resolve_flag`, {
        method: 'POST',
        headers: { apikey: ANON_KEY, Authorization: `Bearer ${ANON_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ p_email: creds.email, p_password: creds.password, p_flag_id: flagId, p_action: action }),
    });
    const item = document.querySelector(`.flag-queue-item[data-flag-id="${flagId}"]`);
    if (item) item.remove();
    showToast(action === 'reviewed' ? 'Flag reviewed' : 'Flag dismissed');
    // If empty, show message
    if (!document.querySelectorAll('.flag-queue-item').length) {
        document.getElementById('flag-queue-list').innerHTML = '<div style="text-align:center;color:var(--color-gray-500);padding:1rem;">No pending flags. All clear!</div>';
    }
}

// Restore moderator UI state on page load
updateModUI();
// If a mod session exists, bridge them as a community user too
if (isModLoggedIn()) {
    const email = sessionStorage.getItem('bwai-mod-user');
    const role = sessionStorage.getItem('bwai-mod-role');
    // Use the anonymous user ID as a stable ID for the bridged mod
    bridgeModAsCommunityUser(email, role, ANON_USER_ID);
}

// ── Init ─────────────────────────────────────────────────
initCommunityAuth().then(() => {
    // If Supabase Auth returned a real user, prefer that over the mod bridge
    if (currentUser && !isModAsCommunityUser) updateCommunityUI();
    handleLifeListLink();
});
loadSeasonEarliest();
loadFeed().then(handleSharedId);

// Eagerly initialize the map off-screen so it's ready when the tab is clicked.
// We temporarily make it visible (but off-screen) so Leaflet can measure it.
window.addEventListener('load', () => {
    const mv = document.getElementById('map-view');
    mv.style.cssText = 'position:absolute;visibility:hidden;top:-9999px';
    initMap();
    mv.style.cssText = '';
    mv.style.display = 'none';
});
