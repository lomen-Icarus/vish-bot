"""Готовит кадры для ролика: source/frames → public/frames.

1. Снимает запечённые розовые рамки и круги с кадров 01–08 (их рисует видео).
2. Картинка дня на 01/02: «Воскресенье, 8 ноября, ВИШ-67-67» — карточка из кода
   бота (source/card-sunday-vish-67-67.png, см. render-card.mts), кнопки
   «◀ 07.11» и «09.11 ▶».
3. Кадр 03: «👥 Группа: ВИШ-67-67».
4. Подсказка в поле ввода на 01–10: «67-67, Иванова, матан, 15.10».

Запуск: python3 tools/prepare_frames.py   (из video/menu-tutorial)
Нужны numpy, Pillow и шрифт Inter (OTF) — путь в INTER_DIR.
"""
import os
import shutil
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFont

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from frameops import load, save, wallpaper_model  # noqa: E402
from remove_markers import clean_all  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'source', 'frames') + '/'
OUT = os.path.join(ROOT, 'public', 'frames') + '/'
CARD = os.path.join(ROOT, 'source', 'card-sunday-vish-67-67.png')
INTER_DIR = os.environ.get('INTER_DIR', '/usr/share/fonts/opentype/inter')

# Кнопка под сообщением = обои·K + C (подобрано по кадру 03, ошибка < 2 уровней)
BTN_K = np.array([0.584, 0.593, 0.612])
BTN_C = np.array([22.74, 33.39, 15.56])
NAVY = np.array([11.0, 16.0, 32.0])  # фон картинки расписания
SS = 4  # суперсэмплинг текста


def font(weight, size):
    return ImageFont.truetype(os.path.join(INTER_DIR, f'Inter-{weight}.otf'), size * SS)


def text_alpha(text, weight, size, origin, box):
    """Альфа текста (0..1) в прямоугольнике box=(x0,y0,x1,y1), origin — левый верх."""
    x0, y0, x1, y1 = box
    im = Image.new('L', ((x1 - x0) * SS, (y1 - y0) * SS), 0)
    ImageDraw.Draw(im).text(((origin[0] - x0) * SS, (origin[1] - y0) * SS), text,
                            font=font(weight, size), fill=255, anchor='lt')
    return np.asarray(im.resize((x1 - x0, y1 - y0), Image.LANCZOS)).astype(np.float64)[..., None] / 255.0


def wall_at(w10, model, ys, xs):
    """Обои: на кадре 10 они пустые в y≈300..1215 — там точные, ниже — модель."""
    exact = (ys >= 300) & (ys <= 1215)
    out = model(ys, xs)
    out[exact] = w10[ys[exact]][:, xs]
    return out


def retext_on_button(img, w10, model, box, text, weight, size, origin):
    """Стирает текст на кнопке в box и пишет новый белым."""
    x0, y0, x1, y1 = box
    ys, xs = np.arange(y0, y1), np.arange(x0, x1)
    bg = wall_at(w10, model, ys, xs) * BTN_K + BTN_C
    a = text_alpha(text, weight, size, origin, box)
    img[y0:y1, x0:x1] = bg * (1 - a) + 255.0 * a


def stretched_card():
    """Постер 1080×586 → 750×475 (как картинка в чате): добавляем фон в пустые места."""
    c = np.asarray(Image.open(CARD).convert('RGB')).astype(np.float64)
    pad = np.tile(NAVY, (49, c.shape[1], 1))
    c = np.concatenate([c[:250], pad, c[250:455], pad, c[455:]])  # 586 + 98 = 684
    im = Image.fromarray(np.clip(c + 0.5, 0, 255).astype(np.uint8)).resize((750, 475), Image.LANCZOS)
    return np.asarray(im).astype(np.float64)


def rounded_inside(h, w, r, inset):
    Y, X = np.mgrid[0:h, 0:w]
    ok = (X >= inset) & (X < w - inset) & (Y >= inset) & (Y < h - inset)
    for cx, cy in ((r, r), (w - 1 - r, r), (r, h - 1 - r), (w - 1 - r, h - 1 - r)):
        corner = ((X < r) if cx == r else (X > w - 1 - r)) & ((Y < r) if cy == r else (Y > h - 1 - r))
        ok &= ~corner | ((X - cx) ** 2 + (Y - cy) ** 2 <= (r - inset) ** 2)
    return ok


def put_card(img, card, top, clip_top):
    """Заменяет содержимое карточки (x 25..774, высота 475) от строки clip_top."""
    inside = rounded_inside(475, 750, 29, 2)  # края/углы — фон, оставляем исходные
    for cy in range(475):
        y = top + cy
        if y < clip_top or y >= img.shape[0]:
            continue
        row = inside[cy]
        img[y, 25:775][row] = card[cy][row]


def replace_placeholder(img, top):
    """«14-24, …» → «67-67, …»: цифры заново, остальное — исходные пиксели со сдвигом."""
    x0, x1, y0, y1 = 190, 660, top - 11, top + 39
    reg = img[y0:y1, x0:x1]
    a_old = np.clip((255.0 - reg.mean(-1, keepdims=True)) / (255.0 - 163.0), 0, 1)
    a_new = np.zeros_like(a_old)
    shift = 4  # «67-67» шире «14-24» на ~3.6 px
    cut = 284 - x0  # до запятой
    a_new[:, cut + shift:] = a_old[:, cut:x1 - x0 - shift]
    digits = text_alpha('67-67', 'Regular', 32.5, (196, top), (x0, y0, x0 + cut + shift, y1))
    a_new[:, :cut + shift] = np.maximum(a_new[:, :cut + shift], digits)
    img[y0:y1, x0:x1] = 255.0 - a_new * (255.0 - 163.0)


def main():
    os.makedirs(OUT, exist_ok=True)
    model = wallpaper_model(SRC)
    w10 = load(SRC + '10_final_clean.png')
    cleaned = clean_all(SRC, model)
    card = stretched_card()

    names = sorted(n for n in os.listdir(SRC) if n.endswith('.png'))
    for name in names:
        if name.startswith('00_'):
            shutil.copyfile(SRC + name, OUT + name)
            continue
        img = cleaned[name][0] if name in cleaned else load(SRC + name)

        if name.startswith('01_') or name.startswith('02_'):
            dy = 545 if name.startswith('01_') else 0  # на 01 сообщение ниже на 545 px
            # на 02 верх картинки уходит под плашку шага: видно только с y=420
            put_card(img, card, top=370 + dy, clip_top=420 if dy == 0 else 0)
            retext_on_button(img, w10, model, (193, 860 + dy, 274, 908 + dy), '07.11', 'SemiBold', 31.5, (197, 872 + dy))
            retext_on_button(img, w10, model, (525, 860 + dy, 606, 908 + dy), '09.11', 'SemiBold', 31.5, (529, 872 + dy))

        if name.startswith('03_'):
            # «Группа: ВИШ-14-24»: перерисовываем только «67-67» после «ВИШ-»
            box = (627, 1096, 740, 1140)
            x0, y0, x1, y1 = box
            ys, xs = np.arange(y0, y1), np.arange(x0, x1)
            bg = wall_at(w10, model, ys, xs) * BTN_K + BTN_C
            wide = (600, y0, x1, y1)
            a = text_alpha('ВИШ-67-67', 'SemiBold', 31, (540, 1107), wide)[:, x0 - 600:]
            img[y0:y1, x0:x1] = bg * (1 - a) + 255.0 * a

        top = 1499 if name[:2] in ('09', '10') else 1609
        replace_placeholder(img, top)
        save(img, OUT + name)
        print('ok', name)


if __name__ == '__main__':
    main()
