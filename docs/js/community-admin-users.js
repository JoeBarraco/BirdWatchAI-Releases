// BirdWatchAI Community — the admin panel's Users section.
//
// Admin-only and read-only. One row per account, most recently active first:
// when they joined, when they last signed in, what communities and classrooms
// they belong to, and how much they have done. It exists so "has this teacher
// signed in since we set them up?" can be answered from the admin panel
// instead of the Supabase dashboard.
//
// Everything shown comes from admin_list_user_activity
// (supabase/setup-admin-user-activity.sql), which only reads data the database
// already keeps. Nothing here records anything about anyone.
//
// Depends only on globals from community-core.js / community-auth.js: sbRpc,
// getModToken, isAdmin. Self-contained otherwise, like community-remote.js, so
// the section works whatever version of the other scripts the CDN is serving.

(function () {
    'use strict';

    function auEsc(s) {
        return String(s ?? '').replace(/[&<>"']/g, c =>
            ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    // Days rather than hours past the first day: the question this section
    // answers is "are they still using it", and "412 h ago" makes the reader
    // do arithmetic to get to "about two weeks".
    function auRel(iso) {
        if (!iso) return 'never';
        const secs = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
        if (secs < 3600) return Math.max(1, Math.round(secs / 60)) + ' min ago';
        if (secs < 86400) return Math.round(secs / 3600) + ' h ago';
        const days = Math.round(secs / 86400);
        if (days < 60) return days + ' day' + (days === 1 ? '' : 's') + ' ago';
        return new Date(iso).toLocaleDateString();
    }

    // "3 comments" / "1 comment", and nothing at all for zero: a row listing
    // eight zero counts buries the one thing the person actually did.
    function auCount(n, word) {
        if (!n) return null;
        return `${n} ${word}${n === 1 ? '' : 's'}`;
    }

    // Self-wiring, same pattern as the community roster and remote support:
    // hook the admin button and own our section.
    document.getElementById('navbar-admin-btn')
        ?.addEventListener('click', () => { refreshAdminUserActivity(); });

    async function refreshAdminUserActivity() {
        const list = document.getElementById('admin-user-activity-list');
        if (!list) return;
        const token = typeof getModToken === 'function' && getModToken();
        if (!token || !(typeof isAdmin === 'function' && isAdmin())) { list.innerHTML = ''; return; }

        list.innerHTML = '<li style="color:var(--color-gray-500)">Loading…</li>';

        // Wrapped for the same reason as the community roster: an exception
        // must not leave the section on "Loading…", which looks like a hang.
        let data, error;
        try {
            ({ data, error } = await sbRpc('admin_list_user_activity', { p_token: token }, false));
        } catch (err) {
            list.innerHTML = `<li style="color:#e74c3c">${auEsc(err.message || 'Request failed')}</li>`;
            return;
        }
        if (error) {
            // Before the SQL is applied the RPC simply does not exist; say
            // that rather than showing PostgREST's schema-cache wording.
            const missing = /could not find the function|does not exist/i.test(error.message || '');
            list.innerHTML = `<li style="color:#e74c3c">${auEsc(missing
                ? 'Not set up yet: apply supabase/setup-admin-user-activity.sql.'
                : (error.message || 'Failed to load'))}</li>`;
            return;
        }

        const users = Array.isArray(data) ? data : [];
        if (!users.length) {
            list.innerHTML = '<li style="color:var(--color-gray-500)">No accounts yet.</li>';
            return;
        }

        list.innerHTML = users.map(u => {
            const name = u.display_name ? `${auEsc(u.display_name)} · ${auEsc(u.email)}` : auEsc(u.email);

            // Moderators sign in through their own login, which never moves
            // last_sign_in_at, so their mod login is shown when it is the
            // more recent of the two.
            const signedIn = (u.last_mod_login_at && (!u.last_sign_in_at || u.last_mod_login_at > u.last_sign_in_at))
                ? `mod login ${auRel(u.last_mod_login_at)}`
                : `signed in ${auRel(u.last_sign_in_at)}`;

            const when = [
                `active ${auRel(u.last_activity_at)}`,
                signedIn,
                `joined ${new Date(u.joined_at).toLocaleDateString()}`,
            ].join(' · ');

            const belongs = [
                u.mod_role ? `${u.mod_role}` : null,
                (u.communities || []).length
                    ? (u.communities || []).map(c => `${c.name} (${c.role})`).join(', ')
                    : 'no community',
                (u.classrooms || []).length ? `teaches ${(u.classrooms || []).join(', ')}` : null,
                u.feeder_count
                    ? `${auCount(u.feeder_count, 'feeder')}, last check-in ${auRel(u.last_feeder_checkin_at)}`
                    : null,
            ].filter(Boolean).join(' · ');

            const did = [
                auCount(u.comment_count, 'comment'),
                auCount(u.reaction_count, 'reaction'),
                auCount(u.flag_count, 'flag'),
                auCount(u.follow_count, 'follow'),
                auCount(u.feedback_count, 'classroom note'),
                auCount(u.question_count, 'own question'),
                auCount(u.life_list_count, 'life-list bird'),
            ].filter(Boolean).join(' · ');

            return `
                <li>
                    <div class="mod-user-info">
                        <strong>${name}</strong>
                        <span class="admin-user-meta">${auEsc(when)}</span>
                        <span class="admin-user-meta">${auEsc(belongs)}</span>
                        ${did ? `<span class="admin-user-meta">${auEsc(did)}</span>` : ''}
                    </div>
                </li>`;
        }).join('');
    }
})();
