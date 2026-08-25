"""BirdWatch AI outdoor feeder — geometry pass. Writes a G-buffer for shade.py."""
import sys, os, time
import numpy as np
import trimesh

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import rast, geom

STL = r'C:\Users\jbarraco\Downloads\R05 - Birdwatch Birdfeeder + Teardrop + Rib (For AI Analysis).stl'

M_PLA, M_TRAY, M_GLOSS, M_BEZEL, M_LENS, M_IR, M_WOOD, M_SEED, M_DARK = 1, 2, 3, 4, 5, 6, 7, 8, 9

TRAY_TOP_Z = 20.5          # everything below this prints in black filament
BORE_X, BORE_Z, BORE_R = -3.795, 55.0, 30.97
FRONT_Y = 20.44            # outer face of the front wall


def build_scene():
    sc = geom.Scene()
    t0 = time.time()

    # ---- printed enclosure, straight from the STL -------------------------
    mesh = trimesh.load(STL)
    V = np.asarray(mesh.vertices, float)
    F = np.asarray(mesh.faces, int)
    nV, nF, nN = rast.split_hard_edges(V, F, angle_deg=32.0)
    fz = nV[nF].mean(1)[:, 2]
    white = np.array([0.905, 0.893, 0.862])
    black = np.array([0.052, 0.052, 0.056])
    col = np.where(fz[:, None] < TRAY_TOP_Z, black, white)
    mat = np.where(fz < TRAY_TOP_Z, M_TRAY, M_PLA).astype(np.int16)
    sc.add(nV, nF, col, mat, normals=nN)
    print('  shell %d tris  (%.1fs)' % (len(nF), time.time() - t0))

    # ---- the camera, seated in the bore -----------------------------------
    cx, cz, R = BORE_X, BORE_Z, BORE_R
    y_face = FRONT_Y + 0.6
    dark = np.array([0.045, 0.045, 0.048])
    gloss = np.array([0.013, 0.013, 0.016])
    bez = np.array([0.845, 0.835, 0.805])
    sc.add(*geom.tube(cx, cz, y_face, 66.5, R - 0.04, seg=128), dark, M_DARK, hard=None)
    sc.add(*geom.disc(cx, cz, 66.5, R + 0.6, seg=128), dark * 0.55, M_DARK)
    sc.add(*geom.disc(cx, cz, y_face + 0.2, R - 0.04, 26.6, seg=128), bez, M_BEZEL)
    sc.add(*geom.torus_ring(cx, cz, y_face + 0.2, 28.8, 2.1, seg=128, rseg=10), bez, M_BEZEL, hard=None)

    # glossy black faceplate, very slightly dished
    a = np.linspace(0, 2 * np.pi, 128, endpoint=False)
    rr = np.linspace(0, 26.9, 12)
    A, RG = np.meshgrid(a, rr, indexing='ij')
    fv = np.column_stack([(cx + RG * np.cos(A)).ravel(),
                          (y_face + 0.45 * (RG / 26.9) ** 2).ravel(),
                          (cz + RG * np.sin(A)).ravel()])
    ff = []
    nr = len(rr)
    for i in range(128):
        ii = (i + 1) % 128
        for k in range(nr - 1):
            p = i * nr + k; q = ii * nr + k
            ff.append([p, q, q + 1]); ff.append([p, q + 1, p + 1])
    sc.add(fv, np.array(ff), gloss, M_GLOSS, hard=None)

    # lens barrel + glass
    sc.add(*geom.tube(cx, cz, y_face - 3.6, y_face + 0.5, 9.6, seg=72), np.array([0.085, 0.085, 0.095]), M_GLOSS, hard=None)
    sc.add(*geom.disc(cx, cz, y_face - 3.6, 9.6, 7.6, seg=72), np.array([0.20, 0.20, 0.21]), M_BEZEL)
    sc.add(*geom.disc(cx, cz, y_face - 3.0, 7.6, seg=72), np.array([0.010, 0.012, 0.026]), M_LENS)
    sc.add(*geom.disc(cx, cz, y_face - 2.4, 4.0, seg=64), np.array([0.016, 0.020, 0.048]), M_LENS)

    # two IR flood lenses
    for dx in (-19.6, 19.6):
        poly = geom.rounded_rect_poly(cx + dx, cz - 1.0, 9.4, 23.0, 4.7, seg=8)
        sc.add(*geom.prism(poly, y_face - 0.35, y_face + 1.2), np.array([0.50, 0.50, 0.51]), M_IR)
    sc.add(*geom.disc(cx, cz + 15.4, y_face - 0.05, 1.15, seg=24), np.array([0.30, 0.30, 0.31]), M_DARK)

    # ---- seed -------------------------------------------------------------
    sv, sf = geom.icosphere(1)
    rng = np.random.default_rng(7)
    pal = np.array([
        [0.055, 0.050, 0.048], [0.070, 0.062, 0.055], [0.105, 0.090, 0.075],   # black-oil sunflower
        [0.300, 0.235, 0.150], [0.215, 0.160, 0.100],                          # striped sunflower
        [0.780, 0.720, 0.520], [0.845, 0.795, 0.610], [0.700, 0.640, 0.440],   # white millet
        [0.760, 0.560, 0.235], [0.680, 0.470, 0.190],                          # cracked corn
        [0.420, 0.180, 0.110], [0.330, 0.150, 0.095],                          # red milo
        [0.620, 0.470, 0.300], [0.500, 0.360, 0.215],                          # peanut / safflower
    ])
    wgt = np.array([1.6, 1.6, 1.0, 0.9, 0.9, 1.5, 1.2, 1.0, 0.8, 0.7, 0.6, 0.5, 0.8, 0.7])
    wgt = wgt / wgt.sum()
    heap_cx, heap_cy, H0 = 4.0, -6.0, 13.0

    def heap_h(x, y):
        d = ((x - heap_cx) / 62.0) ** 2 + ((y - heap_cy) / 52.0) ** 2
        return H0 * np.exp(-1.9 * d)

    SV, SF, SC = [], [], []
    off = 0
    for _ in range(20000):
        x = rng.uniform(-76, 68); y = rng.uniform(-84, 19)
        h = heap_h(x, y)
        if rng.random() > np.clip(0.13 + h / H0, 0, 1) ** 0.55:
            continue
        r = rng.uniform(1.15, 2.85)
        z = 4.0 + (h * rng.uniform(0.86, 1.0) if h > 1.2 else 0.0) + r * 0.55
        s = np.array([r, r * rng.uniform(0.55, 0.85), r * rng.uniform(0.42, 0.7)])
        q = rng.normal(size=4); q /= np.linalg.norm(q)
        w, i, j, k = q
        Rm = np.array([[1 - 2 * (j * j + k * k), 2 * (i * j - k * w), 2 * (i * k + j * w)],
                       [2 * (i * j + k * w), 1 - 2 * (i * i + k * k), 2 * (j * k - i * w)],
                       [2 * (i * k - j * w), 2 * (j * k + i * w), 1 - 2 * (i * i + j * j)]])
        SV.append((sv * s) @ Rm.T + np.array([x, y, z]))
        SF.append(sf + off); off += len(sv)
        SC.append(np.tile(np.clip(pal[rng.choice(len(pal), p=wgt)] * rng.uniform(0.80, 1.15), 0, 1), (len(sf), 1)))
    sc.add(np.vstack(SV), np.vstack(SF), np.vstack(SC), M_SEED, hard=None)
    print('  %d seeds' % len(SV))
    return sc.build()


