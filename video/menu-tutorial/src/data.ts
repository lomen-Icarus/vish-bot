// Координаты сняты с кадров 1080×1920 (public/frames/*.png, готовит
// tools/prepare_frames.py): кнопка, на которую жмут, и тёмная плашка шага.

export type Rect = { x: number; y: number; w: number; h: number };
export type Point = { x: number; y: number };

export type TapStepProps = {
  /** Файл кадра в public/frames */
  frame: string;
  /** Куда «нажимает» палец — правая часть кнопки, чтобы не закрыть подпись */
  tap: Point;
  /** Кнопка: рамка появляется при подлёте пальца, вспышка — при нажатии */
  button: Rect;
  /** Нижняя граница тёмной плашки шага (верх у всех — 300) */
  captionBottom: number;
  /** Длина сцены в кадрах (30 fps), включая 10 кадров перехода в конце */
  duration: number;
  /** Кнопка, сменившая ➕ на ✅ после прошлого шага — «поп» в начале сцены */
  pop: Rect | null;
};

export const SCREEN = { width: 1080, height: 1920 };
/** Шапка чата + «Закреплённое сообщение» — неподвижны при зуме финала */
export const HEADER_BOTTOM = 274;
export const CAPTION_TOP = 300;

// Кнопки под сообщением: поля 28 px; во всю ширину x 28–1049,
// в два столбца 28–529 и 550–1049 (замерено по очищенным кадрам).
const FULL = { x: 28, w: 1022 };
const LEFT = { x: 28, w: 502 };
const RIGHT = { x: 550, w: 500 };

export const STEPS: TapStepProps[] = [
  {
    // Шаг 1. Внизу жми «🗂 Ещё»
    frame: '01_start_tap_more.png',
    tap: { x: 640, y: 1866 },
    button: { x: 372, y: 1800, w: 336, h: 95 },
    captionBottom: 440,
    duration: 96,
    pop: null,
  },
  {
    // Шаг 2. Под сообщением — «⚙️ Настройки»
    frame: '02_more_tap_settings.png',
    tap: { x: 300, y: 1514 },
    button: { x: 28, y: 1452, w: 296, h: 93 },
    captionBottom: 400,
    duration: 76,
    pop: null,
  },
  {
    // Шаг 3. «⌨️ Нижнее меню»
    frame: '03_settings_tap_menu.png',
    tap: { x: 990, y: 1438 },
    button: { ...FULL, y: 1400, h: 68 },
    captionBottom: 440,
    duration: 76,
    pop: null,
  },
  {
    // Шаг 4. «🧩 Кнопки внизу»
    frame: '04_menu_tap_buttons.png',
    tap: { x: 990, y: 1438 },
    button: { ...FULL, y: 1400, h: 68 },
    captionBottom: 440,
    duration: 76,
    pop: null,
  },
  {
    // Шаг 5. Добавь «👥 Др. группы»
    frame: '05_buttons_0.png',
    tap: { x: 995, y: 1050 },
    button: { ...RIGHT, y: 1012, h: 68 },
    captionBottom: 440,
    duration: 76,
    pop: null,
  },
  {
    // Шаг 6. Добавь «👨‍🏫 Где препод»
    frame: '06_buttons_1.png',
    tap: { x: 475, y: 1127 },
    button: { ...LEFT, y: 1090, h: 67 },
    captionBottom: 560,
    duration: 76,
    pop: { ...RIGHT, y: 1012, h: 68 },
  },
  {
    // Шаг 7. Добавь «🎓 Поток»
    frame: '07_buttons_2.png',
    tap: { x: 995, y: 1127 },
    button: { ...RIGHT, y: 1090, h: 67 },
    captionBottom: 560,
    duration: 76,
    pop: { ...LEFT, y: 1090, h: 67 },
  },
  {
    // Шаг 8. «👌 Готово — обновить меню»
    frame: '08_buttons_3.png',
    tap: { x: 990, y: 1438 },
    button: { ...FULL, y: 1400, h: 68 },
    captionBottom: 560,
    duration: 76,
    pop: { ...RIGHT, y: 1090, h: 67 },
  },
];

/** Три новые кнопки в нижнем меню 3 × 3 на кадрах 09/10 */
export const NEW_MENU_BUTTONS: Rect[] = [
  { x: 367, y: 1687, w: 345, h: 101 }, // 👥 Др. группы
  { x: 722, y: 1687, w: 345, h: 101 }, // 👨‍🏫 Где препод
  { x: 12, y: 1797, w: 345, h: 101 }, // 🎓 Поток
];

/** Те же три кнопки на обложке */
export const COVER_NEW_BUTTONS: Rect[] = [
  { x: 391, y: 1223, w: 298, h: 104 },
  { x: 696, y: 1223, w: 298, h: 104 },
  { x: 86, y: 1333, w: 298, h: 104 },
];

/** Цвет фона нижнего меню Telegram на кадрах */
export const KEYBOARD_BG = 'rgb(231, 232, 235)';
