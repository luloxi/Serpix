"""Genera los íconos de public/icons desde brand/serpix-logo-master.v7.png (ouroboros grueso, $ naranja (#e2781b)).
Solo redimensiona y optimiza (paleta de 256 colores); no redibuja el logo. También recorta el anillo (sin el $) para el botón +.
Requiere Pillow. Si cambian los archivos, subir el sufijo de versión (.v7) en app/, public/ y el manifiesto."""
import os
from PIL import Image, ImageDraw

SRC = Image.open("brand/serpix-logo-master.v7.png").convert("RGB")
OUT = "public/icons"
os.makedirs(OUT, exist_ok=True)

def png(name, size, colors=None):
    im = SRC.resize((size, size), Image.LANCZOS)
    if colors:
        im = im.quantize(colors=colors, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.FLOYDSTEINBERG)
    im.save(f"{OUT}/{name}", optimize=True)

png("serpix-48.v7.png", 48)
png("apple-touch-icon-180.v7.png", 180, 256)
png("icon-192.v7.png", 192, 256)
png("icon-512.v7.png", 512, 256)
png("logo-128.v7.png", 128, 256)
# Favicon de pestaña (transparente, recortado, $ grande): python3 scripts/make-tab-favicon.py brand/serpix-logo-master.v7.png public/icons v7 --dollar

# Anillo del botón +: el master sin el $ (centro en negro), recortado justo alrededor de la cabeza.
CX, CY, HOLE, HALF = 511.9, 513.1, 250, 388
ring = SRC.copy()
d = ImageDraw.Draw(ring)
d.ellipse((CX - HOLE, CY - HOLE, CX + HOLE, CY + HOLE), fill=(0, 0, 0))
x0, y0 = round(CX - HALF), round(CY - HALF)
ring = ring.crop((x0, y0, x0 + 2 * HALF, y0 + 2 * HALF)).resize((192, 192), Image.LANCZOS)
# v6: fuera del anillo es transparente (el v5 traía un margen negro opaco que asomaba por los bordes del botón).
# Alfa por luminancia fuera de la banda del anillo; el agujero y el borde interior quedan opacos.
import numpy as np
arr = np.asarray(ring.convert("RGB")).astype(float)
yy, xx = np.mgrid[0:192, 0:192]
rad = np.hypot(xx - 95.5, yy - 95.5)
alpha = np.clip(arr.max(axis=2) / 200.0, 0, 1)
alpha = np.where(rad <= 74, 1.0, alpha)
alpha = np.where(rad > 95.5, 0.0, alpha)
rgb = np.where(alpha[..., None] < 1, np.clip(arr / np.maximum(alpha, 1e-3)[..., None], 0, 255), arr)
rgb = np.where(alpha[..., None] <= 0.02, 0, rgb)
Image.fromarray(np.dstack([rgb, alpha * 255]).astype("uint8"), "RGBA").save(f"{OUT}/fab-ring.v6.png", optimize=True)
