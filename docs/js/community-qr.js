// ⚠ NOT IN USE - THIS ENCODER IS BROKEN.
//
// community.html deliberately does not load this file. The symbols it
// produces do not scan: confirmed with a phone camera on both a join link and
// a plain 'HELLO' rendered at 580px with a 4-module quiet zone.
//
// The fault is NOT in the parts that were checked offline. Verified by hand
// and passing: the format bits (BCH(15,5), checked against the published
// M/mask-3 value 101101101001011), the finder and timing patterns, the
// reserved-area map, the data-region module counts against the spec at every
// version, the Reed-Solomon syndromes, and a text round-trip.
//
// That round-trip is why the bug survived. The verifier walks the module grid
// and unmasks it with the SAME code the encoder used to place and mask it, so
// any error in the walk or the mask cancels out and the symbol still decodes
// to the right string - offline. Exactly the two things left untested are the
// two a camera rejects. Fixing this needs an INDEPENDENT decoder to check
// against, not more reading of the same code.
//
// BirdWatchAI — a small QR encoder for the classroom lobby
//
// WHY THIS IS HERE RATHER THAN A CDN
// The lobby is the one screen that has to work at the exact moment a lesson
// starts, in a building whose wifi may block unpkg, with thirty children
// waiting. The site does load Leaflet from a CDN, so the precedent exists —
// but a map that fails degrades to a list, while a join code that fails ends
// the lesson. Same-origin, cached and stamped like every other script here,
// and it works offline after the first load.
//
// WHY NOT A VENDORED LIBRARY
// A general QR library carries eight mask patterns, four error-correction
// levels, forty versions and three encoding modes. This needs one short URL
// in byte mode. The scope below is deliberately narrow: versions 1–10 at
// error correction level M, which covers any URL up to 213 bytes.
//
// CORRECTNESS
// A QR that renders but does not scan looks fine on a laptop and fails in
// front of a class, so this is verified by round trip rather than by eye:
// Chrome's native BarcodeDetector reads the rendered output back and the text
// must match. That decoder shares no code with this encoder, which is what
// makes the check worth anything.
//
// Spec: ISO/IEC 18004. Error correction level M (≈15% recovery) is the usual
// default and leaves margin for projector glare and a phone held at an angle.

