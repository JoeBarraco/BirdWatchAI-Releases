// BirdWatchAI Classroom — logos for a class, and for a Home Classroom
//
// Two pictures, two levels:
//   * the COMMUNITY logo (a school's crest, or a Home Classroom's), which
//     already existed and is set by the community's owner in the
//     Communities panel. A Home Classroom's owner never goes there, so the
//     Home Classroom banner offers it too (chLogoHtml below);
//   * a CLASS logo, new (supabase/setup-classroom-logos.sql): a class's
//     mascot, or a Home Classroom child's own picture. Set by whoever runs
//     the class. Shown beside the class's name in the panel, on the board
//     during its lessons, and on its take-home card, journal and certificate.
//
// Uploads go through communityLogoPng (community-communities.js): shrunk
// to a 256px PNG in the browser, never SVG, a new file name each time so a
// replaced picture is not served from cache.

function clLogoOk(url) {
    return typeof url === 'string' && /^https:\/\//i.test(url);
}

/** The class's picture as an <img>, or '' when it has none. */
function clClassLogoHtml(room, cls) {
    if (!room || !clLogoOk(room.logo_url)) return '';
    return `<img class="cl-logo ${cls || ''}" src="${esc(room.logo_url)}" alt="" onerror="this.remove()">`;
}

/** Upload / Replace / Remove, for the class's own header in the panel. */
function clClassLogoControls(room) {
    if (!room) return '';
    const id = escJs(room.id);
    // Rendered as entries in the class's ⚙ Settings menu (renderClassroomActions).
    return `<label class="navbar-menu-item cl-pick" role="menuitem" title="A picture for this class: a mascot, or your child’s own drawing">
            <input type="file" accept="image/png,image/jpeg,image/webp" onchange="clUploadClassLogo('${id}', this)">
            🖼 ${room.logo_url ? 'Change picture' : 'Add a picture'}</label>
        ${room.logo_url ? `<button class="navbar-menu-item" role="menuitem" onclick="clClearClassLogo('${id}')" title="Remove this class’s picture">🚫 Remove picture</button>` : ''}`;
}

async function clUploadClassLogo(roomId, input) {
    const file = input && input.files && input.files[0];
    if (!file) return;
    const room = (classroomList || []).find(r => r.id === roomId);
    if (!room) return;
    if (!/^image\/(png|jpeg|webp)$/.test(file.type)) {
        showToast('Please choose a PNG, JPEG or WebP picture.');
        input.value = '';
        return;
    }
    try {
        showToast('Uploading…');
        const png = await communityLogoPng(file);
        const path = `${classroomCommunityId}/classes/${roomId}/logo-${Date.now()}.png`;
        const headers = sbHeaders(true);
        headers['Content-Type'] = 'image/png';
        const res = await fetch(`${SUPABASE_URL}/storage/v1/object/community-logos/${path}`,
                                { method: 'POST', headers, body: png });
        if (!res.ok) {
            let msg = `Upload failed (${res.status})`;
            try { const j = await res.json(); if (j && j.message) msg = j.message; } catch { /* keep */ }
            throw new Error(msg);
        }
        const url = `${SUPABASE_URL}/storage/v1/object/public/community-logos/${path}`;
        const { error } = await sbRpc('classroom_set_logo', { p_classroom_id: roomId, p_logo_url: url }, true);
        if (error) throw new Error(error.message || 'Could not save the picture.');
        room.logo_url = url;
        showToast('Picture saved.');
        clRedraw();
    } catch (e) {
        showToast(e.message || 'Upload failed.');
    } finally {
        if (input) input.value = '';
    }
}

async function clClearClassLogo(roomId) {
    if (!confirm('Remove this class’s picture?')) return;
    const { error } = await sbRpc('classroom_set_logo', { p_classroom_id: roomId, p_logo_url: null }, true);
    if (error) { showToast(error.message || 'Could not remove it.'); return; }
    const room = (classroomList || []).find(r => r.id === roomId);
    if (room) room.logo_url = null;
    clRedraw();
}

function clRedraw() {
    if (typeof renderClassroomList === 'function') renderClassroomList();
    if (typeof renderClassroomActions === 'function') renderClassroomActions();
}

// The remove buttons are spelled out ("🗑 Remove logo"), not a bare ✕: sitting
// at the right-hand end of a banner, an ✕ reads as "close this banner" and was
// nearly clicked that way. The confirm() in the handlers stays as a second guard.

// ── The Home Classroom's own logo ────────────────────────

/** For the Home Classroom banner: the community logo, settable in place. */
function chLogoHtml() {
    const c = (myCommunities || []).find(x => x.id === classroomCommunityId);
    if (!c || c.role !== 'owner') return '';
    // No thumbnail: these controls now sit right under the large logo in the
    // left column (#ch-logo-slot), so a second small copy would be noise.
    return `<span class="cl-controls ch-logo">
        <label class="classroom-btn cl-pick" title="A picture for your Home Classroom, shown at the top of every lesson">
            <input type="file" accept="image/png,image/jpeg,image/webp" onchange="chUploadLogo(this)">
            🖼 ${c.logo_url ? 'Change logo' : 'Add a logo'}</label>
        ${c.logo_url ? '<button class="classroom-btn cl-remove" onclick="chClearLogo()" title="Remove the logo">🗑 Remove logo</button>' : ''}
    </span>`;
}

async function chUploadLogo(input) {
    if (typeof uploadCommunityLogo !== 'function') return;
    await uploadCommunityLogo(classroomCommunityId, input);
    if (typeof chRenderBanner === 'function') await chRenderBanner();
}

async function chClearLogo() {
    if (typeof clearCommunityLogo !== 'function') return;
    await clearCommunityLogo(classroomCommunityId);
    if (typeof chRenderBanner === 'function') await chRenderBanner();
}
