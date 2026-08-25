"""Gumroad product tile for the outdoor feeder — flat illustration, R05 geometry.

Matches the rest of the product-*.jpg set: green gradient plate, pale ring, circular
scene, thick dark outlines, limited palette. Drawn at 4x and downsampled.
"""
import os
import numpy as np
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.abspath(os.path.join(HERE, '..', '..', '..', 'images', 'product-feeder-outdoor.jpg'))

S = 4                      # supersample
W = 600                    # final size

# palette lifted from the existing product-*.jpg tiles
BG_TOP = (58, 109, 73)
BG_BOT = (31, 63, 42)
RING = (169, 201, 174)
CREAM = (250, 250, 247)
SKY = (214, 236, 249)
GROUND = (199, 222, 200)
BUSH = (181, 198, 164)
INK = (31, 34, 47)
SHELL = (250, 250, 247)
SHELL_IN = (221, 228, 223)          # recessed centre panel
WOOD = (138, 105, 70)
WOOD_D = (110, 82, 54)
TRAY = (42, 47, 58)
SEED = (215, 189, 139)
SEED_D = (166, 132, 82)
GREY = (110, 120, 132)
JAY = (74, 123, 181)
JAY_L = (123, 173, 227)
JAY_W = (245, 248, 250)


def px(v):
    return int(round(v * S))


def rr(d, box, r, fill=None, outline=None, width=0):
    d.rounded_rectangle([px(box[0]), px(box[1]), px(box[2]), px(box[3])],
                        radius=px(r), fill=fill, outline=outline, width=px(width))


def ell(d, box, fill=None, outline=None, width=0):
    d.ellipse([px(box[0]), px(box[1]), px(box[2]), px(box[3])],
              fill=fill, outline=outline, width=px(width))


def poly(d, pts, fill=None, outline=None, width=0):
    p = [(px(x), px(y)) for x, y in pts]
    d.polygon(p, fill=fill, outline=outline, width=px(width) if width else 0)


def font(size, bold=True):
    path = r'C:\Windows\Fonts\arialbd.ttf' if bold else r'C:\Windows\Fonts\arial.ttf'
    return ImageFont.truetype(path, px(size))


