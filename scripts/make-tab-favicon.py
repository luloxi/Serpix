"""Favicon de pestaña (escritorio): logo recortado al máximo, fondo transparente, sin cuadrado negro.
Lee el master (logo sobre negro), pasa el negro a transparente (con los bordes sin halo oscuro), recorta al cuadrado justo
y escribe favicon-32 (png) y favicon .ico (16/32/48). No toca los íconos Android/PWA ni el apple-touch (los genera make-icons.py).
Con --dollar (Serpix) reemplaza el $ del centro por uno más grande y grueso para que se lea a 16/32 px.
Uso: python3 scripts/make-tab-favicon.py <master.png|jpg> <out-dir> <sufijo, ej. v7> [--dollar]
Requiere Pillow y numpy."""
import sys
import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

ORANGE = (0xE2, 0x78, 0x1B)
FONT = "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf"


def fill_color_from_solid(rgba):
    """Los píxeles semitransparentes toman el color del vecino opaco más cercano (sin borde oscuro sobre fondos claros)."""
    solid = rgba[..., 3] > 0.97 * 255
    rgb = rgba[..., :3].copy()
    filled = solid.copy()
    h, w = filled.shape
    for _ in range(12):
        if filled.all():
            break
        pad, pf = np.pad(rgb, ((1, 1), (1, 1), (0, 0))), np.pad(filled, 1)
        acc, cnt = np.zeros_like(rgb), np.zeros(filled.shape)
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                if dy == 0 and dx == 0:
                    continue
                sl = pad[1 + dy : 1 + dy + h, 1 + dx : 1 + dx + w]
                fl = pf[1 + dy : 1 + dy + h, 1 + dx : 1 + dx + w]
                acc += sl * fl[..., None]
                cnt += fl
        new = (~filled) & (cnt > 0)
        rgb[new] = acc[new] / cnt[new][..., None]
        filled |= new
    rgb[solid] = rgba[..., :3][solid]
    return rgb


def black_to_alpha(im, lo=14, hi=150):
    a = np.asarray(im.convert("RGB")).astype(float)
    alpha = np.clip((a.max(axis=2) - lo) / (hi - lo), 0, 1) * 255
    rgba = np.dstack([a, alpha])
    rgba[..., :3] = fill_color_from_solid(rgba)
    out = Image.fromarray(np.clip(rgba, 0, 255).astype(np.uint8), "RGBA")
    x0, y0, x1, y1 = out.getchannel("A").point(lambda v: 255 if v > 8 else 0).getbbox()
    side, cx, cy = max(x1 - x0, y1 - y0), (x0 + x1) // 2, (y0 + y1) // 2
    return out.crop((cx - side // 2, cy - side // 2, cx - side // 2 + side, cy - side // 2 + side))


def bold_dollar(im, hole=530, fill=0.82):
    """Borra el $ naranja del master y dibuja uno mas grande y grueso, centrado en el agujero del anillo."""
    a = np.asarray(im.convert("RGB")).copy()
    r, g, b = [a[..., i].astype(float) for i in range(3)]
    m = (r > 150) & (g > 60) & (g < 180) & (b < 90) & (r > g * 1.3)
    ys, xs = np.where(m)
    cx, cy = (xs.min() + xs.max()) / 2, (ys.min() + ys.max()) / 2
    wipe = Image.fromarray((m * 255).astype(np.uint8)).filter(ImageFilter.MaxFilter(9))
    a[np.asarray(wipe) > 0] = 0
    base = Image.fromarray(a, "RGB")
    S, W = 4, im.size[0]
    layer = Image.new("L", (W * S, W * S), 0)
    ImageDraw.Draw(layer).text((cx * S, cy * S), "$", font=ImageFont.truetype(FONT, 600 * S), fill=255, anchor="mm", stroke_width=6 * S, stroke_fill=255)
    bb = layer.getbbox()
    k = fill * hole * S / (bb[3] - bb[1])
    g2 = layer.crop(bb)
    g2 = g2.resize((int(g2.width * k), int(g2.height * k)), Image.LANCZOS)
    full = Image.new("L", (W * S, W * S), 0)
    full.paste(g2, (int(cx * S - g2.width / 2), int(cy * S - g2.height / 2)))
    base.paste(Image.new("RGB", (W, W), ORANGE), (0, 0), full.resize((W, W), Image.LANCZOS))
    return base


def main():
    src, out, ver = sys.argv[1:4]
    im = Image.open(src).convert("RGB")
    if "--dollar" in sys.argv:
        im = bold_dollar(im)
    tab = black_to_alpha(im)
    rs = lambda n: tab.resize((n, n), Image.LANCZOS)
    rs(32).save(f"{out}/favicon-32.{ver}.png", optimize=True)
    rs(48).save(f"{out}/favicon.{ver}.ico", sizes=[(16, 16), (32, 32), (48, 48)], append_images=[rs(16), rs(32)])
    if "--png48" in sys.argv:
        rs(48).save(f"{out}/favicon-48.{ver}.png", optimize=True)


main()
