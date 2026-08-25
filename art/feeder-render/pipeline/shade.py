"""Deferred shading + background compositing for the feeder render."""
import os, sys
import numpy as np
from PIL import Image, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

M_PLA, M_TRAY, M_GLOSS, M_BEZEL, M_LENS, M_IR, M_WOOD, M_SEED, M_DARK = 1, 2, 3, 4, 5, 6, 7, 8, 9
SPEC = np.array([0.0, 0.045, 0.035, 0.60, 0.20, 0.85, 0.05, 0.030, 0.06, 0.05])
SHIN = np.array([1.0, 30.0, 24.0, 380.0, 70.0, 1400.0, 60.0, 14.0, 45.0, 22.0])


def box_blur(a, r):
    if r < 1:
        return a
    k = 2 * r + 1
    c = np.cumsum(np.pad(a, ((r + 1, r), (0, 0)) + ((0, 0),) * (a.ndim - 2), mode='edge'), axis=0)
    a = (c[k:] - c[:-k]) / k
    c = np.cumsum(np.pad(a, ((0, 0), (r + 1, r)) + ((0, 0),) * (a.ndim - 2), mode='edge'), axis=1)
    return (c[:, k:] - c[:, :-k]) / k


def fbm(p, octaves=4, seed=0):
    """Value noise on 3D points -> scalar in [0,1]."""
    rng = np.random.default_rng(seed)
    tbl = rng.random(4096)
    out = np.zeros(p.shape[:-1]); amp = 1.0; tot = 0.0; f = 1.0
    for _ in range(octaves):
        q = p * f
        i = np.floor(q).astype(np.int64)
        t = q - i
        t = t * t * (3 - 2 * t)
        v = 0.0
        for dz in (0, 1):
            for dy in (0, 1):
                for dx in (0, 1):
                    hsh = ((i[..., 0] + dx) * 73856093) ^ ((i[..., 1] + dy) * 19349663) ^ ((i[..., 2] + dz) * 83492791)
                    n = tbl[np.abs(hsh) % 4096]
                    wgt = (t[..., 0] if dx else 1 - t[..., 0]) * (t[..., 1] if dy else 1 - t[..., 1]) * \
                          (t[..., 2] if dz else 1 - t[..., 2])
                    v = v + n * wgt
        out += v * amp; tot += amp; amp *= 0.5; f *= 2.07
    return out / tot


