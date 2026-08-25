"""Procedural geometry helpers. World: +X right, +Y back, +Z up (mm, STL frame)."""
import numpy as np


def _fan(poly_xz, y, flip=False):
    """Triangulate a closed 2D polygon (in the XZ plane) as a fan about its centroid."""
    c = poly_xz.mean(0)
    V = np.vstack([c[None, :], poly_xz])
    n = len(poly_xz)
    F = np.array([[0, 1 + i, 1 + (i + 1) % n] for i in range(n)])
    V3 = np.column_stack([V[:, 0], np.full(len(V), y), V[:, 1]])
    if flip:
        F = F[:, ::-1]
    return V3, F


def disc(cx, cz, y, r_out, r_in=0.0, seg=96, facing=-1):
    """Annulus/disc in the XZ plane at depth y, facing -Y (front) by default."""
    a = np.linspace(0, 2 * np.pi, seg, endpoint=False)
    co, si = np.cos(a), np.sin(a)
    if r_in <= 1e-9:
        V = np.zeros((seg + 1, 3))
        V[0] = [cx, y, cz]
        V[1:, 0] = cx + r_out * co; V[1:, 1] = y; V[1:, 2] = cz + r_out * si
        F = np.array([[0, i + 1, (i + 1) % seg + 1] for i in range(seg)])
    else:
        V = np.zeros((2 * seg, 3))
        V[:seg, 0] = cx + r_in * co; V[:seg, 2] = cz + r_in * si
        V[seg:, 0] = cx + r_out * co; V[seg:, 2] = cz + r_out * si
        V[:, 1] = y
        F = []
        for i in range(seg):
            j = (i + 1) % seg
            F.append([i, seg + i, seg + j]); F.append([i, seg + j, j])
        F = np.array(F)
    if facing > 0:
        F = F[:, ::-1]
    return V, F


def tube(cx, cz, y0, y1, r, seg=96, inward=False):
    """Cylinder wall between depths y0 and y1."""
    a = np.linspace(0, 2 * np.pi, seg, endpoint=False)
    V = np.zeros((2 * seg, 3))
    V[:seg, 0] = cx + r * np.cos(a); V[:seg, 2] = cz + r * np.sin(a); V[:seg, 1] = y0
    V[seg:, 0] = V[:seg, 0]; V[seg:, 2] = V[:seg, 2]; V[seg:, 1] = y1
    F = []
    for i in range(seg):
        j = (i + 1) % seg
        F.append([i, j, seg + j]); F.append([i, seg + j, seg + i])
    F = np.array(F)
    if inward:
        F = F[:, ::-1]
    return V, F


def torus_ring(cx, cz, y, r_mid, r_tube, seg=96, rseg=10, arc=(0.0, 1.0)):
    """Half-round bezel ring (a torus), axis along Y."""
    a = np.linspace(0, 2 * np.pi, seg, endpoint=False)
    t = np.linspace(np.pi * arc[0], np.pi * arc[1], rseg)
    A, T = np.meshgrid(a, t, indexing='ij')
    rr = r_mid + r_tube * np.cos(T)
    X = cx + rr * np.cos(A); Z = cz + rr * np.sin(A); Y = y - r_tube * np.sin(T)
    V = np.column_stack([X.ravel(), Y.ravel(), Z.ravel()])
    F = []
    for i in range(seg):
        ii = (i + 1) % seg
        for k in range(rseg - 1):
            a0 = i * rseg + k; b0 = ii * rseg + k
            F.append([a0, b0, b0 + 1]); F.append([a0, b0 + 1, a0 + 1])
    return V, np.array(F)