def main(W=1024, SS=2):
    t0 = time.time()
    V, F, VN, C, M = build_scene()
    print('scene: %d tris (%.1fs)' % (len(F), time.time() - t0))

    A = np.radians(26.0); E = np.radians(16.0); dist = 700.0
    target = np.array([-3.8, -14.0, 76.0])
    eye = target + dist * np.array([np.sin(A) * np.cos(E), -np.cos(A) * np.cos(E), np.sin(E)])
    Vm = rast.look_at(eye, target)
    Pm = rast.persp(20.0, 1.0, 50, 3000)

    w = h = W * SS
    gb = rast.GBuffer(w, h)
    t1 = time.time()
    rast.rasterize(gb, V, F, VN, Pm, Vm, C, M, cull=False)
    print('raster %.1fs' % (time.time() - t1))

    L = np.array([-0.30, -0.80, 0.52]); L /= np.linalg.norm(L)
    SM = 1600
    lc = np.array([-3.8, -10.0, 80.0])
    Lm = rast.look_at(lc + L * 700, lc, up=(0, 0, 1))
    Lp = rast.ortho(215.0, 1.0, 1.0, 1600.0)
    sgb = rast.GBuffer(SM, SM)
    t1 = time.time()
    rast.rasterize(sgb, V, F, VN, Lp, Lm, np.zeros(3), 0, cull=False, depth_only=True)
    print('shadow %.1fs' % (time.time() - t1))

    np.savez(os.path.join(HERE, '_gbuf.npz'),
             depth=gb.depth.astype(np.float32), normal=gb.normal.astype(np.float32),
             albedo=gb.albedo.astype(np.float32), mat=gb.mat, wpos=gb.wpos.astype(np.float32),
             sdepth=sgb.depth.astype(np.float32), Lm=Lm, Lp=Lp, L=L, eye=eye,
             W=W, SS=SS, Vm=Vm, Pm=Pm)
    print('total %.1fs -> _gbuf.npz' % (time.time() - t0))


if __name__ == '__main__':
    main(int(sys.argv[1]) if len(sys.argv) > 1 else 1024,
         int(sys.argv[2]) if len(sys.argv) > 2 else 2)
