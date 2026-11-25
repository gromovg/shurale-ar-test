"""
Generate high-contrast, strictly asymmetric A4 matte printable Image Target
for 8th Wall WebAR ("Кышкы Әкият" — Шүрәле / Иннополис).

Design goals for maximum 8th Wall SLAM + Image Target stability (day, twilight, snow):
  - Exact 3:4 active tracking rectangle: 195.0 x 260.0 mm (19.5 x 26.0 cm)
    centered on standard A4 (210 x 297 mm) at 300 DPI (2480 x 3508 px).
  - High luminance contrast (works equally well on B&W laser or color inkjet printers).
  - Strictly asymmetric layout across all 4 quadrants (zero rotational/mirror ambiguity).
  - Dense multi-scale corners & edges distributed evenly across the entire 3:4 canvas
    (no large empty margins, no repetitive grids/checkerboards).
  - Print-ready A4 PDF + PNG with 100 mm calibration ruler bar in the bottom margin.
  - Exact 3:4 source PNG (1500 x 2000 px) for @8thwall/image-target-cli (zero auto-crop loss).
"""

import math
import os
import random
from PIL import Image, ImageDraw, ImageFont

OUT_DIR = os.path.join("targets", "shurale-a4")
os.makedirs(OUT_DIR, exist_ok=True)

# 300 DPI exact A4 dimensions (210 x 297 mm)
DPI = 300
MM_TO_PX = DPI / 25.4
A4_W_MM, A4_H_MM = 210.0, 297.0
A4_W_PX = round(A4_W_MM * MM_TO_PX)  # 2480
A4_H_PX = round(A4_H_MM * MM_TO_PX)  # 3508

# Exact 3:4 tracking rectangle: 195 x 260 mm
TARGET_W_MM, TARGET_H_MM = 195.0, 260.0
# Use exact integer multiple of 3:4 pixels closest to 195x260mm @ 300 DPI:
# 768 * 3 = 2304 px (195.07 mm), 768 * 4 = 3072 px (260.10 mm)
ART_W_PX = 2304
ART_H_PX = 3072

# High-luminance-contrast palette (tested to remain crisp in grayscale)
INK = (14, 24, 42)          # very dark midnight navy (lum ~21)
CHARCOAL = (24, 26, 30)     # deep black-slate (lum ~26)
PINE = (32, 74, 78)         # dark winter spruce (lum ~62)
CRIMSON = (194, 52, 42)     # warm festival red (lum ~92)
OCHRE = (214, 152, 42)      # bright amber accent (lum ~159)
ICE = (205, 224, 238)       # cool light snow-blue (lum ~220)
PAPER = (248, 249, 251)     # matte off-white (lum ~249)


def load_font(size: int, bold: bool = False):
    candidates = [
        r"C:\Windows\Fonts\arialbd.ttf" if bold else r"C:\Windows\Fonts\arial.ttf",
        r"C:\Windows\Fonts\segoeuib.ttf" if bold else r"C:\Windows\Fonts\segoeui.ttf",
        r"C:\Windows\Fonts\calibrib.ttf" if bold else r"C:\Windows\Fonts\calibri.ttf",
    ]
    for p in candidates:
        if os.path.exists(p):
            return ImageFont.truetype(p, size)
    return ImageFont.load_default()


def draw_poly_star(draw, cx, cy, r_outer, r_inner, points, angle_deg, fill, outline=None, width=1):
    pts = []
    for i in range(points * 2):
        r = r_outer if i % 2 == 0 else r_inner
        a = math.radians(angle_deg + i * (180.0 / points))
        pts.append((cx + r * math.cos(a), cy + r * math.sin(a)))
    draw.polygon(pts, fill=fill, outline=outline)
    if outline and width > 1:
        draw.line(pts + [pts[0]], fill=outline, width=width, joint="curve")


