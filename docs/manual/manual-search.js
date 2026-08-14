// Global keyword search across the multi-page manual.
// Builds an in-memory index by fetching each part page once (lazily, on first use),
// so results always reflect the live content — there is no prebuilt index to regenerate.
// Vanilla JS, no dependencies. Loaded on every manual page after manual.js.
(function () {
    'use strict';

    // Same-origin sibling pages to index (the landing index.html is a TOC, so it's excluded).
    var PAGES = [
        'quick-start.html',
        'part-1-introduction.html',
        'part-2-camera-hardware.html',
        'part-3-installation.html',
        'part-4-first-time-setup.html',
        'part-5-configuration.html',
        'part-6-daily-use.html',
        'part-7-troubleshooting.html',
        'part-8-advanced.html'
    ];

    var index = null;     // array of section records once built
    var building = null;  // in-flight build promise (dedupes concurrent triggers)

    function textOf(el) {
        return (el ? el.textContent : '').replace(/\s+/g, ' ').trim();
    }

    // Fetch every page and split each into section records keyed by its <h2 id="...">.
    function buildIndex() {
        return Promise.all(PAGES.map(function (file) {
            return fetch(file).then(function (r) { return r.text(); }).then(function (html) {
                var doc = new DOMParser().parseFromString(html, 'text/html');
                var main = doc.querySelector('main.content');
                if (!main) return [];
                var part = textOf(doc.querySelector('.part-tag'));
                var page = textOf(main.querySelector('h1')) || file;
                var heads = Array.prototype.slice.call(main.querySelectorAll('h2[id]'));
                if (heads.length === 0) {
                    return [{ file: file, anchor: '', part: part, page: page, title: page, text: textOf(main) }];
                }
                return heads.map(function (h) {
                    var pieces = [];
                    var el = h.nextElementSibling;
                    while (el && el.tagName !== 'H2') { pieces.push(el.textContent); el = el.nextElementSibling; }
                    return {
                        file: file, anchor: h.id, part: part, page: page,
                        title: textOf(h), text: pieces.join(' ').replace(/\s+/g, ' ').trim()
                    };
                });
            }).catch(function () { return []; }); // a missing/failed page just drops out of the index
        })).then(function (chunks) {
            return chunks.reduce(function (a, c) { return a.concat(c); }, []);
        });
    }

    function ensureIndex() {
        if (index) return Promise.resolve(index);
        if (!building) building = buildIndex().then(function (recs) { index = recs; return recs; });
        return building;
    }

    function scoreRec(rec, terms) {
        var t = rec.title.toLowerCase(), x = rec.text.toLowerCase(), p = rec.page.toLowerCase(), s = 0;
        for (var i = 0; i < terms.length; i++) {
            var term = terms[i];
            if (!term) continue;
            if (t.indexOf(term) >= 0) s += 10;         // title hit weighs most
            if (p.indexOf(term) >= 0) s += 4;          // page/part title hit
            var count = x.split(term).length - 1;      // body frequency (capped)
            if (count > 0) s += Math.min(count, 5);
        }
        return s;
    }

    function escapeHtml(s) {
        return s.replace(/[&<>"]/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
        });
    }
    function escapeReg(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

    function highlight(text, terms) {
        var safe = escapeHtml(text);
        for (var i = 0; i < terms.length; i++) {
            if (!terms[i]) continue;
            safe = safe.replace(new RegExp('(' + escapeReg(escapeHtml(terms[i])) + ')', 'ig'), '<mark>$1</mark>');
        }
        return safe;
    }

    function snippet(text, terms) {
        var lc = text.toLowerCase(), pos = -1;
        for (var i = 0; i < terms.length; i++) {
            var idx = terms[i] ? lc.indexOf(terms[i]) : -1;
            if (idx >= 0 && (pos < 0 || idx < pos)) pos = idx;
        }
        if (pos < 0) return text.slice(0, 130) + (text.length > 130 ? '…' : '');
        var start = Math.max(0, pos - 45);
        var end = Math.min(text.length, start + 150);
        return (start > 0 ? '… ' : '') + text.slice(start, end) + (end < text.length ? ' …' : '');
    }

    function run() {
        var input = document.getElementById('manual-search-input');
        var box = document.getElementById('manual-search-results');
        if (!input || !box) return;
        var timer = null;

        function render(results, q) {
            if (!q) { box.hidden = true; box.innerHTML = ''; return; }
            var terms = q.toLowerCase().split(/\s+/).filter(Boolean);
            if (results.length === 0) {
                box.innerHTML = '<div class="search-empty">No matches for “' + escapeHtml(q) + '”.</div>';
                box.hidden = false;
                return;
            }
            box.innerHTML = results.map(function (r) {
                var href = r.file + (r.anchor ? '#' + r.anchor : '');
                return '<a class="search-hit" href="' + href + '">' +
                    '<span class="search-hit-part">' + escapeHtml(r.part || 'Manual') + '</span>' +
                    '<span class="search-hit-title">' + highlight(r.title, terms) + '</span>' +
                    '<span class="search-hit-snippet">' + highlight(snippet(r.text, terms), terms) + '</span>' +
                    '</a>';
            }).join('');
            box.hidden = false;
        }

        function search() {
            var q = input.value.trim();
            if (!q) { render([], ''); return; }
            var terms = q.toLowerCase().split(/\s+/).filter(Boolean);
            ensureIndex().then(function (recs) {
                if (input.value.trim() !== q) return; // a newer keystroke superseded this one
                var scored = [];
                for (var i = 0; i < recs.length; i++) {
                    var sc = scoreRec(recs[i], terms);
                    if (sc > 0) scored.push({ r: recs[i], s: sc });
                }
                scored.sort(function (a, b) { return b.s - a.s; });
                render(scored.slice(0, 12).map(function (o) { return o.r; }), q);
            });
        }

        input.addEventListener('input', function () { clearTimeout(timer); timer = setTimeout(search, 140); });
        input.addEventListener('focus', function () {
            ensureIndex();                                  // warm the index on first focus
            if (input.value.trim()) box.hidden = false;
        });
        input.addEventListener('keydown', function (e) {
            if (e.key === 'Escape') { input.value = ''; render([], ''); input.blur(); }
            else if (e.key === 'Enter') {
                var first = box.querySelector('a.search-hit');
                if (first) { e.preventDefault(); window.location.href = first.getAttribute('href'); }
            }
        });
        document.addEventListener('click', function (e) {
            if (!box.contains(e.target) && e.target !== input) box.hidden = true;
        });
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run);
    else run();
})();
