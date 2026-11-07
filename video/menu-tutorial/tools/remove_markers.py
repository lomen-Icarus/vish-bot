"""Убирает запечённые розовые рамки и круги («место нажатия») с кадров 01–08.

Обои Telegram привязаны к экрану, поэтому чистые пиксели берём с соседнего
кадра, где в тех же координатах та же кнопка без метки. Заменяются только
«розовые» пиксели (и немного вокруг) — значки ➕/✅ и тексты не трогаются.
"""
import numpy as np
from frameops import load

PINK = np.array([255.0, 59.0, 107.0])


def redness(a):
    return a[..., 0] - np.maximum(a[..., 1], a[..., 2])


def dilate(mask, r):
    out = mask.copy()
    for dy in range(-r, r + 1):
        for dx in range(-r, r + 1):
            if dx * dx + dy * dy > r * r:
                continue
            out |= np.roll(np.roll(mask, dy, 0), dx, 1)
    return out


def _dist_to_rect(shape, rect):
    h, w = shape[:2]
    Y, X = np.mgrid[0:h, 0:w]
    x0, y0, x1, y1 = rect
    dx = np.maximum(np.maximum(x0 - X, X - x1), 0)
    dy = np.maximum(np.maximum(y0 - Y, Y - y1), 0)
    inside = np.minimum(np.minimum(X - x0, x1 - X), np.minimum(Y - y0, y1 - Y))
    return np.where((dx > 0) | (dy > 0), np.hypot(dx, dy), inside), X, Y


def marker_mask(target, source, rect, circle, band=14, disc=66, grow=3, whole=False):
    """Пиксели метки.

    Рамка: полоса ±band вдоль контура, пиксель «порозовел» относительно донора
    и сам по себе розоватый (кнопки и обои — зеленоватые, redness≈−35).
    Круг: диск радиуса disc, достаточно небольшого «порозовения» (ореол слабый).
    Середина кнопки (значки ➕/✅, текст) в маску не попадает.
    """
    dist, X, Y = _dist_to_rect(target.shape, rect)
    ring = dist <= band
    cx, cy = circle
    in_disc = (X - cx) ** 2 + (Y - cy) ** 2 <= disc * disc
    if whole:  # донор совпадает с кадром во всей зоне метки — копируем её целиком
        return ring | in_disc
    diff = redness(target) - redness(source)
    m = (ring & (diff > 6) & (redness(target) > -25)) | (in_disc & (diff > 3))
    return dilate(m, grow) & (ring | in_disc)


def transfer(target_wall, source_px, source_wall, k_button):
    """Перенос пикселей с другой высоты: p = p_src + g·(W_dst − W_src).

    g — насколько пиксель «просвечивает» обои: 1 на голых обоях,
    k_button на кнопке, меньше на белом тексте поверх кнопки.
    """
    b_src = k_button[0] * source_wall + k_button[1]
    on_wall = np.abs(source_px - source_wall).mean(-1, keepdims=True) < 6
    text = np.clip((255 - source_px) / np.maximum(255 - b_src, 1), 0, 1)
    g = np.where(on_wall, 1.0, k_button[0] * text)
    return source_px + g * (target_wall - source_wall)


# Метки (с кадров): рамка x0,y0,x1,y1 по линиям розового, центр круга
MARKERS = {
    '01_start_tap_more.png': ((358, 1788, 721, 1906), (682, 1878)),
    '02_more_tap_settings.png': ((25, 1440, 338, 1545), (299, 1524)),
    '03_settings_tap_menu.png': ((25, 1388, 1054, 1479), (1016, 1446)),
    '04_menu_tap_buttons.png': ((25, 1388, 1054, 1479), (1016, 1446)),
    '05_buttons_0.png': ((534, 1000, 1054, 1091), (1018, 1058)),
    '06_buttons_1.png': ((25, 1078, 546, 1169), (506, 1138)),
    '07_buttons_2.png': ((534, 1078, 1054, 1169), (1018, 1134)),
    '08_buttons_3.png': ((25, 1388, 1054, 1479), (1016, 1446)),
}

