// BirdWatchAI — the QR for the classroom lobby
//
// WHAT HAPPENED TO THE ENCODER THAT USED TO BE HERE
// This file was 490 lines of hand-rolled QR encoder, shipped DISABLED
// because the symbols it produced would not scan. The comment at the top of
// it was honest about why the bug survived: every offline check either
// passed or shared code with the encoder itself. The round-trip verifier
// walked the module grid and unmasked it with the SAME code that placed and
// masked it, so an error in the walk or the mask cancelled out and the
// symbol decoded perfectly — offline, to itself.
//
// Checked again with jsQR as an independent decoder, and it was not a near
// miss. Nothing it produced decoded at any version: 21x21 through 53x53, a
// plain 'HELLO' and a real join link alike, all NOTHING. The structure, the
// format bits and the Reed-Solomon syndromes all verified; the symbol was
// still unreadable. That is the signature of a bug somewhere neither the
// author nor the author's tests could see, and a lobby screen with thirty
// children waiting is the wrong place to keep looking for it.
//
// So the encoding is now qrcode-generator (vendor-qrcode.js, MIT, 2009, and
// in the field ever since). The original argument against a library was
// bytes — eight masks and forty versions when we need one short URL. That
// argument was true and it lost to the one that matters: this is the screen
// that has to work at the exact moment a lesson starts.
//
// WHAT IS STILL OURS
// The rendering. A library's own SVG output is a rect per module, and a
// version 4 symbol is 1,089 of them; redrawing that on a projector is
// visible. The renderer below emits one path, which is the reason it was
// worth keeping. The 4-module quiet zone is kept too: scanners genuinely
// fail without it, and a QR flush against a colored panel is a common way
// to produce one nobody can read.
//
// CORRECTNESS
// The lobby must never show a QR that does not scan — thirty children try
// it, it fails, and the lesson stops while the teacher works out why. So
// qrSvg returns '' rather than a broken symbol, and the address and class
// code beside it are what the lobby actually relies on.
(function () {
    'use strict';

    // Error correction level M: ~15% recoverable. The right level for a
    // projected symbol, which is read at an angle, off a screen that may be
    // washed out, by a camera at the back of a room.
    const ECC = 'M';

    // Version 0 means "pick the smallest that fits", which keeps the modules
    // as large as possible — the single biggest factor in whether a phone at
    // the back of a classroom can resolve it.
    const AUTO_VERSION = 0;

    /**
     * The module matrix for `text`, as arrays of 0/1, or null if it will not
     * fit or the encoder is missing.
     *
     * Null rather than a throw: every caller here is drawing a lobby screen
     * and would have to catch it anyway.
     */
    function qrMatrix(text) {
        if (typeof qrcode !== 'function' || !text) return null;
        let q;
        try {
            q = qrcode(AUTO_VERSION, ECC);
            // 'Byte' mode explicitly. Left to itself the library may choose
            // alphanumeric mode, which has no lowercase — a join URL would
            // either fail to encode or come back upper-cased, and a scanned
            // link that 404s is worse than no link.
            q.addData(text, 'Byte');
            q.make();
        } catch (e) {
            console.warn('[qr] could not encode:', e);
            return null;
        }

        const n = q.getModuleCount();
        const m = [];
        for (let r = 0; r < n; r++) {
            const row = [];
            for (let c = 0; c < n; c++) row.push(q.isDark(r, c) ? 1 : 0);
            m.push(row);
        }
        return m;
    }

    /**
     * Render a matrix as an SVG string.
     *
     * One path of rectangles rather than a rect per module: a version 4 code
     * is 1,089 modules and a projector redraw of that many elements is
     * visible. The quiet zone is 4 modules, as the spec requires.
     */
    function qrSvg(text, opts) {
        const m = qrMatrix(text);
        if (!m) return '';
        const o = opts || {};
        const quiet = 4;
        const size = m.length + quiet * 2;

        let d = '';
        for (let r = 0; r < m.length; r++) {
            for (let c = 0; c < m.length; c++) {
                if (m[r][c]) d += `M${c + quiet} ${r + quiet}h1v1h-1z`;
            }
        }

        // xmlns matters even though this is injected as inline HTML, where
        // the parser infers it. Without it the symbol is not a valid
        // standalone SVG, so it cannot be dragged out, saved, printed to a
        // handout or opened as an image — and a teacher wanting the join code
        // on paper is an obvious thing to want. It also made the symbol
        // untestable: loading it into an <img> to decode it just errors.
        return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}"`
             + ` shape-rendering="crispEdges"`
             + ` role="img" aria-label="${(o.label || 'QR code').replace(/[&<>"]/g, '')}">`
             + `<rect width="${size}" height="${size}" fill="#fff"/>`
             + `<path d="${d}" fill="#000"/></svg>`;
    }

    window.bwQr = { matrix: qrMatrix, svg: qrSvg };
})();