def draw_spruce_tree(draw, base_x, base_y, width, height, tiers, fill, highlight=None, skew=0.0):
    """Draw a jagged asymmetric winter spruce tree (rich multi-scale corner features)."""
    rng_local = random.Random(int(base_x * 13 + base_y * 7 + height))
    pts_left = []
    pts_right = []
    top_x = base_x + skew * width
    top_y = base_y - height

    for t in range(tiers):
        frac_top = t / tiers
        frac_bot = (t + 1) / tiers
        y_outer = top_y + frac_bot * (height * 0.86)
        y_inner = top_y + (frac_top + 0.72 / tiers) * (height * 0.86)
        half_w = (width * 0.5) * (0.24 + 0.76 * frac_bot)
        # Asymmetric branch lengths
        wl = half_w * rng_local.uniform(0.84, 1.15)
        wr = half_w * rng_local.uniform(0.84, 1.15)
        cx_tier = top_x + (base_x - top_x) * frac_bot
        pts_left.append((cx_tier - wl, y_outer + rng_local.uniform(-12, 12)))
        if t < tiers - 1:
            pts_left.append((cx_tier - wl * 0.42, y_inner))
        pts_right.append((cx_tier + wr, y_outer + rng_local.uniform(-12, 12)))
        if t < tiers - 1:
            pts_right.append((cx_tier + wr * 0.42, y_inner))

    trunk_w = width * 0.11
    poly = (
        [(top_x, top_y)]
        + pts_right
        + [(base_x + trunk_w, base_y - height * 0.14), (base_x + trunk_w, base_y)]
        + [(base_x - trunk_w, base_y), (base_x - trunk_w, base_y - height * 0.14)]
        + list(reversed(pts_left))
    )
    draw.polygon(poly, fill=fill)

    # Crisp snow cutouts on branches for extra high-contrast inner edges
    if highlight:
        for t in range(1, tiers):
            frac = t / tiers
            y_b = top_y + frac * (height * 0.84)
            cx_t = top_x + (base_x - top_x) * frac
            hw = width * 0.34 * frac
            snow_poly = [
                (cx_t - hw * 0.9, y_b - 6),
                (cx_t - hw * 0.15, y_b - 26),
                (cx_t + hw * 0.45, y_b - 10),
                (cx_t + hw * 0.1, y_b + 8),
                (cx_t - hw * 0.55, y_b + 4),
            ]
            draw.polygon(snow_poly, fill=highlight)


def draw_tatar_tulip(draw, cx, cy, scale, angle_deg, fill_main, fill_inner, fill_accent):
    """Draw a stylized asymmetric Tatar tulip ornament with sharp crisp corners."""
    def rot(x, y):
        a = math.radians(angle_deg)
        return (
            cx + (x * math.cos(a) - y * math.sin(a)) * scale,
            cy + (x * math.sin(a) + y * math.cos(a)) * scale,
        )

    outer = [
        rot(0, -110), rot(26, -65), rot(78, -92), rot(96, -24),
        rot(62, 46), rot(24, 72), rot(38, 108), rot(0, 92),
        rot(-34, 112), rot(-22, 70), rot(-68, 42), rot(-92, -32),
        rot(-64, -84), rot(-24, -56),
    ]
    draw.polygon(outer, fill=fill_main)

    inner = [
        rot(0, -68), rot(28, -28), rot(54, -46), rot(44, 16),
        rot(12, 44), rot(-16, 40), rot(-48, 8), rot(-46, -42), rot(-20, -24),
    ]
    draw.polygon(inner, fill=fill_inner)

    core = [rot(0, -34), rot(22, -4), rot(6, 26), rot(-20, 4)]
    draw.polygon(core, fill=fill_accent)