# Донор: кадр, где в тех же координатах та же кнопка без метки
DONOR = {
    '01_start_tap_more.png': '02_more_tap_settings.png',   # та же клавиатура
    '03_settings_tap_menu.png': '07_buttons_2.png',        # строка 1400–1467 во всю ширину
    '04_menu_tap_buttons.png': '07_buttons_2.png',
    '05_buttons_0.png': '08_buttons_3.png',                # список на 05–08 на тех же местах
    '06_buttons_1.png': '08_buttons_3.png',
    '07_buttons_2.png': '08_buttons_3.png',
    '08_buttons_3.png': '07_buttons_2.png',
}

# Здесь донор совпадает с кадром во всей зоне метки (соседние ряды те же)
WHOLE = {'01_start_tap_more.png', '08_buttons_3.png'}

# 02: кнопка «Настройки» есть только тут; то же сообщение на кадре 03 выше на 744 px
TRANSFER_02 = dict(target='02_more_tap_settings.png', source='03_settings_tap_menu.png',
                   dy=744, box=(0, 1420, 380, 1566))


def clean_all(src_dir, wall_model):
    """Возвращает {имя: (массив, маска)} очищенных кадров 01–08."""
    names = set(MARKERS) | set(DONOR.values()) | {'10_final_clean.png'}
    frames = {n: load(src_dir + n) for n in names}
    out = {}
    for name, donor in DONOR.items():
        t = frames[name].copy()
        rect, circle = MARKERS[name]
        m = marker_mask(t, frames[donor], rect, circle, whole=name in WHOLE)
        t[m] = frames[donor][m]
        out[name] = (t, m)

    # 03/04: на 07 под «Готово» сразу кнопки (с 1477), а на 03/04 зазор до 1480;
    # над кнопкой на 07 кнопка до 1389, а на 03/04 зазор с 1387. В этих строках
    # кладём обои с ближайшей строки зазора донора.
    d = frames['07_buttons_2.png']
    for name in ('03_settings_tap_menu.png', '04_menu_tap_buttons.png'):
        t, m = out[name]
        for y, ys in ((1387, 1390), (1388, 1390), (1389, 1390), (1477, 1476), (1478, 1476), (1479, 1476)):
            row = m[y]
            t[y, row] = d[ys, row]
        # у донора под «Готово» зазор между «Как было | Назад» (x≈535..546),
        # с их скруглёнными углами (x≈508..580), а тут сплошная «Закрыть»/«Назад» —
        # берём верхний край кнопки левее
        for y in range(1476, 1496):
            for x in range(508, 580):
                if m[y, x]:
                    t[y, x] = t[y, x - 80]

    # 02: перенос с кадра 03 с поправкой на узор обоев
    spec = TRANSFER_02
    t = frames[spec['target']].copy()
    s = frames[spec['source']]
    x0, y0, x1, y1 = spec['box']
    ys = np.arange(y0, y1)
    xs = np.arange(x0, x1)
    src_px = s[ys - spec['dy']][:, xs]
    src_wall = frames['10_final_clean.png'][ys - spec['dy']][:, xs]  # там у кадра 10 пустые обои
    dst_wall = wall_model(ys, xs)                                     # модель обоев внизу экрана
    est = transfer(dst_wall, src_px, src_wall,
                   (np.array([0.584, 0.593, 0.612]), np.array([22.74, 33.39, 15.56])))
    # ниже кнопок (с 1548) на 02 только обои, а на доноре там край пузыря
    below = ys >= 1548
    est[below] = dst_wall[below]
    full = t.copy()
    full[y0:y1, x0:x1] = est
    rect, circle = MARKERS[spec['target']]
    m = marker_mask(t, full, rect, circle)
    t[m] = full[m]
    out[spec['target']] = (t, m)
    return out
