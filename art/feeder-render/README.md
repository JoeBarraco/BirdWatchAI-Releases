# R05 outdoor feeder — render pipeline

The outdoor pricing-card image (`images/full-nest-outdoor.jpg`) is rendered straight from
the printed enclosure's STL rather than drawn or AI-generated, so it stays dimensionally
honest when the CAD changes.

## What's here

- `masters/R05-feeder-render-bird-1024.png` — the shipped hero, 1024×1024, robin on the tray.
- `masters/R05-feeder-render-product-1024.png` — same shot, no bird. Cleaner for product tiles.
- `masters/R05-feeder-render-before-after.png` — the old AI art next to the render, for reference.
- `pipeline/` — the renderer. Pure Python: numpy + Pillow + trimesh + scipy, no GPU, no Blender.

## Source model

`R05 - Birdwatch Birdfeeder + Teardrop + Rib (For AI Analysis).stl`, which lives in
`~/Downloads` — the enclosure STLs are **not** in any git repo. `render.py` has the path at
the top; point it at the current revision before re-rendering.

Frame of that file: +X right, +Y back, +Z up, millimetres. Camera bore axis at x −3.795,
z 55.0, r 30.97, cavity y 22 → 67. Front wall outer face at y 20.44. The black-filament
tray is everything below z ≈ 20.5 (`TRAY_TOP_Z` in `render.py`).

Two gotchas that will bite anyone reusing this:

- **The STL's winding is inverted** — computed face normals point *into* the solid. The
  renderer runs two-sided and flips normals toward the viewer; don't "fix" it by re-winding.
- **Depth must interpolate linearly under an orthographic projection**, not
  perspective-correct. The shadow map is ortho; getting this wrong shadows the whole model.

## Re-rendering

```bash
cd pipeline
python render.py 1024 2          # geometry + shadow pass -> _gbuf.npz  (~3 min)
python compose.py out.png --bird # shade + composite onto the garden plate
```

`render.py <width> <supersample>`. 1024 × 2 supersample is what shipped; drop to `560 1`
for a fast look. `compose.py` without `--bird` gives the clean product version.

The garden background, the wooden post and the robin are lifted from the previous artwork
(`AI render of bird feeder.png`, also in `~/Downloads`) so both pricing cards stay one
visual family — `compose.py` masks the old feeder out, rebuilds the post by mirror-tiling a
clean slice of it, and diffuses the bokeh in behind. Only the feeder itself is CG.

## Gumroad product tile

`pipeline/tile.py` draws `images/product-feeder-outdoor.jpg` — the flat illustration used as
the Gumroad product image. It is **not** a render; it is vector-style art that has to sit in
the `product-*.jpg` family (green gradient plate, pale ring, circular scene, heavy dark
outlines), so the palette is sampled from the existing tiles and hard-coded at the top.

```bash
python tile.py
```

The feeder in it is drawn to scale from the same numbers the render uses — `k` px per mm,
`X(mm)` / `Y(mm_z)` map part coordinates to the canvas — so the flat elevation is honest:
160 wide body, 174.4 roof clearing it by only ~7 mm a side, O62 port at z 55 with the
teardrop notch, black tray below z 20.5. Editing the tile means editing those numbers, not
nudging pixels.

The blue jay is built by unioning its parts into one silhouette mask and taking the outline
from that mask, because overlapping filled primitives with their own strokes always leave a
seam where they meet.

Note this file only updates the image in the repo. **Gumroad serves its own copy** — the
listing has to be updated by uploading the new file in the Gumroad product editor.

## Known geometry note

The teardrop print-support cut runs the full depth of the part, so it also removes the front
wall above the camera port: the opening is the Ø62 circle up to z 86, then tapers to a point
at z 98.8 (25.6 mm wide at z 86, 13.6 at z 92, 1.6 at z 98). That ~12.8 mm notch is real and
the render shows it. Fix it upstream in CAD if it isn't wanted, not in the image.