def draw_shurale_emblem(draw, cx, cy, s):
    """Draw bold asymmetric stylized Shurale head/horn/foliage folklore emblem."""
    def pt(x, y):
        return (cx + x * s, cy + y * s)

    # Dark jagged backdrop crest (asymmetric shield-leaf)
    crest = [
        pt(-290, -240), pt(-140, -320), pt(30, -295), pt(210, -340),
        pt(320, -170), pt(285, 40), pt(335, 195), pt(160, 315),
        pt(-25, 290), pt(-225, 330), pt(-325, 165), pt(-275, -45),
    ]
    draw.polygon(crest, fill=INK)

    # Inner high-contrast cutout halo (asymmetric facets)
    halo = [
        pt(-235, -185), pt(-95, -260), pt(75, -245), pt(225, -265),
        pt(265, -95), pt(230, 80), pt(250, 215), pt(90, 255),
        pt(-80, 235), pt(-235, 250), pt(-255, 95), pt(-215, -70),
    ]
    draw.polygon(halo, fill=PAPER)

    # Shurale characteristic single curved forehead horn (tilted right — strong asymmetry!)
    horn = [
        pt(-15, -110), pt(48, -245), pt(112, -290), pt(92, -210),
        pt(62, -145), pt(38, -88),
    ]
    draw.polygon(horn, fill=CRIMSON, outline=INK)
    # Horn notches (white triangles)
    draw.polygon([pt(28, -175), pt(68, -195), pt(48, -155)], fill=PAPER)
    draw.polygon([pt(52, -225), pt(90, -242), pt(74, -208)], fill=PAPER)

    # Asymmetric pointy woodland ears (left higher, right wider with notch)
    ear_l = [pt(-110, -75), pt(-245, -160), pt(-210, -55), pt(-165, -20), pt(-105, 5)]
    ear_r = [pt(105, -60), pt(245, -110), pt(235, -25), pt(185, 15), pt(110, 20)]
    draw.polygon(ear_l, fill=INK)
    draw.polygon(ear_r, fill=PINE)
    draw.polygon([pt(-130, -65), pt(-205, -120), pt(-180, -55), pt(-125, -25)], fill=ICE)
    draw.polygon([pt(125, -45), pt(210, -80), pt(200, -30), pt(130, -5)], fill=PAPER)

    # Stylized angular Shurale face + beard/leaf ruff
    face = [
        pt(-115, -95), pt(-40, -135), pt(55, -125), pt(120, -75),
        pt(130, 40), pt(85, 145), pt(10, 195), pt(-75, 165),
        pt(-125, 75),
    ]
    draw.polygon(face, fill=INK)

    # Bright facial mask & expressive asymmetric features
    mask = [
        pt(-90, -55), pt(-25, -95), pt(65, -80), pt(98, -25),
        pt(90, 60), pt(45, 120), pt(-15, 140), pt(-72, 105), pt(-95, 25),
    ]
    draw.polygon(mask, fill=PAPER)

    # Asymmetric furrowed brows + mischievous eyes
    draw.polygon([pt(-75, -48), pt(-12, -32), pt(-18, -14), pt(-80, -30)], fill=INK)
    draw.polygon([pt(14, -40), pt(82, -62), pt(86, -42), pt(22, -20)], fill=INK)
    # Eyes (diamond left, wide kite right)
    draw.polygon([pt(-68, -12), pt(-40, -26), pt(-16, -8), pt(-42, 12)], fill=INK)
    draw.polygon([pt(-46, -12), pt(-34, -18), pt(-30, -6), pt(-42, -2)], fill=PAPER)
    draw.polygon([pt(20, -10), pt(52, -32), pt(80, -10), pt(48, 12)], fill=INK)
    draw.polygon([pt(46, -14), pt(60, -20), pt(62, -6), pt(48, -2)], fill=PAPER)

    # Angular nose + cheerful asymmetric grin
    draw.polygon([pt(-8, -12), pt(12, -16), pt(22, 34), pt(-18, 38)], fill=PINE)
    draw.polygon([pt(-58, 55), pt(-10, 72), pt(58, 48), pt(45, 92), pt(-4, 108), pt(-48, 88)], fill=INK)
    # Crisp teeth notches in grin
    draw.polygon([pt(-36, 64), pt(-18, 69), pt(-24, 84)], fill=PAPER)
    draw.polygon([pt(4, 68), pt(24, 62), pt(18, 82)], fill=PAPER)
    draw.polygon([pt(30, 58), pt(46, 53), pt(40, 72)], fill=PAPER)

    # Winter leafy beard / woodland twig collar (bottom asymmetric spikes)
    collar = [
        pt(-150, 120), pt(-95, 225), pt(-55, 170), pt(-15, 245),
        pt(30, 175), pt(75, 240), pt(120, 155), pt(175, 195),
        pt(140, 105), pt(80, 145), pt(10, 175), pt(-80, 155),
    ]
    draw.polygon(collar, fill=PINE)
    draw.polygon([pt(-95, 225), pt(-70, 185), pt(-55, 210)], fill=PAPER)
    draw.polygon([pt(30, 188), pt(68, 228), pt(85, 180)], fill=OCHRE)