def shade():
    d = np.load(os.path.join(HERE, '_gbuf.npz'))
    depth, N, alb, mat, wp = d['depth'], d['normal'], d['albedo'], d['mat'], d['wpos']
    L = d['L']; eye = d['eye']; Lm = d['Lm']; Lp = d['Lp']; sdep = d['sdepth']
    W = int(d['W']); SS = int(d['SS'])
    h, w = depth.shape
    solid = mat > 0

    ln = np.linalg.norm(N, axis=2, keepdims=True); ln[ln == 0] = 1
    N = N / ln
    Vdir = eye[None, None, :] - wp
    vn = np.linalg.norm(Vdir, axis=2, keepdims=True); vn[vn == 0] = 1
    Vdir = Vdir / vn
    N = np.where((N * Vdir).sum(2, keepdims=True) < 0, -N, N)   # two-sided

    # ---------------- procedural surface detail ---------------------------
    alb = alb.copy()
    # 3D-print layer lines on the printed shell
    m = (mat == M_PLA) | (mat == M_TRAY)
    if m.any():
        z = wp[..., 2][m]
        band = 0.5 + 0.5 * np.cos(z * (2 * np.pi / 1.6))
        grain = fbm(wp[m] * np.array([0.020, 0.020, 0.55]), 2, seed=3)
        f = 1.0 + 0.026 * (band - 0.5) + 0.020 * (grain - 0.5)
        alb[m] *= f[:, None]
    # wood
    m = mat == M_WOOD
    if m.any():
        p = wp[m]
        rings = np.sin(p[:, 2] * 0.11 + 5.0 * fbm(p * np.array([0.02, 0.02, 0.004]), 3, seed=11))
        knot = fbm(p * np.array([0.05, 0.05, 0.012]), 4, seed=12)
        t = np.clip(0.45 + 0.30 * rings + 0.45 * (knot - 0.5), 0, 1)
        c0 = np.array([0.150, 0.088, 0.050]); c1 = np.array([0.345, 0.225, 0.128])
        alb[m] = c0 + (c1 - c0) * t[:, None]

    # ---------------- shadow map -----------------------------------------
    NdL0 = np.clip((N * L).sum(2), 0, 1)
    noff = (1.6 + 4.0 * (1 - NdL0))[..., None] * N        # normal-offset, kills acne
    P4 = np.concatenate([wp + noff, np.ones(wp.shape[:2] + (1,))], axis=2)
    lv = P4 @ Lm.T
    lc = lv @ Lp.T
    lndc = lc[..., :3] / lc[..., 3:4]
    SMh, SMw = sdep.shape
    sx = np.clip(((lndc[..., 0] * .5 + .5) * SMw).astype(int), 0, SMw - 1)
    sy = np.clip(((1 - (lndc[..., 1] * .5 + .5)) * SMh).astype(int), 0, SMh - 1)
    zl = -lv[..., 2]
    bias = 0.8
    shd = np.zeros((h, w))
    off = [-3, -1, 0, 1, 3]
    for oy in off:
        for ox in off:
            sd = sdep[np.clip(sy + oy, 0, SMh - 1), np.clip(sx + ox, 0, SMw - 1)]
            shd += (zl - bias <= sd).astype(float)
    shd /= len(off) ** 2
    shd = box_blur(shd[..., None], max(1, SS))[..., 0]

    # ---------------- SSAO ------------------------------------------------
    dd = np.where(np.isfinite(depth), depth, 1e5)
    ao = np.zeros((h, w))
    rng = np.random.default_rng(1)
    nsmp = 12
    for i in range(nsmp):
        rad = max(1, int((3 + 40 * (i + 1) / nsmp)) * SS // 2)
        ang = rng.uniform(0, 2 * np.pi)
        ox, oy = int(np.cos(ang) * rad), int(np.sin(ang) * rad)
        nb = np.roll(np.roll(dd, oy, axis=0), ox, axis=1)
        diff = dd - nb
        ao += np.clip(diff / 7.0, 0, 1) * (np.abs(diff) < 60)
    ao = 1.0 - 0.74 * (ao / nsmp)
    ao = np.clip(box_blur(ao[..., None], 3 * SS)[..., 0], 0, 1)

    # ---------------- lighting --------------------------------------------
    NdL = np.clip((N * L).sum(2), 0, 1)
    sun = np.array([1.00, 0.958, 0.892]) * 1.06
    up = np.clip(N[..., 2], 0, 1)[..., None]
    dn = np.clip(-N[..., 2], 0, 1)[..., None]
    side = (1 - up - dn)
    sky = np.array([0.400, 0.435, 0.500])
    grnd = np.array([0.210, 0.215, 0.150])
    horiz = np.array([0.308, 0.312, 0.308])
    ambient = (up * sky + dn * grnd + side * horiz) * ao[..., None]
    # polished surfaces reflect rather than scatter
    ambient = ambient * np.where(((mat == M_GLOSS) | (mat == M_LENS))[..., None], 0.22, 1.0)

    # soft bounce off the seed tray, back up into the shaded interior
    F1 = np.array([0.66, -0.36, 0.24]); F1 /= np.linalg.norm(F1)
    fill = np.clip((N * F1).sum(2), 0, 1)[..., None] * np.array([0.105, 0.115, 0.130])

    diff = (NdL * shd)[..., None] * sun

    H = L[None, None, :] + Vdir
    H = H / np.maximum(np.linalg.norm(H, axis=2, keepdims=True), 1e-9)
    NdH = np.clip((N * H).sum(2), 0, 1)
    sp = SPEC[np.clip(mat, 0, len(SPEC) - 1)]
    sh = SHIN[np.clip(mat, 0, len(SHIN) - 1)]
    NdV = np.clip((N * Vdir).sum(2), 0, 1)
    fres = sp + (1 - sp) * (1 - NdV) ** 5
    spec = (NdH ** sh)[..., None] * (fres * shd)[..., None] * sun * 2.4

    # environment reflection for the glossy camera face / lens
    glossy = (mat == M_GLOSS) | (mat == M_LENS) | (mat == M_BEZEL)
    Rf = 2 * NdV[..., None] * N - Vdir
    envt = np.clip(Rf[..., 2], -1, 1)
    env = (np.array([0.72, 0.84, 1.05])[None, None, :] * np.clip(envt, 0, 1)[..., None] ** 0.6 +
           np.array([0.09, 0.10, 0.07])[None, None, :] * np.clip(-envt, 0, 1)[..., None])
    envm = np.where(glossy[..., None], fres[..., None] * 0.95, 0.0)

    sheen = np.where(((mat == M_GLOSS) | (mat == M_LENS))[..., None],
                     (NdH ** 34.0)[..., None] * np.array([0.22, 0.245, 0.285]) * shd[..., None], 0.0)
    col = alb * (diff + ambient + fill) + spec + env * envm + sheen
    col = np.where(solid[..., None], col, 0.0)
    return col, solid, depth, mat, W, SS


def tonemap(c):
    a, b, cc, d, e = 2.51, 0.03, 2.43, 0.59, 0.14
    return np.clip((c * (a * c + b)) / (c * (cc * c + d) + e), 0, 1)


if __name__ == '__main__':
    col, solid, depth, mat, W, SS = shade()
    img = tonemap(col) ** (1 / 2.2)
    img = np.where(solid[..., None], img, 0.16)
    im = Image.fromarray((img * 255).astype(np.uint8)).resize((W, W), Image.LANCZOS)
    im.save(os.path.join(HERE, 'preview.png'))
    print('wrote preview.png')
