// ── Snapshot caption re-burn ─────────────────────────────────────────────────
//
// A moderator correcting a detection's species or rarity leaves the photo itself
// lying: the caption strip is burned into the JPEG at detection time, so the
// bottom-left block still reads the old name. The server build already solves
// this on its History page — SnapshotRewriteService re-burns the file in place —
// and this is the browser-side twin of that pass, so a correction made on the
// community site produces the same corrected photo.
//
// Geometry is a deliberate line-for-line port of SkiaSnapshotOverlayService in
// the server repo (EraseBottomStripArea + DrawBottomStrip). If you change one,
// change the other, or moderated photos will drift out of alignment with freshly
// detected ones. The two passes it does NOT port are the corner watermark and
// the centered TRIAL stamp: neither lives inside the erased region, so both
// survive the re-burn untouched and need no redraw.
//
// Everything here is pure canvas work — no network writes. The upload lives in
// the moderator-delete-media edge function, which holds the service-role key.

(function () {
    'use strict';

    // The site renders every detection time in ET (see fmtDetectedAt in
    // community-core.js), and the strip has to agree with the card it sits on,
    // so the re-burn formats in the same zone rather than the moderator's. A
    // feeder outside ET gets a shifted time on the re-burned photo; fixing that
    // properly needs the feeder's UTC offset carried on the row, which the
    // server does not send today.
    const FEEDER_TZ    = 'America/New_York';
    const ERASE_FRINGE = 6;     // matches the Skia constant: wipes AA fringes
    const JPEG_QUALITY = 0.9;   // matches Skia's Encode(Jpeg, 90)

    const FONT_STACK = '"Segoe UI", system-ui, -apple-system, "Helvetica Neue", Arial, sans-serif';

    function clamp(v, lo, hi) {
        return Math.min(hi, Math.max(lo, v));
    }

    // Every size in the strip scales off image height so thumbnails and 4K
    // snapshots both read well. Same clamps as the Skia renderer.
    function stripMetrics(height) {
        const padding = clamp(height * 0.020, 8, 24);
        return {
            titleSize: clamp(height * 0.045, 16, 42),
            metaSize:  clamp(height * 0.030, 12, 28),
            padding:   padding,
            lineGap:   padding * 0.4,
        };
    }

    // Community rows store title-case rarity ("Very Rare"); the burned strip
    // uses the server's sentence-case form ("Very rare"). Normalise both the
    // community spelling and the server's slug so either shape lands right.
    function rarityDisplay(rarity) {
        const key = String(rarity || '').trim().toLowerCase().replace(/[\s_]+/g, '-');
        switch (key) {
            case 'common':    return 'Common';
            case 'uncommon':  return 'Uncommon';
            case 'rare':      return 'Rare';
            case 'very-rare': return 'Very rare';
            default:          return rarity || '';
        }
    }

    // "Jun 28, 3:04 PM" — the en-US rendering of the server's "MMM d, h:mm tt".
    function fmtStripTime(iso) {
        const t = new Date(iso);
        if (isNaN(t.getTime())) return '';
        return t.toLocaleString('en-US', {
            timeZone: FEEDER_TZ,
            month: 'short', day: 'numeric',
            hour: 'numeric', minute: '2-digit',
        });
    }

    // Meta line, left to right: confidence · timestamp · temperature · rarity.
    //
    // The server gates each field behind a per-feeder overlay toggle
    // (OverlayShowConfidence and friends). Those settings never reach the
    // community, so a feeder that had one switched off gets a slightly richer
    // strip after moderation — which is why the modal shows a preview before
    // anything is written.
    function metaLine(d) {
        const parts = [];

        if (d.confidence != null && isFinite(d.confidence)) {
            // Shared rows carry 0..100. A value at or under 1 can only be a
            // fraction from some older writer — no real identification lands
            // under 1%.
            const pct = d.confidence <= 1 ? d.confidence * 100 : d.confidence;
            parts.push(pct.toFixed(1) + '%');
        }
        if (d.detected_at) {
            const stamp = fmtStripTime(d.detected_at);
            if (stamp) parts.push(stamp);
        }
        if (d.temperature != null && isFinite(d.temperature)) {
            // Community rows are always °F. A feeder configured for °C burned
            // Celsius originally and will come back Fahrenheit; the row carries
            // no unit to tell us otherwise.
            parts.push(Math.round(d.temperature) + '°F');
        }
        const rarity = rarityDisplay(d.rarity);
        if (rarity) parts.push(rarity);

        return parts.join('  ·  ');
    }

    // Opaque black over the worst-case strip area (both lines present, full
    // padding) plus the fringe, so a longer old species name can't peek out
    // from under a shorter new strip.
    function eraseStripArea(ctx, width, height) {
        const m = stripMetrics(height);
        const maxContent = m.titleSize + m.lineGap + m.metaSize;
        const maxStrip   = maxContent + m.padding * 2;
        const top        = Math.max(0, height - maxStrip - ERASE_FRINGE);

        ctx.save();
        ctx.fillStyle = '#000';
        ctx.fillRect(0, top, width, height - top);
        ctx.restore();
    }

    function drawBottomStrip(ctx, width, height, d) {
        const title = (d.species || '').trim();
        const meta  = metaLine(d);
        const hasTitle = title.length > 0;
        const hasMeta  = meta.length > 0;
        if (!hasTitle && !hasMeta) return;

        const m = stripMetrics(height);
        const contentH = (hasTitle ? m.titleSize : 0)
            + (hasTitle && hasMeta ? m.lineGap : 0)
            + (hasMeta ? m.metaSize : 0);
        const stripHeight = contentH + m.padding * 2;
        const top = height - stripHeight;

        ctx.save();

        const gradient = ctx.createLinearGradient(0, top, 0, height);
        gradient.addColorStop(0, 'rgba(0,0,0,0)');
        gradient.addColorStop(1, 'rgba(0,0,0,' + (200 / 255) + ')');
        ctx.fillStyle = gradient;
        ctx.fillRect(0, top, width, stripHeight);

        // Canvas' default 'alphabetic' baseline is what SKCanvas.DrawText uses,
        // so the baseline arithmetic carries over unchanged.
        ctx.textBaseline = 'alphabetic';
        ctx.textAlign = 'left';

        let baseline = top + m.padding;
        if (hasTitle) {
            ctx.font = '700 ' + m.titleSize + 'px ' + FONT_STACK;
            ctx.fillStyle = '#ffffff';
            baseline += m.titleSize * 0.85;
            ctx.fillText(title, m.padding, baseline);
        }
        if (hasMeta) {
            ctx.font = '400 ' + m.metaSize + 'px ' + FONT_STACK;
            ctx.fillStyle = 'rgb(220,232,240)';
            baseline += hasTitle ? (m.lineGap + m.metaSize * 0.95) : (m.metaSize * 0.85);
            ctx.fillText(meta, m.padding, baseline);
        }

        ctx.restore();
    }

    // Fetch → blob → bitmap rather than <img crossOrigin>. Supabase Storage
    // does send Access-Control-Allow-Origin, but the modal's own thumbnail has
    // already cached the same URL through a non-CORS request, and reusing that
    // cache entry for a crossOrigin load is the classic way to get a canvas
    // tainted mid-flight. Going through a blob sidesteps the whole question.
    async function loadSource(url) {
        const res = await fetch(url, { mode: 'cors', credentials: 'omit' });
        if (!res.ok) throw new Error('Image fetch failed (HTTP ' + res.status + ')');
        const blob = await res.blob();

        if (typeof createImageBitmap === 'function') {
            return await createImageBitmap(blob);
        }
        // Older Safari: a blob: URL is same-origin, so this doesn't taint either.
        const objectUrl = URL.createObjectURL(blob);
        try {
            return await new Promise((resolve, reject) => {
                const img = new Image();
                img.onload  = () => resolve(img);
                img.onerror = () => reject(new Error('Image decode failed'));
                img.src = objectUrl;
            });
        } finally {
            // Revoking after decode is safe; the bitmap is already in memory.
            setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
        }
    }

    function sourceSize(source) {
        return {
            width:  source.width  || source.naturalWidth  || 0,
            height: source.height || source.naturalHeight || 0,
        };
    }

    // Draw the corrected photo at full resolution. Reuses `target` when given
    // so the modal preview can redraw on every keystroke without churning
    // canvases.
    function compose(source, detection, target) {
        const { width, height } = sourceSize(source);
        if (!width || !height) throw new Error('Source image has no dimensions');

        const canvas = target || document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;

        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, width, height);
        ctx.drawImage(source, 0, 0, width, height);
        eraseStripArea(ctx, width, height);
        drawBottomStrip(ctx, width, height, detection);
        return canvas;
    }

    function toBlob(canvas) {
        return new Promise((resolve, reject) => {
            canvas.toBlob(
                b => b ? resolve(b) : reject(new Error('Canvas encode failed')),
                'image/jpeg',
                JPEG_QUALITY
            );
        });
    }

    // Chunked so a multi-hundred-KB JPEG doesn't blow the argument limit that
    // String.fromCharCode(...bigArray) runs into.
    function base64FromBytes(bytes) {
        const CHUNK = 0x8000;
        let binary = '';
        for (let i = 0; i < bytes.length; i += CHUNK) {
            binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
        }
        return btoa(binary);
    }

    // The blob comes back alongside the base64 so the caller can hand the feed a
    // blob: URL for the corrected photo while the real one propagates — the row
    // may come back as a private:// marker, which can't go in an <img src>.
    async function encodeBase64(canvas) {
        const blob  = await toBlob(canvas);
        const bytes = new Uint8Array(await blob.arrayBuffer());
        return { base64: base64FromBytes(bytes), byteLength: bytes.length, blob: blob };
    }

    window.bwOverlay = {
        loadSource,
        compose,
        encodeBase64,
        // Exposed for the modal's "nothing to redraw" check and for tests.
        metaLine,
        rarityDisplay,
    };
})();
