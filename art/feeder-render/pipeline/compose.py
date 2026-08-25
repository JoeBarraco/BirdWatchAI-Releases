"""Composite the rendered feeder onto the existing garden plate."""
import os, sys
import numpy as np
from PIL import Image, ImageFilter
from scipy import ndimage

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import shade

SRC = r'C:\Users\jbarraco\Downloads\AI render of bird feeder.png'

# where the OLD feeder sits in the source art, in normalised coords (post excluded)
OLD_RECTS = [
    (0.170, 0.095, 0.995, 0.295),   # roof
    (0.395, 0.235, 0.915, 0.790),   # body
    (0.210, 0.635, 0.820, 0.965),   # tray
]


def gblur(a, r):
    if r < 0.4:
        return a
    return np.asarray(Image.fromarray((np.clip(a, 0, 1) * 255).astype(np.uint8))
                      .filter(ImageFilter.GaussianBlur(r)), float) / 255.0


def inpaint(a, hole, iters=1400):
    s = max(64, a.shape[0] // 4)
    small = np.asarray(Image.fromarray((a * 255).astype(np.uint8)).resize((s, s), Image.BOX), float) / 255
    hs = np.asarray(Image.fromarray((hole * 255).astype(np.uint8)).resize((s, s), Image.BOX), float) / 255 > 0.35
    if not hs.any():
        return a
    f = small.copy()
    f[hs] = small[~hs].mean(0)
    for _ in range(iters):
        nb = (np.roll(f, 1, 0) + np.roll(f, -1, 0) + np.roll(f, 1, 1) + np.roll(f, -1, 1)) / 4
        f[hs] = nb[hs]
    up = np.asarray(Image.fromarray((np.clip(f, 0, 1) * 255).astype(np.uint8))
                    .resize(a.shape[1::-1], Image.BICUBIC), float) / 255
    up = gblur(up, a.shape[0] / 150)
    hb = gblur(hole, a.shape[0] / 180)[..., None]
    return a * (1 - hb) + up * hb


def rebuild_post(src, W):
    """The artwork's post is only clean above the old roof; mirror-tile that slice
    down the whole frame so it runs unbroken behind the new feeder."""
    top = src[int(W * 0.008):int(W * 0.088)]                 # clean slice
    prof = top.mean(0)
    red = prof[:, 0] - prof[:, 1]
    cand = red > 0.055
    lab, n = ndimage.label(cand)
    if not n:
        return None, None
    sizes = ndimage.sum(cand, lab, range(1, n + 1))
    run = np.nonzero(lab == int(np.argmax(sizes)) + 1)[0]
    x0, x1 = run[0], run[-1] + 1
    strip = top[:, x0:x1]
    reps = int(np.ceil(W / strip.shape[0])) + 1
    tiles = []
    for i in range(reps):
        tiles.append(strip[::-1] if i % 2 else strip)
    col = np.vstack(tiles)[:W]
    band = np.zeros((W, W, 3))
    band[:, x0:x1] = col
    prof_m = np.zeros(W)
    prof_m[x0:x1] = 1.0
    m = np.repeat(prof_m[None, :], W, 0)
    m = gblur(m, W / 260)                                    # soft, defocused edges
    return band, m


def main(out_name='feeder-render.png', with_bird=False):
    col, solid, depth, mat, W, SS = shade.shade()
    rgb = shade.tonemap(col) ** (1 / 2.2)
    alpha = solid.astype(float)

    def down(x):
        im = Image.fromarray((np.clip(x, 0, 1) * 255).astype(np.uint8))
        return np.asarray(im.resize((W, W), Image.LANCZOS), float) / 255
    pm = down(rgb * alpha[..., None])
    al = down(np.repeat(alpha[..., None], 3, 2))[..., 0]
    fg = np.where(al[..., None] > 1e-4, pm / np.maximum(al[..., None], 1e-4), 0)

    src = np.asarray(Image.open(SRC).convert('RGB').resize((W, W), Image.LANCZOS), float) / 255
    bg = src.copy()

    yy, xx = np.mgrid[0:W, 0:W] / (W - 1.0)
    old = np.zeros((W, W), bool)
    for x0, y0, x1, y1 in OLD_RECTS:
        old |= (xx >= x0) & (xx <= x1) & (yy >= y0) & (yy <= y1)
    newm = ndimage.binary_dilation(al > 0.02,
                                   ndimage.iterate_structure(np.ones((3, 3), bool), max(2, W // 150)))

    band, bm = rebuild_post(src, W)
    if band is not None:
        bg = bg * (1 - bm[..., None]) + gblur(band, W / 400) * bm[..., None]
        old &= ~(bm > 0.5)

    bg = inpaint(bg, (old & ~newm).astype(float))

    # cast shadow onto whatever sits behind the feeder (mostly the post)
    if band is not None:
        sh = al.copy()
        dx, dy = int(W * 0.030), int(W * 0.026)
        sh = np.roll(np.roll(sh, dy, axis=0), dx, axis=1)
        sh = gblur(sh, W / 90)
        sh = np.clip(sh - al, 0, 1) * bm
        bg = bg * (1 - 0.42 * sh[..., None])

    out = bg * (1 - al[..., None]) + fg * al[..., None]

    if with_bird:
        out = paste_bird(out, al, W)

    # keep the artwork's rounded frame
    b = int(round(W * 0.020))
    fr = np.zeros((W, W))
    fr[:b, :] = fr[-b:, :] = fr[:, :b] = fr[:, -b:] = 1
    r = int(round(W * 0.055))
    cy, cx = np.mgrid[0:W, 0:W]
    for (oy, ox) in ((r, r), (r, W - 1 - r), (W - 1 - r, r), (W - 1 - r, W - 1 - r)):
        d = np.hypot(cy - oy, cx - ox)
        corner = (((cy < r) | (cy > W - 1 - r)) & ((cx < r) | (cx > W - 1 - r)))
        fr[corner & (d > r - b)] = 1
    fr = gblur(fr, 1.2)[..., None]
    out = out * (1 - fr) + src * fr

    # a whisper of grain so the CG element shares the plate's texture
    g = np.random.default_rng(21).normal(0, 1, (W, W, 1)) * 0.0085
    out = np.clip(out + g * (1 - fr), 0, 1)

    Image.fromarray((np.clip(out, 0, 1) * 255).astype(np.uint8)).save(os.path.join(HERE, out_name))
    print('wrote', out_name, W)


def paste_bird(out, al, W):
    import bird
    a, ba = bird.cut()
    ba = ba.copy()
    h0, w0 = ba.shape
    scale = W * 0.430 / w0
    nw, nh = int(w0 * scale), int(h0 * scale)
    rgba = np.dstack([a, ba])
    rr = np.asarray(Image.fromarray((rgba * 255).astype(np.uint8)).resize((nw, nh), Image.LANCZOS),
                    float) / 255
    bx, by = int(W * 0.150), int(W * 0.578)
    sl = (slice(by, by + nh), slice(bx, bx + nw))
    a3 = rr[..., :3]; aa = rr[..., 3:4]
    out[sl] = out[sl] * (1 - aa) + a3 * aa
    return out


if __name__ == '__main__':
    name = sys.argv[1] if len(sys.argv) > 1 else 'feeder-render.png'
    main(name, with_bird='--bird' in sys.argv)