def draw_corner_fiducials(draw, W, H):
    """4 completely unique high-contrast corner fiducial zones (zero rotational ambiguity)."""
    m = 54  # inner border padding

    # 1. TOP-LEFT: Heavy notched L-bracket + 3 asymmetric black/white stepped bars + crimson triangle
    draw.polygon([
        (m, m), (m + 340, m), (m + 295, m + 68), (m + 108, m + 68),
        (m + 108, m + 295), (m, m + 345)
    ], fill=INK)
    draw.rectangle([m + 135, m + 95, m + 265, m + 150], fill=CRIMSON)
    draw.polygon([(m + 135, m + 175), (m + 235, m + 175), (m + 135, m + 275)], fill=INK)
    draw.polygon([(m + 155, m + 195), (m + 205, m + 195), (m + 155, m + 245)], fill=PAPER)
    draw_poly_star(draw, m + 290, m + 205, 52, 22, 5, 18, INK)
    draw_poly_star(draw, m + 290, m + 205, 22, 10, 5, 54, PAPER)

    # 2. TOP-RIGHT: Stepped diagonal chevron block + ringed target + asymmetric wedge
    rx = W - m
    draw.polygon([
        (rx - 360, m), (rx, m), (rx, m + 360), (rx - 86, m + 310),
        (rx - 86, m + 92), (rx - 310, m + 92)
    ], fill=CHARCOAL)
    # High-contrast stepped blocks inside top-right
    draw.polygon([(rx - 280, m + 115), (rx - 120, m + 115), (rx - 120, m + 210), (rx - 210, m + 210)], fill=PINE)
    draw.ellipse([rx - 260, m + 195, rx - 115, m + 340], fill=INK)
    draw.ellipse([rx - 235, m + 220, rx - 140, m + 315], fill=PAPER)
    draw.polygon([(rx - 210, m + 245), (rx - 165, m + 245), (rx - 188, m + 295)], fill=CRIMSON)
    draw.rectangle([rx - 355, m + 120, rx - 300, m + 225], fill=INK)
    draw.rectangle([rx - 340, m + 140, rx - 315, m + 180], fill=PAPER)

    # 3. BOTTOM-LEFT: Bold asymmetric Tatar star-diamond + striped wedge + tulip accent
    by = H - m
    draw.polygon([
        (m, by - 350), (m + 95, by - 285), (m + 95, by - 95),
        (m + 350, by - 95), (m + 390, by), (m, by)
    ], fill=INK)
    draw_poly_star(draw, m + 215, by - 225, 102, 46, 8, 12, INK)
    draw_poly_star(draw, m + 215, by - 225, 62, 26, 8, 34, PAPER)
    draw_poly_star(draw, m + 215, by - 225, 28, 12, 4, 0, CRIMSON)
    draw.polygon([(m + 335, by - 240), (m + 445, by - 140), (m + 335, by - 115)], fill=PINE)

    # 4. BOTTOM-RIGHT: Asymmetric hex badge "01" + notched frame + contrast slashes
    draw.polygon([
        (rx - 410, by - 95), (rx - 95, by - 95), (rx - 95, by - 365),
        (rx, by - 320), (rx, by), (rx - 370, by)
    ], fill=CHARCOAL)
    hex_pts = [
        (rx - 315, by - 295), (rx - 170, by - 325), (rx - 115, by - 220),
        (rx - 155, by - 118), (rx - 305, by - 118), (rx - 365, by - 210),
    ]
    draw.polygon(hex_pts, fill=CRIMSON, outline=INK)
    draw.line(hex_pts + [hex_pts[0]], fill=INK, width=14)
    f_badge = load_font(128, bold=True)
    draw.text((rx - 302, by - 282), "01", fill=PAPER, font=f_badge)
    # Asymmetric diagonal contrast bars beside badge
    for k in range(3):
        x0 = rx - 465 + k * 34
        draw.polygon([
            (x0, by - 135), (x0 + 22, by - 135),
            (x0 + 62, by - 255 - k * 16), (x0 + 40, by - 255 - k * 16)
        ], fill=INK if k != 1 else PINE)


