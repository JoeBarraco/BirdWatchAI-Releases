"""Tiny numpy software rasterizer: z-buffer, deferred G-buffer output."""
import numpy as np


def look_at(eye, target, up=(0, 0, 1)):
    eye = np.asarray(eye, float); target = np.asarray(target, float); up = np.asarray(up, float)
    f = target - eye; f /= np.linalg.norm(f)
    r = np.cross(f, up); r /= np.linalg.norm(r)
    u = np.cross(r, f)
    M = np.eye(4)
    M[0, :3] = r; M[1, :3] = u; M[2, :3] = -f
    M[:3, 3] = -M[:3, :3] @ eye
    return M


def persp(fovy_deg, aspect, near, far):
    f = 1.0 / np.tan(np.radians(fovy_deg) / 2)
    P = np.zeros((4, 4))
    P[0, 0] = f / aspect; P[1, 1] = f
    P[2, 2] = (far + near) / (near - far); P[2, 3] = 2 * far * near / (near - far)
    P[3, 2] = -1
    return P


def ortho(half_h, aspect, near, far):
    P = np.eye(4)
    P[0, 0] = 1 / (half_h * aspect); P[1, 1] = 1 / half_h
    P[2, 2] = -2 / (far - near); P[2, 3] = -(far + near) / (far - near)
    return P


class GBuffer:
    def __init__(self, w, h):
        self.w, self.h = w, h
        self.depth = np.full((h, w), np.inf)          # view-space distance (positive)
        self.normal = np.zeros((h, w, 3))
        self.albedo = np.zeros((h, w, 3))
        self.mat = np.zeros((h, w), np.int16)          # material id, 0 = background
        self.wpos = np.zeros((h, w, 3))


def rasterize(gb, V, F, VN, P, Vm, albedo, matid, cull=True, depth_only=False):
    """V (n,3) world verts; F (m,3); VN (n,3) vertex normals; P proj; Vm view matrix.
    albedo: (3,) or (m,3) per-face.  matid: int or (m,) per-face."""
    h, w = gb.h, gb.w
    n = len(V)
    albedo = np.asarray(albedo, float)
    per_face_c = albedo.ndim == 2
    matid = np.asarray(matid)
    per_face_m = matid.ndim == 1
    Vh = np.hstack([V, np.ones((n, 1))])
    vv = Vh @ Vm.T                      # view space
    cp = vv @ P.T                       # clip
    wclip = cp[:, 3].copy()
    behind = wclip <= 1e-6
    wclip[behind] = 1e-6
    ndc = cp[:, :3] / wclip[:, None]
    sx = (ndc[:, 0] * 0.5 + 0.5) * w
    sy = (1 - (ndc[:, 1] * 0.5 + 0.5)) * h
    vdist = -vv[:, 2]                   # positive distance along view dir

    tri_ok = ~behind[F].any(axis=1)
    fidx = np.nonzero(tri_ok)[0]
    Fv = F[tri_ok]
    if len(Fv) == 0:
        return
    x = sx[Fv]; y = sy[Fv]; z = vdist[Fv]
    area = (x[:, 1] - x[:, 0]) * (y[:, 2] - y[:, 0]) - (x[:, 2] - x[:, 0]) * (y[:, 1] - y[:, 0])
    if cull:
        keep = area > 1e-9
    else:
        keep = np.abs(area) > 1e-9
    Fv = Fv[keep]; x = x[keep]; y = y[keep]; z = z[keep]; area = area[keep]
    fidx = fidx[keep]

    xmin = np.clip(np.floor(x.min(1)).astype(int), 0, w - 1)
    xmax = np.clip(np.ceil(x.max(1)).astype(int), 0, w - 1)
    ymin = np.clip(np.floor(y.min(1)).astype(int), 0, h - 1)
    ymax = np.clip(np.ceil(y.max(1)).astype(int), 0, h - 1)
    onscreen = (x.max(1) >= 0) & (x.min(1) < w) & (y.max(1) >= 0) & (y.min(1) < h)

    is_ortho = abs(P[3, 2]) < 1e-12       # ortho: depth is linear in screen space
    invz = 1.0 / z
    for i in range(len(Fv)):
        if not onscreen[i]:
            continue
        x0, x1 = xmin[i], xmax[i]; y0, y1 = ymin[i], ymax[i]
        if x1 < x0 or y1 < y0:
            continue
        px = np.arange(x0, x1 + 1) + 0.5
        py = np.arange(y0, y1 + 1) + 0.5
        PX, PY = np.meshgrid(px, py)
        ax, bx, cx = x[i]; ay, by, cy = y[i]
        A = area[i]
        l0 = ((bx - PX) * (cy - PY) - (cx - PX) * (by - PY)) / A
        l1 = ((cx - PX) * (ay - PY) - (ax - PX) * (cy - PY)) / A
        l2 = 1 - l0 - l1
        inside = (l0 >= -1e-6) & (l1 >= -1e-6) & (l2 >= -1e-6)
        if not inside.any():
            continue
        if is_ortho:
            zz = l0 * z[i, 0] + l1 * z[i, 1] + l2 * z[i, 2]
        else:
            iz = l0 * invz[i, 0] + l1 * invz[i, 1] + l2 * invz[i, 2]
            zz = 1.0 / np.maximum(iz, 1e-9)
        sub = gb.depth[y0:y1 + 1, x0:x1 + 1]
        m = inside & (zz < sub)
        if not m.any():
            continue
        ys, xs = np.nonzero(m)
        gb.depth[y0 + ys, x0 + xs] = zz[m]
        if depth_only:
            continue
        # perspective-correct barycentrics
        if is_ortho:
            b0, b1, b2 = l0, l1, l2
        else:
            b0 = l0 * invz[i, 0] * zz; b1 = l1 * invz[i, 1] * zz; b2 = l2 * invz[i, 2] * zz
        idx = Fv[i]
        nrm = (b0[..., None] * VN[idx[0]] + b1[..., None] * VN[idx[1]] + b2[..., None] * VN[idx[2]])
        wp = (b0[..., None] * V[idx[0]] + b1[..., None] * V[idx[1]] + b2[..., None] * V[idx[2]])
        gb.normal[y0 + ys, x0 + xs] = nrm[m]
        gb.wpos[y0 + ys, x0 + xs] = wp[m]
        gb.albedo[y0 + ys, x0 + xs] = albedo[fidx[i]] if per_face_c else albedo
        gb.mat[y0 + ys, x0 + xs] = matid[fidx[i]] if per_face_m else matid


