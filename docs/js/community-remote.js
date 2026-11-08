// BirdWatchAI Community — Remote Support admin panel.
//
// Admin-only. Lists feeders that are checking in for remote support, and opens / extends / closes
// sessions. The actual connection still happens on a PC via the birdwatch-tunnel tool: opening a
// session here hands you a one-double-click Windows script (and the raw commands) that attaches to
// the session and opens the feeder's dashboard in your browser. The tunnel carries SSH, so the
// dashboard stays behind SSH auth — this panel never exposes a shell by itself.
//
// Depends only on globals from community-core.js / community-auth.js: SUPABASE_URL, sbRpc,
// getModToken, isAdmin. Everything else is self-contained so this file works whatever version of
// the other scripts the CDN is serving.

(function () {
    'use strict';

    function rsEsc(s) {
        return String(s ?? '').replace(/[&<>"']/g, c =>
            ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }
    function rsToast(msg) {
        if (typeof showToast === 'function') showToast(msg); else console.log('[remote]', msg);
    }
    function rsRel(iso) {
        if (!iso) return 'never';
        const secs = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
        if (secs < 90) return Math.round(secs) + 's ago';
        if (secs < 5400) return Math.round(secs / 60) + ' min ago';
        return Math.round(secs / 3600) + ' h ago';
    }
    function rsTime(iso) {
        try { return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }
        catch { return iso; }
    }
    // A feeder "reachable right now" checked in within the last ~2 minutes (matches the server's
    // remote_support_list window).
    function rsFresh(iso) {
        return iso && (Date.now() - new Date(iso).getTime()) < 2 * 60 * 1000;
    }

    // Self-wiring, same pattern as the community roster: hook the admin button and own our section.
    document.getElementById('navbar-admin-btn')
        ?.addEventListener('click', () => { refreshRemoteSupportList(); });

    async function refreshRemoteSupportList() {
        const list = document.getElementById('remote-support-list');
        if (!list) return;
        const token = getModToken && getModToken();
        if (!token || !(typeof isAdmin === 'function' && isAdmin())) { list.innerHTML = ''; return; }

        list.innerHTML = '<li style="color:var(--color-gray-500)">Loading…</li>';
        const { data, error } = await sbRpc('remote_support_list', { p_token: token }, false);
        if (error) {
            list.innerHTML = `<li style="color:#e74c3c">Error: ${rsEsc(error.message || error.hint || 'failed to load')}</li>`;
            return;
        }
        const feeders = Array.isArray(data) ? data : [];
        if (!feeders.length) {
            list.innerHTML = '<li style="color:var(--color-gray-500)">No feeders are accepting remote support right now. A feeder must be online with remote support on (it checks in every 20 s).</li>';
            return;
        }

        list.innerHTML = feeders.map(f => {
            const open = !!f.session_until && new Date(f.session_until).getTime() > Date.now();
            const reachable = rsFresh(f.last_poll_at);
            const fid = rsEsc(f.feeder_id);
            const name = rsEsc(f.display_name || '(unnamed feeder)');
            const ver = rsEsc(f.app_version || '?');
            const status = open
                ? `<span class="mod-role-tag admin">session open → ${rsTime(f.session_until)}</span>`
                : reachable
                    ? `<span class="mod-role-tag moderator">reachable</span>`
                    : `<span class="mod-role-tag" style="opacity:.6">last seen ${rsRel(f.last_poll_at)}</span>`;

            const actions = open
                ? `<button class="mod-remove-btn" style="background:#2eaa4f;color:#fff" onclick="rsGetScript('${fid}','${name}')">Connect</button>
                   <button class="mod-remove-btn" onclick="rsCloseSession('${rsEsc(f.session_id)}','${name}')">Close</button>`
                : reachable
                    ? `<button class="mod-remove-btn" style="background:#2eaa4f;color:#fff" onclick="rsOpenSession('${fid}','${name}')">Open &amp; connect</button>`
                    : '';

            return `
                <li data-rs-feeder="${fid}" style="flex-wrap:wrap">
                    <div class="mod-user-info">
                        <strong>${name}</strong> ${status}
                        <span style="font-size:.72rem;color:var(--color-gray-500)">id ${rsEsc(String(f.feeder_id).slice(0,8))} · v${ver} · seen ${rsRel(f.last_poll_at)}</span>
                    </div>
                    <div style="display:flex;gap:.4rem">${actions}</div>
                    <div class="rs-connect" data-rs-connect="${fid}" style="flex-basis:100%;display:none;margin-top:.5rem"></div>
                </li>`;
        }).join('');
    }

    async function rsOpenSession(feederId, name) {
        const token = getModToken();
        const { data, error } = await sbRpc('remote_support_open',
            { p_token: token, p_feeder_id: feederId, p_minutes: 60 }, false);
        if (error || !data) {
            rsToast('Could not open session: ' + rsEsc((error && (error.message || error.hint)) || 'unknown error'));
            return;
        }
        rsToast('Session open for ' + name);
        renderConnect(feederId, name, data.channel, data.expires_at);
        refreshRemoteSupportList().then(() => {
            // Re-show the connect block after the list re-renders (open wiped it).
            renderConnect(feederId, name, data.channel, data.expires_at);
        });
    }

    // Re-open is idempotent server-side (returns/extends the same session), so "Connect" on an
    // already-open session just fetches the channel again without creating a second one.
    async function rsGetScript(feederId, name) {
        await rsOpenSession(feederId, name);
    }

    async function rsCloseSession(sessionId, name) {
        if (!sessionId) { rsToast('No session id to close.'); return; }
        const token = getModToken();
        const { error } = await sbRpc('remote_support_close', { p_token: token, p_session_id: sessionId }, false);
        if (error) { rsToast('Close failed: ' + rsEsc(error.message || 'unknown')); return; }
        rsToast('Session closed for ' + name);
        refreshRemoteSupportList();
    }

    // Per-feeder local ports, derived from the feeder id, so two feeders never collide on the same
    // localhost port (which is what trips SSH's "host key changed" warning).
    function rsPorts(feederId) {
        let h = 0;
        for (const ch of feederId) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
        const ssh = 2200 + (h % 90);       // 2200–2289
        const dash = 8100 + (h % 90);      // 8100–8189
        return { ssh, dash };
    }

    function rsScript(feederId, name, channel) {
        const { ssh, dash } = rsPorts(feederId);
        const safeName = name.replace(/[^A-Za-z0-9 _-]/g, '').trim() || 'feeder';
        const kh = 'bw_kh_' + feederId.replace(/[^a-f0-9]/gi, '').slice(0, 12);
        // NOTE: %CH% is a session secret. This file is safe to keep on your own PC but don't share it.
        return `@echo off
rem BirdWatchAI remote support — ${safeName}
rem Double-click to open this feeder's dashboard. Needs: the birdwatchai-server repo, the .NET SDK,
rem and ssh (built into Windows 10/11). Set up an SSH key on the Pi for a prompt-free login.
rem The channel below is a session secret with a short lifetime — don't share this file.
setlocal
set CH=${channel}
set PORT=${ssh}
set DASH=${dash}
set TUNNEL_DIR=%USERPROFILE%\\Documents\\GitHub\\birdwatchai-server\\tools\\BirdWatch.Tunnel
set RF=%TEMP%\\bw_ready_%PORT%
del "%RF%" 2>nul
set BW_TUNNEL_READY_FILE=%RF%

echo Starting tunnel to ${safeName} ...
start "birdwatch tunnel - ${safeName}" cmd /c dotnet run --project "%TUNNEL_DIR%" -- attach --channel %CH% --port %PORT%

echo Waiting for ${safeName} to come online (the feeder checks in every ~20 seconds) ...
set /a TRIES=0
:waitready
if exist "%RF%" goto ready
set /a TRIES+=1
if %TRIES% gtr 60 goto timedout
timeout /t 2 >nul
goto waitready

:timedout
echo.
echo Gave up after ~2 minutes. Is the feeder online, and is the session still open in the web panel?
pause
exit /b 1

:ready
rem Feeder is connected. Open the dashboard a few seconds after SSH brings up the forward.
start "" cmd /c "timeout /t 3 >nul & start "" http://localhost:%DASH%"
echo Opening the dashboard at http://localhost:%DASH% and an SSH session. Close this window to disconnect.
ssh -o UserKnownHostsFile="%TEMP%\\${kh}" -o StrictHostKeyChecking=accept-new -p %PORT% -L %DASH%:localhost:8080 pi@localhost
`;
    }

    function renderConnect(feederId, name, channel, expires) {
        const box = document.querySelector(`[data-rs-connect="${CSS.escape(feederId)}"]`);
        if (!box) return;
        const { ssh, dash } = rsPorts(feederId);
        const script = rsScript(feederId, name, channel);
        const blobUrl = URL.createObjectURL(new Blob([script], { type: 'text/plain' }));
        const fname = 'connect-' + (name.replace(/[^A-Za-z0-9_-]/g, '-').toLowerCase() || 'feeder') + '.cmd';
        const manual =
            `cd %USERPROFILE%\\Documents\\GitHub\\birdwatchai-server\\tools\\BirdWatch.Tunnel\n` +
            `dotnet run -- attach --channel ${channel} --port ${ssh}\n` +
            `ssh -p ${ssh} -L ${dash}:localhost:8080 pi@localhost   (then open http://localhost:${dash})`;

        box.style.display = '';
        box.innerHTML = `
            <div style="background:var(--color-gray-100,#f3f4f6);border-radius:8px;padding:.6rem .7rem;font-size:.8rem">
                <div style="margin-bottom:.4rem">Session open until <strong>${rsTime(expires)}</strong>. On your PC:</div>
                <a class="mod-remove-btn" style="background:#2eaa4f;color:#fff;text-decoration:none;display:inline-block"
                   href="${blobUrl}" download="${rsEsc(fname)}">⬇ Download connect script (.cmd)</a>
                <span style="color:var(--color-gray-500)"> — double-click it; it waits for the feeder, then opens the dashboard.</span>
                <details style="margin-top:.5rem">
                    <summary style="cursor:pointer">Prefer to type it? / Mac or Linux</summary>
                    <pre style="white-space:pre-wrap;word-break:break-all;margin:.4rem 0 0">${rsEsc(manual)}</pre>
                    <p style="color:var(--color-gray-500);margin:.3rem 0 0">The channel is a session secret — don't paste it anywhere public. For Mac/Linux, swap the path and use the same <code>attach</code> + <code>ssh -L</code> commands.</p>
                </details>
            </div>`;
    }

    // Expose the onclick handlers.
    window.refreshRemoteSupportList = refreshRemoteSupportList;
    window.rsOpenSession = rsOpenSession;
    window.rsGetScript = rsGetScript;
    window.rsCloseSession = rsCloseSession;
})();