def draw_innopolis_skyline(draw, W, H):
    """Asymmetric stylized Innopolis winter skyline + snow ridges in lower band."""
    base_y = H - 155
    # Snow ridge backdrop (light ice contrast against white & dark buildings)
    ridge = [
        (54, base_y - 120), (340, base_y - 235), (690, base_y - 145),
        (1080, base_y - 265), (1540, base_y - 170), (1910, base_y - 250),
        (W - 54, base_y - 130), (W - 54, base_y), (54, base_y),
    ]
    draw.polygon(ridge, fill=ICE)
    draw.line(ridge[:7], fill=INK, width=10)

    # Stylized asymmetric buildings (Popov Tech Park faceted ring + University angled wing)
    # Left angled university facade
    draw.polygon([
        (480, base_y), (480, base_y - 270), (630, base_y - 340),
        (790, base_y - 290), (790, base_y)
    ], fill=INK)
    # Window slits (varied sizes so non-repetitive!)
    windows_l = [
        (510, base_y - 245, 575, base_y - 195),
        (595, base_y - 270, 675, base_y - 210),
        (695, base_y - 255, 760, base_y - 180),
        (515, base_y - 165, 625, base_y - 115),
        (650, base_y - 150, 755, base_y - 85),
    ]
    for box in windows_l:
        draw.rectangle(box, fill=PAPER)

    # Center-right faceted Popov dome / tech cylinder
    dome_pts = [
        (940, base_y), (915, base_y - 165), (1035, base_y - 275),
        (1245, base_y - 295), (1410, base_y - 215), (1440, base_y - 75),
        (1395, base_y),
    ]
    draw.polygon(dome_pts, fill=PINE, outline=INK)
    draw.line(dome_pts + [dome_pts[0]], fill=INK, width=10)
    # Faceted interior triangles (high-contrast asymmetric shards)
    draw.polygon([(970, base_y - 155), (1075, base_y - 240), (1120, base_y - 125)], fill=PAPER)
    draw.polygon([(1140, base_y - 250), (1285, base_y - 245), (1215, base_y - 115)], fill=INK)
    draw.polygon([(1265, base_y - 195), (1385, base_y - 195), (1345, base_y - 90)], fill=PAPER)
    draw.polygon([(1020, base_y - 95), (1180, base_y - 95), (1110, base_y - 25)], fill=OCHRE)

    # Far-right angular tower
    draw.polygon([
        (1510, base_y), (1535, base_y - 315), (1710, base_y - 375),
        (1775, base_y - 240), (1755, base_y)
    ], fill=CHARCOAL)
    draw.polygon([(1565, base_y - 285), (1685, base_y - 330), (1695, base_y - 235), (1560, base_y - 205)], fill=PAPER)
    draw.polygon([(1565, base_y - 175), (1725, base_y - 195), (1715, base_y - 120)], fill=CRIMSON)


