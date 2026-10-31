"""Genera los íconos de public/icons desde brand/serpix-logo-master.jpg.
Solo redimensiona y optimiza (paleta de 256 colores); no redibuja el logo.
Requiere Pillow. Si cambian los archivos, subir el sufijo de versión (.v4) en app/, public/ y el manifiesto."""
import os
from PIL import Image

SRC = Image.open("brand/serpix-logo-master.jpg").convert("RGB")
OUT = "public/icons"
os.makedirs(OUT, exist_ok=True)

def png(name, size, colors=None):
    im = SRC.resize((size, size), Image.LANCZOS)
    if colors:
        im = im.quantize(colors=colors, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.FLOYDSTEINBERG)
    im.save(f"{OUT}/{name}", optimize=True)

png("serpix-32.v4.png", 32)
png("serpix-48.v4.png", 48)
png("apple-touch-icon-180.v4.png", 180, 256)
png("icon-192.v4.png", 192, 256)
png("icon-512.v4.png", 512, 256)
png("logo-128.v4.png", 128, 256)
ico = [SRC.resize((s, s), Image.LANCZOS) for s in (16, 32, 48)]
ico[2].save(f"{OUT}/favicon.v4.ico", sizes=[(16, 16), (32, 32), (48, 48)], append_images=ico[:2])
