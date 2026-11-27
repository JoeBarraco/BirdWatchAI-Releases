/* BirdWatch live view — drop-in browser client for the community site.
 * BirdWatch live view player, shared with the relay's /demo/ page (canonical copy:
 * birdwatchai-server/tools/BirdWatch.LiveRelay/wwwroot/live-view.js — keep the two in step).
 * Used by community-live.js, which supplies the relay URL, device key and a getToken() that
 * calls the live-token edge function.
 */
(function (global) {
  'use strict';

  const STYLE = `
    .bwl{position:relative;background:#111;aspect-ratio:16/9;border-radius:10px;overflow:hidden;
         font:14px system-ui,sans-serif;color:#fff}
    .bwl img{width:100%;height:100%;object-fit:contain;display:block}
    .bwl .bwl-status{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;
         justify-content:center;gap:10px;background:rgba(0,0,0,.55);text-align:center;padding:12px}
    .bwl .bwl-badge{position:absolute;top:8px;left:8px;background:#d33;padding:2px 8px;border-radius:4px;
         font-weight:600;font-size:12px;letter-spacing:.05em}
    .bwl button{font:inherit;padding:8px 16px;border-radius:6px;border:0;background:#2a7;color:#fff;cursor:pointer}
    .bwl [hidden]{display:none!important}`;

  function injectStyle() {
    if (document.getElementById('bwl-style')) return;
    const s = document.createElement('style');
    s.id = 'bwl-style';
    s.textContent = STYLE;
    document.head.appendChild(s);
  }

  function mount(el, opts) {
    injectStyle();
    el.classList.add('bwl');
    el.innerHTML = `
      <img alt="Live feeder view" hidden>
      <span class="bwl-badge" hidden>LIVE</span>
      <div class="bwl-status"><span class="bwl-msg"></span><button hidden></button></div>`;
    const img = el.querySelector('img');
    const badge = el.querySelector('.bwl-badge');
    const overlay = el.querySelector('.bwl-status');
    const msgEl = el.querySelector('.bwl-msg');
    const btn = el.querySelector('button');

    let ws = null, objUrl = null, closedByUs = false, retries = 0, frameTimer = null;

    function show(text, buttonText) {
      overlay.hidden = false;
      msgEl.textContent = text;
      btn.hidden = !buttonText;
      if (buttonText) btn.textContent = buttonText;
    }

    function hideOverlay() { overlay.hidden = true; }

    function onFrame(blob) {
      const url = URL.createObjectURL(blob);
      img.onload = () => { if (objUrl && objUrl !== url) URL.revokeObjectURL(objUrl); objUrl = url; };
      img.src = url;
      img.hidden = false;
      badge.hidden = false;
      hideOverlay();
      clearTimeout(frameTimer);
      frameTimer = setTimeout(() => { badge.hidden = true; show('Waiting for the feeder…'); }, 8000);
    }

    async function connect() {
      closedByUs = false;
      show('Connecting…');
      let token;
      try { token = (await opts.getToken()).trim(); }
      catch { return show('Could not get access to this feeder.', 'Try again'); }

      const fps = opts.fps ? `&fps=${encodeURIComponent(opts.fps)}` : '';
      ws = new WebSocket(`${opts.relayUrl.replace(/\/$/, '')}/view/${encodeURIComponent(opts.feederId)}` +
                         `?token=${encodeURIComponent(token)}${fps}`);
      ws.binaryType = 'blob';

      ws.onmessage = ev => {
        if (typeof ev.data !== 'string') { retries = 0; return onFrame(ev.data); }
        let m; try { m = JSON.parse(ev.data); } catch { return; }
        if (m.type !== 'status') return;
        if (m.state === 'starting') show('Waking up the camera…');
        else if (m.state === 'offline') { badge.hidden = true; show('This feeder is offline right now.'); }
        else if (m.state === 'error') show(m.message || 'Camera not responding — retrying…');
        else if (m.state === 'ended') { closedByUs = true; show('Live view paused.', 'Keep watching'); }
      };

      ws.onclose = ev => {
        clearTimeout(frameTimer);
        badge.hidden = true;
        if (closedByUs) return;
        if (ev.code === 1006 && retries === 0 && !navigator.onLine) return show('You are offline.', 'Retry');
        if (retries < 5) {
          const wait = Math.min(15000, 1000 * 2 ** retries++);
          show('Reconnecting…');
          setTimeout(() => { if (!closedByUs) connect(); }, wait);
        } else {
          show('Live view unavailable.', 'Try again');
        }
      };
    }

    btn.onclick = () => { retries = 0; connect(); };

    // Stop streaming when the tab is hidden; resume when it comes back.
    function onVisibility() {
      if (document.hidden) { if (ws) stop('Live view paused.', 'Keep watching'); }
      else if (overlay.hidden === false && !btn.hidden && btn.textContent === 'Keep watching') connect();
    }
    document.addEventListener('visibilitychange', onVisibility);

    function stop(text, buttonText) {
      closedByUs = true;
      clearTimeout(frameTimer);
      if (ws) ws.close(1000);
      ws = null;
      badge.hidden = true;
      show(text || 'Live view stopped.', buttonText || 'Watch live');
    }

    if (opts.autoStart === false) show('Watch this feeder live', 'Watch live');
    else connect();

    return {
      stop: () => stop(),
      destroy() {
        stop();
        document.removeEventListener('visibilitychange', onVisibility);
        if (objUrl) URL.revokeObjectURL(objUrl);
        el.innerHTML = '';
      },
    };
  }

  global.BirdWatchLive = { mount };
})(window);