def draw_scattered_features(draw, W, H):
    """Distribute rich asymmetric multi-scale geometric/winter features across every quadrant."""
    rng = random.Random(20261125)

    # Diagonal dynamic contour ribbons (breaks up empty background into strong edges)
    ribbons = [
        [(60, 740), (540, 520), (880, 610), (510, 665), (60, 845)],
        [(1420, 640), (1920, 490), (2245, 620), (2245, 705), (1895, 585), (1460, 715)],
        [(60, 1940), (490, 1790), (770, 1905), (460, 1920), (60, 2060)],
        [(1580, 1890), (2245, 1690), (2245, 1785), (1640, 1975)],
    ]
    for i, r in enumerate(ribbons):
        draw.polygon(r, fill=ICE if i % 2 == 0 else PINE)
        draw.line(r + [r[0]], fill=INK, width=7)

    # Unique stylized asymmetric snowflakes / ice shards in varied locations
    shards = [
        (560, 435, 78, 5, 14, INK, PAPER),
        (1140, 430, 66, 7, 29, PINE, PAPER),
        (1650, 435, 74, 6, 41, INK, OCHRE),
        (285, 1180, 88, 7, 8, INK, PAPER),
        (2025, 1080, 84, 5, 33, CRIMSON, PAPER),
        (330, 2240, 78, 6, 19, PINE, PAPER),
        (1990, 2080, 92, 7, 52, INK, PAPER),
        (1280, 2320, 72, 5, 71, INK, ICE),
        (1620, 2410, 64, 7, 23, CRIMSON, PAPER),
    ]
    for cx, cy, r, pts, ang, c1, c2 in shards:
        draw_poly_star(draw, cx, cy, r, r * 0.42, pts, ang, c1)
        draw_poly_star(draw, cx, cy, r * 0.48, r * 0.2, pts, ang + 180 / pts, c2)

    # Asymmetric Tatar tulips in 3 distinct spots (different angles, scales, colors)
    draw_tatar_tulip(draw, 355, 895, 1.35, -24, INK, PAPER, CRIMSON)
    draw_tatar_tulip(draw, 1945, 1495, 1.45, 31, PINE, PAPER, INK)
    draw_tatar_tulip(draw, 745, 2210, 1.15, 14, CRIMSON, PAPER, INK)

    # Clusters of crisp asymmetric triangles / diamonds / pine needles in mid-zones
    zones = [
        (140, 440, 760, 760),
        (1520, 420, 2180, 900),
        (120, 1340, 620, 1840),
        (1700, 1680, 2190, 2380),
        (640, 2020, 1660, 2500),
        (780, 410, 1520, 690),
        (140, 2160, 640, 2560),
    ]
    palette = [INK, CHARCOAL, PINE, CRIMSON, OCHRE]
    for x0, y0, x1, y1 in zones:
        for _ in range(18):
            px = rng.randint(x0, x1)
            py = rng.randint(y0, y1)
            sz = rng.randint(22, 62)
            ang = rng.uniform(0, 360)
            sides = rng.choice([3, 4, 5])
            col = rng.choice(palette)
            pts = []
            for k in range(sides):
                a = math.radians(ang + k * (360.0 / sides) + rng.uniform(-18, 18))
                rad = sz * rng.uniform(0.65, 1.18)
                pts.append((px + rad * math.cos(a), py + rad * math.sin(a)))
            draw.polygon(pts, fill=col)
            # Inner white cutout on larger shapes for sharp double edges
            if sz >= 42:
                pts_in = [(px + (vx - px) * 0.42, py + (vy - py) * 0.42) for vx, vy in pts]
                draw.polygon(pts_in, fill=PAPER)


