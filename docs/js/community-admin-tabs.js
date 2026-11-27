// BirdWatchAI Community — tabs and filters in the Site admin dialog.
//
// The dialog used to stack four jobs one under another: moderators, communities, users and
// remote support. Two of those lists grow with every school that signs up, and the complaint was
// that the dialog "has too many items on it, and when users and communities grow it will only get
// worse". So it shows one job at a time, and the two long lists get a filter box.
//
// Deliberately presentation-only. Every list is still in the page and still loads when the dialog
// opens, through the loaders in community-auth.js, community-communities.js,
// community-admin-users.js and community-remote.js, which find their lists by id and know nothing
// about tabs. That keeps this file independent of which version of those the CDN serves (the same
// reason they wire themselves to the admin button rather than being called from openAdminPanel).
//
// Needs nothing from other scripts.

(function () {
    'use strict';

    const modal = document.getElementById('mod-admin-modal');
    if (!modal) return;

    const tabs   = [...modal.querySelectorAll('[data-admin-tab]')];
    const panels = [...modal.querySelectorAll('[data-admin-panel]')];
    if (!tabs.length || !panels.length) return;

    // The last tab used, so an admin who lives in Users is not sent back to Moderators every time.
    // A per-browser convenience only: storage can be blocked or empty, and then Moderators it is.
    const STORE = 'bwai-admin-tab';
    function remembered() {
        try { return localStorage.getItem(STORE); } catch { return null; }
    }
    function remember(name) {
        try { localStorage.setItem(STORE, name); } catch { /* not worth telling anyone */ }
    }

    function show(name) {
        if (!panels.some(p => p.dataset.adminPanel === name)) name = tabs[0].dataset.adminTab;
        for (const t of tabs) {
            const on = t.dataset.adminTab === name;
            t.classList.toggle('active', on);
            t.setAttribute('aria-selected', on ? 'true' : 'false');
            t.tabIndex = on ? 0 : -1;
        }
        for (const p of panels) p.hidden = p.dataset.adminPanel !== name;
        // Each tab starts at its own top. Without this, switching from a long Users list to
        // Remote support landed part-way down a short panel, or past its end.
        const box = modal.querySelector('.mod-admin-box');
        if (box) box.scrollTop = 0;
        remember(name);
    }

    for (const t of tabs) t.addEventListener('click', () => show(t.dataset.adminTab));

    // Arrow keys between tabs, as a tablist is expected to behave.
    modal.querySelector('.admin-tabs')?.addEventListener('keydown', e => {
        if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
        const i = tabs.findIndex(t => t.classList.contains('active'));
        const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
        show(next.dataset.adminTab);
        next.focus();
        e.preventDefault();
    });

    show(remembered() || tabs[0].dataset.adminTab);

    // ── Filters ─────────────────────────────────────────────
    // Matches anywhere in a row's text, so a name, an email, a community code or an owner all
    // work without this file knowing how any row is laid out. A row is never filtered out while
    // it is the list's "Loading…" or error line: those have no data attributes in common with
    // real rows, so the rule is simply "only filter when there is a query", and an empty result
    // says so instead of showing a blank box.
    function applyFilter(input) {
        const list = document.getElementById(input.dataset.adminFilter);
        if (!list) return;
        const q = input.value.trim().toLowerCase();
        let shown = 0, rows = 0;
        for (const li of list.children) {
            if (li.classList.contains('admin-filter-empty')) continue;
            rows++;
            const hit = !q || li.textContent.toLowerCase().includes(q);
            li.hidden = !hit;
            if (hit) shown++;
        }
        let empty = list.querySelector(':scope > .admin-filter-empty');
        if (q && rows && !shown) {
            if (!empty) {
                empty = document.createElement('li');
                empty.className = 'admin-filter-empty';
                list.appendChild(empty);
            }
            empty.textContent = `Nothing matches "${input.value.trim()}".`;
        } else if (empty) {
            empty.remove();
        }
    }

    for (const input of modal.querySelectorAll('[data-admin-filter]')) {
        input.addEventListener('input', () => applyFilter(input));
        // The lists are rebuilt whenever the dialog opens or a row changes (an invite, a delete,
        // a session renewed). Re-apply the filter after each rebuild so the box never claims to
        // filter a list it has stopped filtering. Our own writes (hidden, the empty row) would
        // retrigger this, so it ignores mutations it caused.
        const list = document.getElementById(input.dataset.adminFilter);
        if (!list || typeof MutationObserver !== 'function') continue;
        let applying = false;
        new MutationObserver(() => {
            if (applying || !input.value.trim()) return;
            applying = true;
            try { applyFilter(input); } finally {
                // Release after the observer has seen our own changes.
                queueMicrotask(() => { applying = false; });
            }
        }).observe(list, { childList: true });
    }
})();