def rounded_rect_poly(cx, cz, w, h, r, seg=8):
    """Closed rounded-rectangle polygon in the XZ plane (counter-clockwise)."""
    pts = []
    hw, hh = w / 2 - r, h / 2 - r
    for (sx, sz, a0) in ((1, 1, 0), (-1, 1, np.pi / 2), (-1, -1, np.pi), (1, -1, 3 * np.pi / 2)):
        for k in range(seg + 1):
            a = a0 + k * (np.pi / 2) / seg
            pts.append([cx + sx * hw + r * np.cos(a), cz + sz * hh + r * np.sin(a)])
    return np.array(pts)


def prism(poly_xz, y0, y1):
    """Extrude a closed XZ polygon along Y, with capped ends."""
    n = len(poly_xz)
    Vf, Ff = _fan(poly_xz, y0)
    Vb, Fb = _fan(poly_xz, y1, flip=True)
    V = np.vstack([Vf, Vb])
    F = np.vstack([Ff, Fb + len(Vf)])
    # side wall: front ring verts are Vf[1:], back ring Vb[1:] (offset len(Vf))
    side = []
    o = len(Vf)
    for i in range(n):
        j = (i + 1) % n
        a, b = 1 + i, 1 + j
        side.append([a, o + b, o + a]); side.append([a, b, o + b])
    return V, np.vstack([F, np.array(side)])


def box(lo, hi):
    x0, y0, z0 = lo; x1, y1, z1 = hi
    V = np.array([[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0],
                  [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], float)
    F = np.array([[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7],
                  [0, 1, 5], [0, 5, 4], [2, 3, 7], [2, 7, 6],
                  [1, 2, 6], [1, 6, 5], [0, 4, 7], [0, 7, 3]])
    return V, F


def icosphere(subdiv=1):
    t = (1 + 5 ** 0.5) / 2
    V = np.array([[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0],
                  [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t],
                  [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]], float)
    F = np.array([[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11],
                  [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
                  [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9],
                  [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]])
    V = V / np.linalg.norm(V, axis=1, keepdims=True)
    for _ in range(subdiv):
        mid = {}
        nV = list(V); nF = []

        def m(a, b):
            k = (min(a, b), max(a, b))
            if k not in mid:
                p = (V[a] + V[b]) / 2
                nV.append(p / np.linalg.norm(p))
                mid[k] = len(nV) - 1
            return mid[k]
        for a, b, c in F:
            ab, bc, ca = m(a, b), m(b, c), m(c, a)
            nF += [[a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]]
        V = np.array(nV); F = np.array(nF)
    return V, F


def smooth_normals(V, F):
    fn = np.cross(V[F[:, 1]] - V[F[:, 0]], V[F[:, 2]] - V[F[:, 0]])
    ln = np.linalg.norm(fn, axis=1, keepdims=True); ln[ln == 0] = 1
    fn = fn / ln
    vn = np.zeros_like(V)
    for k in range(3):
        np.add.at(vn, F[:, k], fn)
    ln = np.linalg.norm(vn, axis=1, keepdims=True); ln[ln == 0] = 1
    return vn / ln


class Scene:
    """Accumulates (V, F, vertex normals, per-face albedo, per-face material id)."""

    def __init__(self):
        self.V = []; self.F = []; self.N = []; self.C = []; self.M = []; self._n = 0

    def add(self, V, F, color, mat, normals=None, hard=32.0):
        V = np.asarray(V, float); F = np.asarray(F, int)
        if normals is None:
            if hard is None:
                normals = smooth_normals(V, F)
            else:
                import rast
                V, F, normals = rast.split_hard_edges(V, F, angle_deg=hard)
        self.V.append(V); self.F.append(F + self._n); self.N.append(normals); self._n += len(V)
        col = np.asarray(color, float)
        if col.ndim == 1:
            col = np.tile(col, (len(F), 1))
        self.C.append(col)
        mat = np.asarray(mat)
        self.M.append(mat.astype(np.int16) if mat.ndim == 1 else np.full(len(F), int(mat), np.int16))

    def build(self):
        return (np.vstack(self.V), np.vstack(self.F), np.vstack(self.N),
                np.vstack(self.C), np.concatenate(self.M))