def build_tracking_artwork() -> Image.Image:
    W, H = ART_W_PX, ART_H_PX
    img = Image.new("RGB", (W, H), PAPER)
    draw = ImageDraw.Draw(img)

    # Outer crisp tracking frame (defines exact 195 x 260 mm physical boundary)
    draw.rectangle([0, 0, W - 1, H - 1], outline=INK, width=22)

    # Asymmetric border tick marks (unique spacing on each edge — strong perimeter features!)
    for i, frac in enumerate([0.19, 0.31, 0.47, 0.62, 0.78]):
        x = int(W * frac)
        h_tick = 32 if i % 2 == 0 else 50
        draw.rectangle([x - 10, 22, x + 10, 22 + h_tick], fill=INK)
    for i, frac in enumerate([0.23, 0.41, 0.56, 0.74, 0.85]):
        x = int(W * frac)
        h_tick = 46 if i % 2 == 0 else 28
        draw.rectangle([x - 12, H - 22 - h_tick, x + 12, H - 22], fill=INK)
    for i, frac in enumerate([0.16, 0.29, 0.44, 0.61, 0.79]):
        y = int(H * frac)
        w_tick = 44 if i % 2 == 0 else 26
        draw.rectangle([22, y - 10, 22 + w_tick, y + 10], fill=INK)
    for i, frac in enumerate([0.21, 0.38, 0.53, 0.68, 0.83]):
        y = int(H * frac)
        w_tick = 28 if i % 2 == 0 else 48
        draw.rectangle([W - 22 - w_tick, y - 12, W - 22, y + 12], fill=INK)

    # Scattered multi-scale background features across all zones
    draw_scattered_features(draw, W, H)

    # Asymmetric winter spruce forest (left & upper-right clusters of varied heights)
    draw_spruce_tree(draw, 255, 1980, 340, 620, 6, INK, highlight=PAPER, skew=-0.06)
    draw_spruce_tree(draw, 485, 2050, 270, 480, 5, PINE, highlight=ICE, skew=0.05)
    draw_spruce_tree(draw, 1995, 1290, 310, 570, 6, INK, highlight=PAPER, skew=0.07)
    draw_spruce_tree(draw, 1780, 1220, 230, 410, 5, PINE, highlight=PAPER, skew=-0.04)

    # Bold central hero emblem: Shurale folklore mask + horn (slightly off-center for asymmetry!)
    draw_shurale_emblem(draw, W * 0.515, H * 0.455, s=1.68)

    # Top title banner inside the tracked canvas (asymmetric dark slab + bold high-contrast typography)
    banner_top = [
        (430, 88), (1865, 88), (1825, 245), (470, 265)
    ]
    draw.polygon(banner_top, fill=INK)
    draw.polygon([(450, 268), (1190, 254), (1165, 345), (495, 345)], fill=CRIMSON)
    draw.polygon([(1225, 254), (1815, 248), (1785, 338), (1205, 345)], fill=PINE)

    f_title = load_font(112, bold=True)
    f_sub = load_font(62, bold=True)
    draw.text((515, 114), "КЫШКЫ ӘКИЯТ", fill=PAPER, font=f_title)
    draw.text((535, 270), "ШУРАЛЕ • AR", fill=PAPER, font=f_sub)
    draw.text((1265, 266), "ИННОПОЛИС", fill=PAPER, font=f_sub)

    # Lower band: Innopolis winter skyline + snow ridges
    draw_innopolis_skyline(draw, W, H)

    # Bottom caption strip above bottom fiducials
    draw.polygon([(475, H - 148), (1770, H - 148), (1740, H - 64), (505, H - 64)], fill=INK)
    f_cap = load_font(54, bold=True)
    draw.text((545, H - 134), "ТОЧКА 01  •  НАВЕДИ КАМЕРУ  •  195×260 ММ", fill=PAPER, font=f_cap)

    # 4 unique high-contrast corner fiducials
    draw_corner_fiducials(draw, W, H)

    return img


