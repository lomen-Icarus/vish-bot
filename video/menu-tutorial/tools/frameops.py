"""Общие функции для подготовки кадров: модель обоев Telegram и переносы."""
import numpy as np
from PIL import Image

PERIOD = 326          # узор обоев повторяется по вертикали каждые 326 px
HP_Y0 = 430           # окно [HP_Y0, HP_Y0+PERIOD) берём с чистого кадра 10
K = 41                # размер окна сглаживания для «низких частот» (градиента)


def load(path):
    return np.asarray(Image.open(path).convert('RGB')).astype(np.float64)


def save(arr, path):
    Image.fromarray(np.clip(arr + 0.5, 0, 255).astype(np.uint8)).save(path, optimize=True)


def box_blur(a, k=K):
    """Скользящее среднее k×k (по каналам), края — повтор."""
    if a.ndim == 2:
        a = a[..., None]
    p = np.pad(a, ((k, k), (k, k), (0, 0)), mode='edge')
    c = np.cumsum(np.cumsum(p, 0), 1)
    c = np.pad(c, ((1, 0), (1, 0), (0, 0)))
    h, w = a.shape[:2]
    r = k // 2
    y0 = np.arange(h) + k - r
    x0 = np.arange(w) + k - r
    y1 = y0 + k
    x1 = x0 + k
    s = c[y1][:, x1] - c[y0][:, x1] - c[y1][:, x0] + c[y0][:, x0]
    return s / (k * k)


class Wallpaper:
    """Высокочастотный узор обоев (точки) с кадра 10, периодический по y."""

    def __init__(self, clean10):
        hp = clean10 - box_blur(clean10)
        self.hp = hp  # валиден в зоне пустых обоев кадра 10 (y≈300..1200)

    def pattern(self, ys, xs):
        ym = HP_Y0 + np.mod(np.asarray(ys) - HP_Y0, PERIOD)
        return self.hp[ym][:, xs]


def fit_lowpass(clean10_lp, ys, xs):
    """Квадратичный градиент обоев по зоне пустых обоев кадра 10."""
    Y, X = np.meshgrid(ys, xs, indexing='ij')
    A = np.stack([np.ones_like(X), X, Y, X * X, X * Y, Y * Y], -1).reshape(-1, 6) / 1.0
    coefs = []
    for ch in range(3):
        b = clean10_lp[ys][:, xs, ch].reshape(-1)
        coefs.append(np.linalg.lstsq(A, b, rcond=None)[0])
    return np.array(coefs)


def eval_lowpass(coefs, ys, xs):
    Y, X = np.meshgrid(ys, xs, indexing='ij')
    A = np.stack([np.ones_like(X), X, Y, X * X, X * Y, Y * Y], -1).astype(np.float64)
    return np.stack([A @ coefs[ch] for ch in range(3)], -1)


def _basis(Y, X):
    y = Y / 1920.0
    x = X / 1080.0
    return np.stack([np.ones_like(x), x, y, x * x, x * y, y * y, x ** 3, x * x * y, x * y * y, y ** 3], -1)


def wallpaper_model(src_dir):
    """W(ys, xs): градиент (кубический, по пустым участкам обоев) + периодический узор."""
    names = ['01_start_tap_more.png', '02_more_tap_settings.png', '09_result.png', '10_final_clean.png']
    fr = {n: load(src_dir + n) for n in names}
    wp = Wallpaper(fr['10_final_clean.png'])
    samples = [
        ('10_final_clean.png', np.arange(320, 1190, 3), np.arange(10, 1070, 3)),
        ('01_start_tap_more.png', np.arange(1400, 1560, 2), np.arange(790, 1070, 3)),
        ('01_start_tap_more.png', np.arange(1000, 1560, 2), np.arange(2, 22, 2)),
        ('02_more_tap_settings.png', np.arange(1300, 1560, 2), np.arange(660, 1070, 3)),
        ('09_result.png', np.arange(1439, 1452), np.arange(2, 1078, 2)),
    ]
    As, Bs = [], []
    for n, ys, xs in samples:
        Y, X = np.meshgrid(ys, xs, indexing='ij')
        As.append(_basis(Y, X).reshape(-1, 10))
        Bs.append((fr[n][ys][:, xs] - wp.pattern(ys, xs)).reshape(-1, 3))
    co = np.linalg.lstsq(np.concatenate(As), np.concatenate(Bs), rcond=None)[0]

    def W(ys, xs):
        Y, X = np.meshgrid(ys, xs, indexing='ij')
        return _basis(Y.astype(float), X.astype(float)) @ co + wp.pattern(ys, xs)

    return W
