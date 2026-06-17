// Interactive chart runtime for the Community Stats tabs. Mirrors the server's stats-charts.js
// (in birdwatchai-server) so a chart hover behaves the same way on www.birdwatchai.com as it does
// in the local Blazor app: vertical crosshair on the trend chart, multi-row species tooltips on
// the hour/DOW/calendar/rarity charts, and a stable color identity per species (via the existing
// speciesColor() helper in community-views.js).
//
// Markup conventions consumed:
//
//   [data-bw-chart="trend-svg"][data-trend='<json>']
//       JSON shape { xs:[…], plotTop, plotBottom, days:[…], series:[{species,color,counts,ys}] }.
//       Inside, an <svg> contains a <rect class="trend-hover"> covering the plot area.
//
//   [data-bw-chart="bars"|"bars-h"|"stacked-bars"][data-bw-buckets='<json>']
//       Bar / stacked-bar charts. Children carry data-bw-bucket="<idx>"; the buckets JSON shape is
//       [{ title: "…", rows: [{species, color, count}, …] }, …]. Falls back to data-bw-tip on
//       elements that haven't been migrated to bucket data yet.
//
//   [data-bw-chart="calendar"][data-bw-buckets='<json>']
//       Same bucket model on a calendar heatmap; <rect>/<g> children carry data-bw-bucket.
//
//   [data-bw-chart="rarity-stack"]
//       Per-segment data-bw-tip fallback only — each species sub-segment carries its own line.
//
// On every render the community-views.js code recreates the chart DOM, so this script keeps wiring
// up new roots via a MutationObserver and a WeakSet of already-wired elements.
(function () {
    'use strict';

    const wired = new WeakSet();
    let tooltipEl = null;

    function ensureTooltip() {
        if (tooltipEl && document.body.contains(tooltipEl)) return tooltipEl;
        tooltipEl = document.createElement('div');
        tooltipEl.className = 'chart-tooltip';
        tooltipEl.setAttribute('role', 'tooltip');
        document.body.appendChild(tooltipEl);
        return tooltipEl;
    }

    function showTooltip(html, clientX, clientY) {
        const t = ensureTooltip();
        t.innerHTML = html;
        t.classList.add('is-visible');

        const margin = 12;
        const w = t.offsetWidth;
        const h = t.offsetHeight;
        let x = clientX + margin;
        let y = clientY - h - margin;
        if (x + w > window.innerWidth - 4) x = clientX - w - margin;
        if (y < 4) y = clientY + margin;
        if (x < 4) x = 4;
        if (y + h > window.innerHeight - 4) y = window.innerHeight - h - 4;
        t.style.left = x + 'px';
        t.style.top = y + 'px';
    }

    function hideTooltip() {
        if (tooltipEl) tooltipEl.classList.remove('is-visible');
    }

    function escapeHtml(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function renderRowsTooltip(title, rows) {
        let html = '';
        if (title) html += `<div class="chart-tooltip-title">${escapeHtml(title)}</div>`;
        if (rows && rows.length) {
            for (const r of rows) {
                const dim = r.count === 0 ? ' is-dim' : '';
                html += `<div class="chart-tooltip-row${dim}">`
                     +    `<span class="chart-tooltip-swatch" style="background:${escapeHtml(r.color || 'transparent')}"></span>`
                     +    `<span class="chart-tooltip-species">${escapeHtml(r.species)}</span>`
                     +    `<span class="chart-tooltip-count">${r.count}</span>`
                     +  `</div>`;
            }
        }
        return html;
    }

    function parseBuckets(el) {
        const raw = el.getAttribute('data-bw-buckets');
        if (!raw) return null;
        try { return JSON.parse(raw); } catch (e) { return null; }
    }

    // =================== Trend SVG (crosshair + per-species tooltip) ===========================

    function wireTrend(wrap) {
        if (wired.has(wrap)) return;
        let data;
        try {
            data = JSON.parse(wrap.getAttribute('data-trend') || '');
        } catch (e) {
            return;
        }
        if (!data || !Array.isArray(data.xs) || data.xs.length === 0) return;
        if (!Array.isArray(data.series) || data.series.length === 0) return;

        const svg = wrap.querySelector('svg');
        const hover = wrap.querySelector('.trend-hover');
        if (!svg || !hover) return;

        const svgNs = 'http://www.w3.org/2000/svg';
        const crosshair = document.createElementNS(svgNs, 'line');
        crosshair.setAttribute('class', 'trend-crosshair');
        crosshair.setAttribute('y1', String(data.plotTop));
        crosshair.setAttribute('y2', String(data.plotBottom));
        crosshair.setAttribute('stroke', '#7a756d');
        crosshair.setAttribute('stroke-width', '1');
        crosshair.setAttribute('stroke-dasharray', '3 3');
        crosshair.setAttribute('opacity', '0.85');
        crosshair.style.display = 'none';
        crosshair.style.pointerEvents = 'none';
        svg.appendChild(crosshair);

        const dots = data.series.map(s => {
            const c = document.createElementNS(svgNs, 'circle');
            c.setAttribute('class', 'trend-dot');
            c.setAttribute('r', '5');
            c.setAttribute('fill', s.color);
            c.setAttribute('stroke', '#fff');
            c.setAttribute('stroke-width', '1.5');
            c.style.display = 'none';
            c.style.pointerEvents = 'none';
            svg.appendChild(c);
            return c;
        });

        function nearestIndex(svgX) {
            const xs = data.xs;
            let best = 0;
            let bestD = Math.abs(xs[0] - svgX);
            for (let i = 1; i < xs.length; i++) {
                const d = Math.abs(xs[i] - svgX);
                if (d < bestD) { bestD = d; best = i; }
            }
            return best;
        }

        function clientToSvgX(clientX) {
            const pt = svg.createSVGPoint();
            pt.x = clientX;
            pt.y = 0;
            const ctm = svg.getScreenCTM();
            if (ctm) {
                const m = ctm.inverse();
                return pt.matrixTransform(m).x;
            }
            const r = svg.getBoundingClientRect();
            return ((clientX - r.left) / r.width) * 700; // matches viewBox W in community-views.js
        }

        function onMove(ev) {
            const svgX = clientToSvgX(ev.clientX);
            const idx = nearestIndex(svgX);
            const xPx = data.xs[idx];

            crosshair.setAttribute('x1', String(xPx));
            crosshair.setAttribute('x2', String(xPx));
            crosshair.style.display = '';

            const rows = [];
            for (let i = 0; i < data.series.length; i++) {
                const s = data.series[i];
                const y = s.ys[idx];
                const dot = dots[i];
                dot.setAttribute('cx', String(xPx));
                dot.setAttribute('cy', String(y));
                dot.style.display = '';
                rows.push({ species: s.species, color: s.color, count: s.counts[idx] });
            }
            rows.sort((a, b) => b.count - a.count);
            showTooltip(renderRowsTooltip(data.days[idx], rows), ev.clientX, ev.clientY);
        }

        function onLeave() {
            crosshair.style.display = 'none';
            for (const d of dots) d.style.display = 'none';
            hideTooltip();
        }

        hover.addEventListener('mousemove', onMove);
        hover.addEventListener('mouseleave', onLeave);
        wired.add(wrap);
    }

    // =================== Horizontal & vertical bar charts ======================================

    function wireBars(chart, hoverChildSelector) {
        if (wired.has(chart)) return;

        const buckets = parseBuckets(chart);
        let currentBar = null;

        function setHover(el) {
            if (currentBar === el) return;
            if (currentBar) currentBar.classList.remove('is-hover');
            currentBar = el;
            if (currentBar) currentBar.classList.add('is-hover');
        }

        chart.addEventListener('mousemove', (ev) => {
            let node = ev.target;
            while (node && node !== chart && !(node.classList && node.classList.contains(hoverChildSelector))) {
                node = node.parentNode;
            }
            if (!node || node === chart) {
                setHover(null);
                hideTooltip();
                return;
            }
            setHover(node);

            const bucketIdx = node.getAttribute('data-bw-bucket');
            if (buckets && bucketIdx != null) {
                const b = buckets[+bucketIdx];
                if (b) {
                    showTooltip(renderRowsTooltip(b.title, b.rows), ev.clientX, ev.clientY);
                    return;
                }
            }
            const tip = node.getAttribute('data-bw-tip');
            if (tip) showTooltip(escapeHtml(tip), ev.clientX, ev.clientY);
        });
        chart.addEventListener('mouseleave', () => {
            setHover(null);
            hideTooltip();
        });

        wired.add(chart);
    }

    // =================== Calendar heatmap (SVG cells) ==========================================

    function wireCalendar(wrap) {
        if (wired.has(wrap)) return;

        const buckets = parseBuckets(wrap);
        const cells = wrap.querySelectorAll('[data-bw-bucket]');
        if (cells.length === 0) return;

        let currentCell = null;
        function setHover(el) {
            if (currentCell === el) return;
            if (currentCell) currentCell.classList.remove('is-hover');
            currentCell = el;
            if (currentCell) currentCell.classList.add('is-hover');
        }

        cells.forEach(cell => {
            cell.addEventListener('mousemove', (ev) => {
                setHover(cell);
                const bucketIdx = cell.getAttribute('data-bw-bucket');
                if (buckets && bucketIdx != null) {
                    const b = buckets[+bucketIdx];
                    if (b) {
                        showTooltip(renderRowsTooltip(b.title, b.rows), ev.clientX, ev.clientY);
                        return;
                    }
                }
                const tip = cell.getAttribute('data-bw-tip');
                if (tip) showTooltip(escapeHtml(tip), ev.clientX, ev.clientY);
            });
            cell.addEventListener('mouseleave', () => {
                setHover(null);
                hideTooltip();
            });
        });

        wired.add(wrap);
    }

    // =================== Wiring entry point ====================================================

    function scan() {
        document.querySelectorAll('[data-bw-chart="trend-svg"]').forEach(wireTrend);
        document.querySelectorAll('[data-bw-chart="bars-h"]').forEach(c => wireBars(c, 'bar-row'));
        document.querySelectorAll('[data-bw-chart="bars"],[data-bw-chart="stacked-bars"]').forEach(c => wireBars(c, 'bar'));
        document.querySelectorAll('[data-bw-chart="rarity-stack"]').forEach(c => wireBars(c, 'rarity-mix-seg'));
        document.querySelectorAll('[data-bw-chart="calendar"]').forEach(wireCalendar);
    }

    function scanSoon() { requestAnimationFrame(scan); }

    document.addEventListener('DOMContentLoaded', scanSoon);
    window.addEventListener('pageshow', scanSoon);

    const mo = new MutationObserver(muts => {
        for (const m of muts) {
            for (const n of m.addedNodes) {
                if (n.nodeType !== 1) continue;
                if (n.matches && n.matches('[data-bw-chart]')) { scan(); return; }
                if (n.querySelector && n.querySelector('[data-bw-chart]')) { scan(); return; }
            }
        }
    });
    mo.observe(document.documentElement, { childList: true, subtree: true });

    if (document.readyState !== 'loading') scanSoon();
})();