def build_a4_print_sheet(artwork: Image.Image) -> Image.Image:
    sheet = Image.new("RGB", (A4_W_PX, A4_H_PX), (255, 255, 255))
    draw = ImageDraw.Draw(sheet)

    x0 = (A4_W_PX - ART_W_PX) // 2  # ~88 px (~7.5 mm)
    y0 = (A4_H_PX - ART_H_PX) // 2  # ~218 px (~18.5 mm)

    sheet.paste(artwork, (x0, y0))

    # Crisp corner crop/measurement marks outside the 195 x 260 mm rectangle
    mark_len = 48
    gap = 14
    x1 = x0 + ART_W_PX - 1
    y1 = y0 + ART_H_PX - 1
    for cx, sx in [(x0, -1), (x1, 1)]:
        for cy, sy in [(y0, -1), (y1, 1)]:
            draw.line([(cx + sx * gap, cy), (cx + sx * (gap + mark_len), cy)], fill=(40, 40, 40), width=3)
            draw.line([(cx, cy + sy * gap), (cx, cy + sy * (gap + mark_len))], fill=(40, 40, 40), width=3)

    # Top print instruction (inside top 18.5 mm margin)
    f_hdr = load_font(34, bold=True)
    f_small = load_font(28, bold=False)
    draw.text(
        (x0, 72),
        "КЫШКЫ ӘКИЯТ • AR-ТЕСТ ТАБЛИЧКА #01 (8th Wall Image Target)",
        fill=(20, 20, 20),
        font=f_hdr,
    )
    draw.text(
        (x0, 122),
        "Печать: A4, масштаб 100% (Без масштабирования), обычная МАТОВАЯ бумага (без файла и ламинации), наклеить на картон.",
        fill=(60, 60, 60),
        font=f_small,
    )

    # Bottom margin: exact 100 mm calibration ruler + width check note
    ry = y1 + 58
    ruler_100mm_px = round(100.0 * MM_TO_PX)  # 1181 px
    rx0 = x0
    rx1 = rx0 + ruler_100mm_px
    draw.rectangle([rx0, ry, rx1, ry + 26], outline=(20, 20, 20), width=3)
    # 10 mm alternating segments
    for cm in range(10):
        sx0 = rx0 + round(cm * 10.0 * MM_TO_PX)
        sx1 = rx0 + round((cm + 1) * 10.0 * MM_TO_PX)
        if cm % 2 == 0:
            draw.rectangle([sx0, ry, sx1, ry + 26], fill=(20, 20, 20))
    draw.text((rx0, ry + 34), "0", fill=(20, 20, 20), font=f_small)
    draw.text((rx0 + ruler_100mm_px // 2 - 28, ry + 34), "50 мм", fill=(20, 20, 20), font=f_small)
    draw.text((rx1 - 80, ry + 34), "100 мм", fill=(20, 20, 20), font=f_small)

    draw.text(
        (rx1 + 44, ry - 4),
        "Контрольная линейка 100 мм",
        fill=(20, 20, 20),
        font=f_hdr,
    )
    draw.text(
        (rx1 + 44, ry + 36),
        "Рамка трекинга: 195 × 260 мм (3:4). Замерьте ширину рулеткой!",
        fill=(55, 55, 55),
        font=f_small,
    )

    return sheet


def main():
    artwork = build_tracking_artwork()

    # 1. Save exact 3:4 source image (1500 x 2000 px <= 2048px max per 8th Wall spec)
    source_3x4 = artwork.resize((1500, 2000), Image.Resampling.LANCZOS)
    src_path = os.path.join(OUT_DIR, "shurale-a4-source-3x4.png")
    source_3x4.save(src_path, dpi=(DPI, DPI))
    print(f"Saved 8th Wall source (1500x2000, exact 3:4): {src_path}")

    # 2. Build & save print-ready A4 PNG + PDF (exact 300 DPI -> 210 x 297 mm)
    a4_sheet = build_a4_print_sheet(artwork)
    png_path = os.path.join(OUT_DIR, "shurale-a4-print.png")
    pdf_path = os.path.join(OUT_DIR, "shurale-a4-print.pdf")
    a4_sheet.save(png_path, dpi=(DPI, DPI))
    a4_sheet.save(pdf_path, "PDF", resolution=float(DPI))
    print(f"Saved printable A4 PNG (2480x3508 @ 300 DPI): {png_path}")
    print(f"Saved printable A4 PDF (210x297 mm, 195x260 mm target): {pdf_path}")


if __name__ == "__main__":
    main()