def build():
    N = W * S
    # ---- background plate: vertical gradient -----------------------------
    g = np.linspace(0, 1, N)[:, None]
    grad = (np.array(BG_TOP) * (1 - g) + np.array(BG_BOT) * g)
    img = Image.fromarray(np.repeat(grad[:, None, :], N, axis=1).astype(np.uint8))

    # ---- the circular scene, drawn on its own layer then masked ----------
    scene = Image.new('RGB', (N, N), SKY)
    d = ImageDraw.Draw(scene)

    CX, CY = 300, 300
    R_SCENE = 231

    # sky, clouds, horizon, bushes sitting on it
    for (cx, cy, w, h) in ((156, 132, 58, 24), (194, 122, 40, 18), (448, 158, 52, 22), (416, 150, 34, 16)):
        ell(d, (cx - w, cy - h, cx + w, cy + h), fill=(240, 249, 254))
    HZ = 436
    d.rectangle([0, px(HZ), N, N], fill=GROUND)
    for (cx, cy, w, h) in ((124, HZ + 30, 96, 66), (492, HZ + 34, 104, 74), (318, HZ + 40, 120, 56)):
        ell(d, (cx - w, cy - h, cx + w, cy + h), fill=BUSH)

    # ---- post, behind the feeder ----------------------------------------
    rr(d, (402, 96, 444, 512), 3, fill=WOOD, outline=INK, width=3.2)
    for x in (411, 419, 428, 436):
        d.line([px(x), px(102), px(x), px(506)], fill=WOOD_D, width=px(1.5))

    # ---- feeder: flat front elevation of R05, to scale --------------------
    # k px per mm; z0 is the image y of the part's z=0 (bottom of the tray)
    k, z0, cx = 1.56, 428.0, 298.0

    def X(mm):
        return cx + mm * k

    def Y(mm_z):
        return z0 - mm_z * k

    # body: 160 wide (x -83.8..76.2 about the bore axis at -3.8), z 0..150
    rr(d, (X(-80.0), Y(150), X(72.4), Y(0)), 6, fill=SHELL, outline=INK, width=3.4)
    # recessed centre face between the two side pillars (inner walls at -59 / +51.4)
    d.rectangle([px(X(-55.2)), px(Y(148)), px(X(47.6)), px(Y(2))], fill=SHELL_IN)
    for mm in (-55.2, 47.6):
        d.line([px(X(mm)), px(Y(148)), px(X(mm)), px(Y(2))], fill=INK, width=px(2.0))

    # roof: 174.4 wide x 16.5 thick, so it clears the body by only ~7 mm a side
    rr(d, (X(-87.2), Y(166.5), X(79.6), Y(150)), 5, fill=SHELL, outline=INK, width=3.4)
    d.line([px(X(-82)), px(Y(152.5)), px(X(74)), px(Y(152.5))], fill=(223, 228, 224), width=px(2.0))

    # wordmark, moulded into the front face around z 118-140
    f = font(12)
    txt = 'BirdWatch AI'
    tw = d.textlength(txt, font=f)
    d.text((px(X(-3.8)) - tw / 2, px(Y(126))), txt, font=f, fill=GREY)
    gx, gy = X(-3.8), Y(142)
    poly(d, [(gx - 19, gy - 3), (gx - 8, gy - 7), (gx - 1, gy - 1), (gx, gy - 6),
             (gx + 8, gy - 7), (gx + 19, gy - 3), (gx + 7, gy - 1), (gx + 1, gy + 4),
             (gx - 1, gy + 4), (gx - 7, gy - 1)], fill=GREY)

    # camera bay: the O62 port at z 55, with the teardrop notch the print has
    PCX, PCY, PR = X(-3.8), Y(55), 31 * k
    poly(d, [(PCX - 0.41 * PR, PCY - 0.91 * PR), (PCX, PCY - 1.41 * PR),
             (PCX + 0.41 * PR, PCY - 0.91 * PR)], fill=INK, outline=INK, width=2.6)
    ell(d, (PCX - PR, PCY - PR, PCX + PR, PCY + PR), fill=CREAM, outline=INK, width=3.0)
    ell(d, (PCX - PR + 5, PCY - PR + 5, PCX + PR - 5, PCY + PR - 5), fill=INK)
    for sx in (-1, 1):
        rr(d, (PCX + sx * 0.44 * PR - 0.14 * PR, PCY - 0.28 * PR,
               PCX + sx * 0.44 * PR + 0.14 * PR, PCY + 0.28 * PR), 0.14 * PR, fill=(228, 231, 234))
    ell(d, (PCX - 0.28 * PR, PCY - 0.28 * PR, PCX + 0.28 * PR, PCY + 0.28 * PR), fill=(96, 105, 118))
    ell(d, (PCX - 0.17 * PR, PCY - 0.17 * PR, PCX + 0.17 * PR, PCY + 0.17 * PR), fill=(24, 28, 38))
    ell(d, (PCX - 0.05 * PR, PCY - 0.44 * PR, PCX + 0.05 * PR, PCY - 0.34 * PR), fill=(210, 216, 222))

    # ---- tray: the black-filament base, drawn a touch proud so the depth reads
    rr(d, (X(-88), Y(23), X(80.4), Y(17)), 3, fill=SEED, outline=INK, width=2.6)
    rng = np.random.default_rng(5)
    for _ in range(44):
        sx = rng.uniform(X(-84), X(76)); sy = rng.uniform(Y(22), Y(18)); r = rng.uniform(1.5, 2.3)
        ell(d, (sx - r, sy - r, sx + r, sy + r), fill=SEED_D)
    rr(d, (X(-90), Y(17.5), X(82.4), Y(-4)), 7, fill=TRAY, outline=INK, width=3.2)
    d.line([px(X(-82)), px(Y(1)), px(X(74)), px(Y(1))], fill=(64, 70, 84), width=px(2.2))

    # ---- blue jay on the left end of the tray ----------------------------
    jay(scene, BX=X(-70), BY=Y(23) - 29 * 1.26, sc=1.26)

    # ---- mask the scene into the badge -----------------------------------
    mask = Image.new('L', (N, N), 0)
    ImageDraw.Draw(mask).ellipse([px(CX - R_SCENE), px(CY - R_SCENE), px(CX + R_SCENE), px(CY + R_SCENE)],
                                 fill=255)
    plate = ImageDraw.Draw(img)
    ell(plate, (CX - 252, CY - 252, CX + 252, CY + 252), fill=RING)
    ell(plate, (CX - 244, CY - 244, CX + 244, CY + 244), fill=CREAM)
    img.paste(scene, (0, 0), mask)
    return img.resize((W, W), Image.LANCZOS)


