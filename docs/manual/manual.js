// Minimal companion JS for the user manual.
// - Mobile TOC toggle
// - Auto-highlight the current Part in the sidebar based on <body data-part="...">
// - Theme sync with the rest of the site (localStorage key: bwai-theme)

(function () {
    // Apply saved theme before paint (also done inline in <head> on each page)
    try {
        var t = localStorage.getItem('bwai-theme');
        if (t) document.documentElement.setAttribute('data-theme', t);
    } catch (e) { /* localStorage unavailable */ }

    document.addEventListener('DOMContentLoaded', function () {
        // Mobile TOC toggle
        var toggle = document.querySelector('.menu-toggle');
        if (toggle) {
            toggle.addEventListener('click', function () {
                document.body.classList.toggle('toc-open');
            });
        }
        // Tap the backdrop to close
        document.addEventListener('click', function (e) {
            if (!document.body.classList.contains('toc-open')) return;
            var toc = document.querySelector('.toc');
            var tgl = document.querySelector('.menu-toggle');
            if (!toc.contains(e.target) && e.target !== tgl) {
                document.body.classList.remove('toc-open');
            }
        });

        // Highlight current Part in the sidebar
        var part = document.body.getAttribute('data-part');
        if (part) {
            var match = document.querySelector('.toc li[data-part="' + part + '"]');
            if (match) match.classList.add('current');
        }

        // Theme toggle button (top bar)
        var themeBtn = document.querySelector('#manual-theme-toggle');
        if (themeBtn) {
            themeBtn.addEventListener('click', function () {
                var cur = document.documentElement.getAttribute('data-theme');
                var next = cur === 'dark' ? 'light' : 'dark';
                document.documentElement.setAttribute('data-theme', next);
                try { localStorage.setItem('bwai-theme', next); } catch (e) {}
            });
        }
    });
})();
