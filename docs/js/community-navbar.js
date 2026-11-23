// ── Community navbar menus ─────────────────────────────────────────────────
//
// The navbar has three zones (see the comment above <nav> in community.html):
// primary buttons, a "Moderate" menu and an account menu. The buttons inside
// the menus are the same elements, with the same ids, that community-auth.js,
// community-communities.js and community-classroom.js already show and hide
// with element.style.display. This file deliberately does NOT call into those
// files or change how they decide visibility. It only watches the result:
//
//   * opens and closes the menus (click, Escape, click outside, item chosen)
//   * hides a [data-auto-hide] menu when every item in it is hidden
//   * shows the [data-admin-only] / [data-signed-in-only] separators and
//     labels only when the items they introduce are visible
//   * hides the "Moderator" section label when nothing under it is visible
//   * puts the signed-in name on the account button, "☰ Menu" otherwise
//   * shows the moderator-mode banner while a moderator session is live
//
// Watching with a MutationObserver rather than hooking the update functions
// means whichever version of those files the CDN serves, this keeps up.
(function () {
    'use strict';

    const nav = document.querySelector('.top-navbar');
    if (!nav) return;

    const isShown = (el) => !!el && el.style.display !== 'none';
    // Only touch the attribute when it actually changes, so our own writes
    // don't keep re-triggering the observer below.
    function setShown(el, on) {
        if (!el) return;
        const want = on ? '' : 'none';
        if (el.style.display !== want) el.style.display = want;
    }

    // ── open / close ──────────────────────────────────────────
    function closeAll(except) {
        nav.querySelectorAll('.navbar-menu.open').forEach((m) => {
            if (m === except) return;
            m.classList.remove('open');
            const t = m.querySelector('.navbar-menu-trigger');
            if (t) t.setAttribute('aria-expanded', 'false');
        });
    }

    nav.querySelectorAll('.navbar-menu').forEach((menu) => {
        const trigger = menu.querySelector('.navbar-menu-trigger');
        if (!trigger) return;
        trigger.addEventListener('click', (e) => {
            e.stopPropagation();
            const willOpen = !menu.classList.contains('open');
            closeAll(menu);
            menu.classList.toggle('open', willOpen);
            trigger.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
        });
        // Choosing an item closes the menu; the item's own onclick still runs.
        menu.querySelectorAll('.navbar-menu-item').forEach((item) => {
            item.addEventListener('click', () => closeAll());
        });
    });

    document.addEventListener('click', (e) => {
        if (!e.target.closest('.navbar-menu')) closeAll();
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') closeAll();
    });

    // ── keep labels, separators and menus in step with the items ──
    const $ = (id) => document.getElementById(id);

    function sync() {
        // Menus that should vanish when empty.
        nav.querySelectorAll('.navbar-menu[data-auto-hide]').forEach((menu) => {
            const any = [...menu.querySelectorAll('.navbar-menu-item')].some(isShown);
            setShown(menu, any);
            if (!any) menu.classList.remove('open');
        });

        const adminOn = isShown($('navbar-admin-btn'));
        nav.querySelectorAll('[data-admin-only]').forEach((el) => {
            setShown(el, adminOn);
        });

        const signedIn = isShown($('navbar-community-logout'));
        nav.querySelectorAll('[data-signed-in-only]').forEach((el) => {
            setShown(el, signedIn);
        });

        // "Moderator" label in the account menu: hide if nothing under it shows.
        const modLabel = [...nav.querySelectorAll('#navbar-account-menu .navbar-menu-label')]
            .find((l) => l.textContent.trim() === 'Moderator');
        if (modLabel) {
            const anyMod = ['navbar-login-btn', 'navbar-changepw-btn', 'navbar-logout-btn']
                .some((id) => isShown($(id)));
            setShown(modLabel, anyMod);
        }

        // Name on the account button.
        const userSpan = $('navbar-community-user');
        const nameEl = $('navbar-account-name');
        if (nameEl) {
            const name = isShown(userSpan) ? userSpan.textContent.trim() : '';
            const label = name ? '👤 ' + (name.length > 22 ? name.slice(0, 21) + '…' : name) : '☰ Menu';
            if (nameEl.textContent !== label) nameEl.textContent = label;
            nameEl.title = name;
        }

        // Moderator-mode banner + body class (pads the page under the banner).
        const modOn = isShown($('navbar-logout-btn'));
        const banner = $('mod-mode-banner');
        setShown(banner, modOn);
        document.body.classList.toggle('mod-mode', modOn);
    }

    // Batch bursts of changes (updateModUI flips six buttons in a row).
    let pending = false;
    function schedule() {
        if (pending) return;
        pending = true;
        requestAnimationFrame(() => { pending = false; sync(); });
    }

    new MutationObserver(schedule).observe(nav, {
        subtree: true,
        attributes: true,
        attributeFilter: ['style'],
        childList: true,
        characterData: true,
    });

    sync();
})();