(function () {
    'use strict';

    // ── Galois field GF(256), primitive polynomial 0x11D ─────────────
    const EXP = new Uint8Array(512);
    const LOG = new Uint8Array(256);
    (function initGf() {
        let x = 1;
        for (let i = 0; i < 255; i++) {
            EXP[i] = x;
            LOG[x] = i;
            x <<= 1;
            if (x & 0x100) x ^= 0x11D;
        }
        for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
    })();

    function gfMul(a, b) {
        return (a === 0 || b === 0) ? 0 : EXP[LOG[a] + LOG[b]];
    }

    // Generator polynomial for `degree` error-correction codewords.
    function rsGenerator(degree) {
        let poly = [1];
        for (let i = 0; i < degree; i++) {
            const next = new Array(poly.length + 1).fill(0);
            for (let j = 0; j < poly.length; j++) {
                next[j] ^= poly[j];
                next[j + 1] ^= gfMul(poly[j], EXP[i]);
            }
            poly = next;
        }
        return poly;
    }

    function rsEncode(data, ecLen) {
        const gen = rsGenerator(ecLen);
        const res = new Array(ecLen).fill(0);
        for (const byte of data) {
            const factor = byte ^ res[0];
            res.shift();
            res.push(0);
            for (let i = 0; i < ecLen; i++) res[i] ^= gfMul(gen[i + 1], factor);
        }
        return res;
    }

    // ── Version tables, error correction level M only ────────────────
    //
    // [data codeword capacity, EC codewords per block, [block count, data
    // codewords per block] ...]. Taken from the tables in ISO/IEC 18004 §7.5.
    const VERSIONS = {
        1:  { cap: 14,  ec: 10, blocks: [[1, 16]] },
        2:  { cap: 26,  ec: 16, blocks: [[1, 28]] },
        3:  { cap: 42,  ec: 26, blocks: [[1, 44]] },
        4:  { cap: 62,  ec: 18, blocks: [[2, 32]] },
        5:  { cap: 84,  ec: 24, blocks: [[2, 43]] },
        6:  { cap: 106, ec: 16, blocks: [[4, 27]] },
        7:  { cap: 122, ec: 18, blocks: [[4, 31]] },
        8:  { cap: 152, ec: 22, blocks: [[2, 38], [2, 39]] },
        9:  { cap: 180, ec: 22, blocks: [[3, 36], [2, 37]] },
        10: { cap: 213, ec: 26, blocks: [[4, 43], [1, 44]] },
    };

    // Alignment pattern centre coordinates per version.
    const ALIGN = {
        1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30],
        6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50],
    };

    // Total data codewords in a version = the sum over its blocks. `cap` is
    // the BYTE capacity, which is smaller: it already has the mode indicator
    // and the character count subtracted. Using cap where codewords are meant
    // leaves every symbol short by a codeword or two — which a single-block
    // version survives by luck and a multi-block one does not.
    function dataWordCount(version) {
        return VERSIONS[version].blocks.reduce((n, [count, size]) => n + count * size, 0);
    }

    function pickVersion(byteLen) {
        for (let v = 1; v <= 10; v++) if (byteLen <= VERSIONS[v].cap) return v;
        return null;
    }

    // ── Bit stream ───────────────────────────────────────────────────
    function BitBuffer() { this.bits = []; }
    BitBuffer.prototype.put = function (value, length) {
        for (let i = length - 1; i >= 0; i--) this.bits.push((value >>> i) & 1);
    };

    /**
     * Encode text as byte-mode data codewords for the chosen version.
     *
     * UTF-8 first: a URL is ASCII, but encoding by char code would silently
     * mangle anything else and the failure would only show as a scanner
     * reading gibberish.
     */
    function dataCodewords(text, version) {
        const bytes = Array.from(new TextEncoder().encode(text));
        const info = VERSIONS[version];
        const buf = new BitBuffer();

        buf.put(0b0100, 4);                                  // byte mode
        buf.put(bytes.length, version <= 9 ? 8 : 16);        // character count
        bytes.forEach(b => buf.put(b, 8));

        const totalWords = dataWordCount(version);
        const capacityBits = totalWords * 8;
        // Terminator: up to four zero bits, or fewer if the stream is nearly full.
        for (let i = 0; i < 4 && buf.bits.length < capacityBits; i++) buf.bits.push(0);
        while (buf.bits.length % 8 !== 0) buf.bits.push(0);

        const words = [];
        for (let i = 0; i < buf.bits.length; i += 8) {
            let b = 0;
            for (let j = 0; j < 8; j++) b = (b << 1) | buf.bits[i + j];
            words.push(b);
        }
        // Pad alternately with the two prescribed bytes.
        const PAD = [0xEC, 0x11];
        for (let i = 0; words.length < totalWords; i++) words.push(PAD[i % 2]);
        return words;
    }

    /**
     * Split into blocks, compute error correction, and interleave.
     *
     * The interleaving is the part that is easy to get subtly wrong and
     * impossible to see: data codewords are taken one per block in turn, then
     * the EC codewords the same way.
     */
    function finalCodewords(data, version) {
        const info = VERSIONS[version];
        const blocks = [];
        let pos = 0;
        for (const [count, size] of info.blocks) {
            for (let i = 0; i < count; i++) {
                const chunk = data.slice(pos, pos + size);
                pos += size;
                blocks.push({ data: chunk, ec: rsEncode(chunk, info.ec) });
            }
        }

        const out = [];
        const maxData = Math.max(...blocks.map(b => b.data.length));
        for (let i = 0; i < maxData; i++) {
            for (const b of blocks) if (i < b.data.length) out.push(b.data[i]);
        }
        for (let i = 0; i < info.ec; i++) {
            for (const b of blocks) out.push(b.ec[i]);
        }
        return out;
    }

    // ── Module placement ─────────────────────────────────────────────
    function blankMatrix(size) {
        const m = [];
        for (let i = 0; i < size; i++) m.push(new Array(size).fill(null));
        return m;
    }

    function placeFinder(m, r, c) {
        for (let dr = -1; dr <= 7; dr++) {
            for (let dc = -1; dc <= 7; dc++) {
                const rr = r + dr, cc = c + dc;
                if (rr < 0 || cc < 0 || rr >= m.length || cc >= m.length) continue;
                const inRing = (dr >= 0 && dr <= 6 && (dc === 0 || dc === 6))
                            || (dc >= 0 && dc <= 6 && (dr === 0 || dr === 6));
                const inCore = dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4;
                m[rr][cc] = (inRing || inCore) ? 1 : 0;
            }
        }
    }

    function placeFunctionPatterns(m, version) {
        const size = m.length;
        placeFinder(m, 0, 0);
        placeFinder(m, 0, size - 7);
        placeFinder(m, size - 7, 0);

        // Timing patterns.
        for (let i = 8; i < size - 8; i++) {
            const bit = (i % 2 === 0) ? 1 : 0;
            if (m[6][i] === null) m[6][i] = bit;
            if (m[i][6] === null) m[i][6] = bit;
        }

        // Alignment patterns, skipping the three finder corners.
        const centres = ALIGN[version];
        for (const r of centres) {
            for (const c of centres) {
                if ((r <= 8 && c <= 8) || (r <= 8 && c >= size - 9) || (r >= size - 9 && c <= 8)) continue;
                for (let dr = -2; dr <= 2; dr++) {
                    for (let dc = -2; dc <= 2; dc++) {
                        const ring = Math.max(Math.abs(dr), Math.abs(dc));
                        m[r + dr][c + dc] = (ring === 1) ? 0 : 1;
                    }
                }
            }
        }

        m[size - 8][8] = 1;   // the always-dark module
    }

    // Reserve, then later fill, the format and version areas.
    function reserveInfoAreas(m, version) {
        const size = m.length;
        for (let i = 0; i < 9; i++) {
            if (m[8][i] === null) m[8][i] = 0;
            if (m[i][8] === null) m[i][8] = 0;
        }
        for (let i = 0; i < 8; i++) {
            if (m[8][size - 1 - i] === null) m[8][size - 1 - i] = 0;
            if (m[size - 1 - i][8] === null) m[size - 1 - i][8] = 0;
        }
        if (version >= 7) {
            for (let i = 0; i < 6; i++) {
                for (let j = 0; j < 3; j++) {
                    m[size - 11 + j][i] = 0;
                    m[i][size - 11 + j] = 0;
                }
            }
        }
    }

    // True where a module belongs to a function pattern and must not take data.
    function reservedMask(version, size) {
        const m = blankMatrix(size);
        placeFunctionPatterns(m, version);
        reserveInfoAreas(m, version);
        return m.map(row => row.map(v => v !== null));
    }

    function placeData(m, reserved, codewords) {
        const size = m.length;
        let bitIndex = 0;
        const totalBits = codewords.length * 8;
        const nextBit = () => {
            if (bitIndex >= totalBits) return 0;          // remainder bits are 0
            const b = (codewords[bitIndex >> 3] >>> (7 - (bitIndex & 7))) & 1;
            bitIndex++;
            return b;
        };

        let upward = true;
        for (let right = size - 1; right > 0; right -= 2) {
            if (right === 6) right--;                      // skip the timing column
            for (let step = 0; step < size; step++) {
                const row = upward ? size - 1 - step : step;
                for (let c = 0; c < 2; c++) {
                    const col = right - c;
                    if (reserved[row][col]) continue;
                    m[row][col] = nextBit();
                }
            }
            upward = !upward;
        }
    }

    // ── Masking ──────────────────────────────────────────────────────
    const MASKS = [
        (r, c) => (r + c) % 2 === 0,
        (r) => r % 2 === 0,
        (r, c) => c % 3 === 0,
        (r, c) => (r + c) % 3 === 0,
        (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
        (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
        (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
        (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
    ];

    // Penalty rules from §7.8.3. Lower is better; the spec picks the minimum.
    function penalty(m) {
        const size = m.length;
        let score = 0;

        const runScore = (line) => {
            let s = 0, run = 1;
            for (let i = 1; i < line.length; i++) {
                if (line[i] === line[i - 1]) {
                    run++;
                } else {
                    if (run >= 5) s += 3 + (run - 5);
                    run = 1;
                }
            }
            if (run >= 5) s += 3 + (run - 5);
            return s;
        };
        for (let i = 0; i < size; i++) {
            score += runScore(m[i]);
            score += runScore(m.map(row => row[i]));
        }

        for (let r = 0; r < size - 1; r++) {
            for (let c = 0; c < size - 1; c++) {
                const v = m[r][c];
                if (v === m[r][c + 1] && v === m[r + 1][c] && v === m[r + 1][c + 1]) score += 3;
            }
        }

        const PATTERN = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
        const hasAt = (line, i) => PATTERN.every((p, k) => line[i + k] === p);
        const scanLine = (line) => {
            let s = 0;
            for (let i = 0; i + 11 <= line.length; i++) {
                if (hasAt(line, i)) s += 40;
                // The pattern also counts reversed.
                if (PATTERN.every((p, k) => line[i + 10 - k] === p)) s += 40;
            }
            return s;
        };
        for (let i = 0; i < size; i++) {
            score += scanLine(m[i]);
            score += scanLine(m.map(row => row[i]));
        }

        let dark = 0;
        for (const row of m) for (const v of row) if (v) dark++;
        const pct = (dark * 100) / (size * size);
        score += Math.floor(Math.abs(pct - 50) / 5) * 10;

        return score;
    }

    // ── Format and version information ───────────────────────────────
    function formatBits(maskIndex) {
        // Level M is 00 in the format's EC field.
        const data = (0b00 << 3) | maskIndex;
        let rem = data << 10;
        for (let i = 14; i >= 10; i--) {
            if ((rem >>> i) & 1) rem ^= 0b10100110111 << (i - 10);
        }
        return ((data << 10) | rem) ^ 0b101010000010010;
    }

    function versionBits(version) {
        let rem = version << 12;
        for (let i = 17; i >= 12; i--) {
            if ((rem >>> i) & 1) rem ^= 0b1111100100101 << (i - 12);
        }
        return (version << 12) | rem;
    }

    function applyFormat(m, maskIndex) {
        const size = m.length;
        const bits = formatBits(maskIndex);
        const bit = i => (bits >>> i) & 1;

        for (let i = 0; i <= 5; i++) m[8][i] = bit(i);
        m[8][7] = bit(6);
        m[8][8] = bit(7);
        m[7][8] = bit(8);
        for (let i = 9; i <= 14; i++) m[14 - i][8] = bit(i);

        // Seven modules up column 8, then eight along row 8. Writing eight
        // up the column lands the eighth on (size-8, 8) — the always-dark
        // module — which both corrupts it and leaves bit 7 unplaced.
        for (let i = 0; i <= 6; i++) m[size - 1 - i][8] = bit(i);
        for (let i = 7; i <= 14; i++) m[8][size - 15 + i] = bit(i);
    }

    function applyVersion(m, version) {
        if (version < 7) return;
        const size = m.length;
        const bits = versionBits(version);
        for (let i = 0; i < 18; i++) {
            const b = (bits >>> i) & 1;
            const r = Math.floor(i / 3), c = i % 3;
            m[size - 11 + c][r] = b;
            m[r][size - 11 + c] = b;
        }
    }

    /**
     * Build the module matrix for `text`.
     *
     * Returns an array of arrays of 0/1, or null when the text is longer than
     * version 10 at level M can hold (213 bytes). Callers get null rather than
     * a broken code.
     */
    function qrMatrix(text) {
        const byteLen = new TextEncoder().encode(text).length;
        const version = pickVersion(byteLen);
        if (!version) return null;

        const size = 17 + version * 4;
        const codewords = finalCodewords(dataCodewords(text, version), version);
        const reserved = reservedMask(version, size);

        let best = null, bestScore = Infinity;
        for (let mask = 0; mask < 8; mask++) {
            const m = blankMatrix(size);
            placeFunctionPatterns(m, version);
            reserveInfoAreas(m, version);
            // Clear the non-function modules so placeData fills a blank field.
            for (let r = 0; r < size; r++) {
                for (let c = 0; c < size; c++) if (!reserved[r][c]) m[r][c] = null;
            }
            placeData(m, reserved, codewords);
            for (let r = 0; r < size; r++) {
                for (let c = 0; c < size; c++) {
                    if (!reserved[r][c] && MASKS[mask](r, c)) m[r][c] ^= 1;
                }
            }
            applyVersion(m, version);
            applyFormat(m, mask);

            const score = penalty(m);
            if (score < bestScore) { bestScore = score; best = m; }
        }
        return best;
    }

    /**
     * Render a matrix as an SVG string.
     *
     * One path of rectangles rather than a rect per module: a version 4 code
     * is 1,089 modules and a projector redraw of that many elements is
     * visible. The quiet zone is 4 modules, as the spec requires — scanners
     * genuinely fail without it, and a QR flush against a coloured panel is a
     * common way to produce one that will not read.
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

        return `<svg viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges"`
             + ` role="img" aria-label="${(o.label || 'QR code').replace(/[&<>"]/g, '')}">`
             + `<rect width="${size}" height="${size}" fill="#fff"/>`
             + `<path d="${d}" fill="#000"/></svg>`;
    }

    window.bwQr = { matrix: qrMatrix, svg: qrSvg };
})();