def jay(target, BX=214.0, BY=342.0, sc=1.30):
    """Flat blue jay, side view, facing right, perched on the seed.

    Body/head/crest/tail/beak are unioned into one silhouette mask, and the outline
    is taken from that mask — overlapping primitives never leave a seam. Offsets are
    in body units; sc scales the whole bird about (BX, BY).
    """
    from scipy import ndimage
    PAD = 70
    x0, y0 = BX - PAD, BY - PAD
    n = px(2 * PAD)

    def P(*pts):
        return [(px(BX + x * sc - x0), px(BY + y * sc - y0)) for x, y in pts]

    def B(a, b, c, e):
        return [px(BX + a * sc - x0), px(BY + b * sc - y0),
                px(BX + c * sc - x0), px(BY + e * sc - y0)]

    # ---- silhouette -----------------------------------------------------
    sil = Image.new('L', (n, n), 0)
    sd = ImageDraw.Draw(sil)
    sd.ellipse(B(-26, -19, 22, 23), fill=255)                        # body
    sd.ellipse(B(9, -35, 39, -7), fill=255)                          # head
    sd.polygon(P((16, -31), (22, -46), (30, -32)), fill=255)         # crest
    sd.polygon(P((-14, -10), (-65, 0), (-60, 15), (-12, 12)), fill=255)  # tail
    sd.polygon(P((36, -24), (53, -19.5), (36, -14)), fill=255)       # beak
    m = np.asarray(sil) > 127
    t = max(1, px(1.15 * sc))
    st = np.ones((3, 3), bool)
    outer = ndimage.binary_dilation(m, st, iterations=t)
    inner = ndimage.binary_erosion(m, st, iterations=t)

    layer = Image.new('RGBA', (n, n), (0, 0, 0, 0))
    rgba = np.asarray(layer).copy()
    rgba[outer] = (*INK, 255)
    rgba[inner] = (*JAY, 255)
    layer = Image.fromarray(rgba)
    ld = ImageDraw.Draw(layer)

    # ---- markings, all inside the silhouette ----------------------------
    ld.ellipse(B(-6, -5, 13, 17), fill=(*JAY_W, 255))                # pale breast
    ld.polygon(P((-19, -8), (4, -9), (9, 0), (0, 12), (-16, 10)),
               fill=(*JAY_L, 255), outline=(*INK, 255), width=px(1.9 * sc))
    for i in range(3):                                               # wing coverts
        a, b = P((-15 + i * 4, 6 - i * 3.5), (3 + i * 2, -2 - i * 3.0))
        ld.line(a + b, fill=(52, 92, 140, 255), width=px(1.2 * sc))
    for i in range(3):                                               # tail bars
        a, b = P((-50 + i * 11, 4.6 + i * 0.4), (-47 + i * 11, 14.6 + i * 0.4))
        ld.line(a + b, fill=(52, 92, 140, 255), width=px(1.2 * sc))
    ld.ellipse(B(24, -25, 34, -15.5), fill=(*JAY_W, 255))            # face patch
    ld.ellipse(B(28.0, -23.4, 32.0, -19.4), fill=(*INK, 255))        # eye
    ld.ellipse(B(28.9, -22.7, 30.2, -21.4), fill=(*CREAM, 255))
    a, b = P((36, -24), (36, -14))                                   # beak base
    ld.line(a + b, fill=(*INK, 255), width=px(1.4 * sc))

    # clip every marking back inside the silhouette
    a = np.asarray(layer).copy()
    a[~outer] = (0, 0, 0, 0)
    layer = Image.fromarray(a)

    # legs sit below the body, outside the silhouette
    base = Image.new('RGBA', (n, n), (0, 0, 0, 0))
    bd = ImageDraw.Draw(base)
    for lx in (2, 12):
        p = P((lx, 17), (lx, 29))
        bd.line(p[0] + p[1], fill=(*INK, 255), width=px(2.1 * sc))
    base.alpha_composite(layer)
    target.paste(base, (px(x0), px(y0)), base)


if __name__ == '__main__':
    im = build()
    im.save(OUT, quality=90, subsampling=0, optimize=True)
    im.save(os.path.join(HERE, '_tile_preview.png'))
    print('wrote', OUT, os.path.getsize(OUT), 'bytes')
