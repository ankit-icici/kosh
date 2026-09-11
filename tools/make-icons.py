#!/usr/bin/env python3
"""
Regenerate Kosh's app icons.

    python3 tools/make-icons.py

The mark is a rupee sign set in Cochin, in a vertical gold gradient on a
near-black ground. Requires Pillow and macOS system fonts; on another machine
point FONT at any serif that actually carries U+20B9 (Didot does not).
"""
from PIL import Image, ImageDraw, ImageFont
import os

SS = 4                                   # supersampling factor
FONT, FONT_INDEX = '/System/Library/Fonts/Supplemental/Cochin.ttc', 0
INK_TOP, INK_BOTTOM = (19, 19, 24), (9, 9, 13)
GOLD_TOP, GOLD_BOTTOM = (235, 206, 131), (168, 125, 50)
CORNER = 0.225                           # corner radius as a fraction of the side
GLYPH = 0.60                             # glyph height as a fraction of the side
GLYPH_MASKABLE = 0.46                    # smaller: maskable icons need a 20% safe zone
OUT = os.path.join(os.path.dirname(__file__), '..', 'icons')


def _lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))


def _vertical_gradient(size, top, bottom):
    img = Image.new('RGB', (size, size))
    d = ImageDraw.Draw(img)
    for y in range(size):
        d.line([(0, y), (size, y)], fill=_lerp(top, bottom, y / size))
    return img


def _glyph_mask(size, frac):
    font = ImageFont.truetype(FONT, int(size * frac), index=FONT_INDEX)
    mask = Image.new('L', (size, size), 0)
    d = ImageDraw.Draw(mask)
    box = d.textbbox((0, 0), '₹', font=font)
    w, h = box[2] - box[0], box[3] - box[1]
    d.text(((size - w) / 2 - box[0], (size - h) / 2 - box[1]), '₹', font=font, fill=255)
    return mask


def render(size, maskable=False, opaque=False):
    big = size * SS
    ground = _vertical_gradient(big, INK_TOP, INK_BOTTOM).convert('RGBA')

    if maskable or opaque:
        icon = ground                                  # full bleed; the OS supplies the mask
    else:
        corners = Image.new('L', (big, big), 0)
        ImageDraw.Draw(corners).rounded_rectangle(
            [0, 0, big - 1, big - 1], radius=int(big * CORNER), fill=255)
        icon = Image.new('RGBA', (big, big), (0, 0, 0, 0))
        icon.paste(ground, (0, 0), corners)

    gold = _vertical_gradient(big, GOLD_TOP, GOLD_BOTTOM).convert('RGBA')
    icon.paste(gold, (0, 0), _glyph_mask(big, GLYPH_MASKABLE if maskable else GLYPH))

    icon = icon.resize((size, size), Image.LANCZOS)
    return icon.convert('RGB') if opaque else icon


if __name__ == '__main__':
    os.makedirs(OUT, exist_ok=True)
    render(512).save(os.path.join(OUT, 'icon-512.png'))
    render(192).save(os.path.join(OUT, 'icon-192.png'))
    render(512, maskable=True).save(os.path.join(OUT, 'maskable-512.png'))
    render(180, maskable=True, opaque=True).save(os.path.join(OUT, 'apple-touch-icon.png'))
    print('wrote 4 icons to', os.path.normpath(OUT))
