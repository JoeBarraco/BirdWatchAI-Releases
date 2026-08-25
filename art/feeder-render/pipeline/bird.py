"""Cut the robin (plus the seed immediately under it) out of the source artwork."""
import os
import numpy as np
from PIL import Image, ImageFilter
from scipy import ndimage

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = r'C:\Users\jbarraco\Downloads\AI render of bird feeder.png'
BOX = (236, 596, 436, 716)          # in the 910x909 source


def cut():
    im = Image.open(SRC).convert('RGB').crop(BOX)
    a = np.asarray(im, float) / 255.0
    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    v = a.max(2)
    mn = a.min(2)
    sat = (v - mn) / np.maximum(v, 1e-6)

    tray = v < 0.235                                   # near-black perforated tray
    foliage = (g > r + 0.015) & (g > b + 0.03) & (v < 0.72)
    # the enclosure behind the bird is smooth and desaturated; feathers never are
    mean = ndimage.uniform_filter(v, 5)
    var = np.maximum(ndimage.uniform_filter(v * v, 5) - mean * mean, 0)
    smooth = np.sqrt(var) < 0.014
    body = (v > 0.76) & (sat < 0.13)
    body |= (v > 0.55) & (sat < 0.20) & smooth
    # dark stub of the old enclosure's black band, just above the crown
    hh, ww = v.shape
    yy0, xx0 = np.mgrid[0:hh, 0:ww]
    upper_right = (xx0 / ww > 0.74) & (yy0 / hh < 0.30)
    body |= upper_right & (v < 0.44)
    fg = ~(tray | foliage | body)

    fg = ndimage.binary_opening(fg, np.ones((3, 3), bool))
    fg = ndimage.binary_closing(fg, np.ones((7, 7), bool))
    fg = ndimage.binary_fill_holes(fg)
    lab, n = ndimage.label(fg)
    if n:
        sizes = ndimage.sum(fg, lab, range(1, n + 1))
        fg = lab == int(np.argmax(sizes)) + 1
    fg = ndimage.binary_erosion(fg, np.ones((3, 3), bool), iterations=2)
    # soft elliptical trim: drops the stray corner patches the colour rules keep
    h, w = fg.shape
    yy, xx = np.mgrid[0:h, 0:w]
    e = np.hypot((xx - w * 0.50) / (w * 0.525), (yy - h * 0.505) / (h * 0.545))
    ell = np.clip((1.06 - e) / 0.10, 0, 1)
    alpha = np.asarray(Image.fromarray((fg * 255).astype(np.uint8))
                       .filter(ImageFilter.GaussianBlur(1.3)), float) / 255.0
    return a, np.clip(alpha * ell, 0, 1)


if __name__ == '__main__':
    a, al = cut()
    out = np.dstack([a, al])
    Image.fromarray((out * 255).astype(np.uint8)).save(os.path.join(HERE, 'bird.png'))
    chk = np.dstack([a * al[..., None] + (1 - al[..., None]) * np.array([0.15, 0.55, 0.25]), np.ones_like(al)])
    Image.fromarray((chk * 255).astype(np.uint8)).resize((a.shape[1] * 3, a.shape[0] * 3), Image.NEAREST) \
        .save(os.path.join(HERE, 'bird_check.png'))
    print('bird cut', a.shape, 'coverage %.2f' % al.mean())