def vertex_normals(V, F, smooth_angle=None):
    fn = np.cross(V[F[:, 1]] - V[F[:, 0]], V[F[:, 2]] - V[F[:, 0]])
    ln = np.linalg.norm(fn, axis=1, keepdims=True); ln[ln == 0] = 1
    fn = fn / ln
    vn = np.zeros_like(V)
    for k in range(3):
        np.add.at(vn, F[:, k], fn)
    ln = np.linalg.norm(vn, axis=1, keepdims=True); ln[ln == 0] = 1
    return vn / ln


def split_hard_edges(V, F, angle_deg=35.0):
    """Duplicate vertices per face, then average normals only across faces whose
    normals are within angle_deg -> crisp product-render edges, smooth cylinders."""
    fn = np.cross(V[F[:, 1]] - V[F[:, 0]], V[F[:, 2]] - V[F[:, 0]])
    ln = np.linalg.norm(fn, axis=1, keepdims=True); ln[ln == 0] = 1
    fn = fn / ln
    nV = V[F.reshape(-1)]
    nF = np.arange(len(F) * 3).reshape(-1, 3)
    # accumulate per original vertex the list of face ids
    from collections import defaultdict
    vf = defaultdict(list)
    for fi, tri in enumerate(F):
        for v in tri:
            vf[v].append(fi)
    cosang = np.cos(np.radians(angle_deg))
    nN = np.zeros_like(nV)
    for fi, tri in enumerate(F):
        for k, v in enumerate(tri):
            fl = vf[v]
            nn = fn[fl]
            sel = nn @ fn[fi] > cosang
            acc = nn[sel].sum(0)
            l = np.linalg.norm(acc)
            nN[fi * 3 + k] = acc / l if l > 1e-9 else fn[fi]
    return nV, nF, nN
