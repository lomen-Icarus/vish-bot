// Координаты сняты с кадров 1080×1920 (public/frames/*.png):
// розовая рамка/круг — место нажатия, тёмная плашка — подпись шага.

export type Rect = { x: number; y: number; w: number; h: number };
export type Point = { x: number; y: number };

export type TapStepProps = {
  /** Файл кадра в public/frames */
  frame: string;
  /** Центр запечённого розового круга — сюда «нажимает» палец */
  tap: Point;
  /** Кнопка, которая вспыхивает при нажатии */
  button: Rect;
  /** Нижняя граница тёмной плашки шага (верх у всех — 300) */
  captionBottom: number;
  /** Во сколько раз приближать к месту нажатия */
  zoom: number;
  /** Кнопка, сменившая ➕ на ✅ после прошлого шага — «поп» в начале сцены */
  pop: Rect | null;
};

export const SCREEN = { width: 1080, height: 1920 };
/** Шапка чата + «Закреплённое сообщение» — неподвижны при зуме */
export const HEADER_BOTTOM = 274;
export const CAPTION_TOP = 300;

export const STEPS: TapStepProps[] = [
  {
    // Шаг 1. Внизу жми «🗂 Ещё»
    frame: '01_start_tap_more.png',
    tap: { x: 682, y: 1878 },
    button: { x: 370, y: 1800, w: 340, h: 96 },
    captionBottom: 440,
    zoom: 1.25,
    pop: null,
  },
  {
    // Шаг 2. Под сообщением — «⚙️ Настройки»
    frame: '02_more_tap_settings.png',
    tap: { x: 299, y: 1524 },
    button: { x: 27, y: 1452, w: 304, h: 92 },
    captionBottom: 400,
    zoom: 1.25,
    pop: null,
  },
  {
    // Шаг 3. «⌨️ Нижнее меню»
    frame: '03_settings_tap_menu.png',
    tap: { x: 1016, y: 1446 },
    button: { x: 27, y: 1398, w: 1028, h: 68 },
    captionBottom: 440,
    zoom: 1.2,
    pop: null,
  },
  {
    // Шаг 4. «🧩 Кнопки внизу»
    frame: '04_menu_tap_buttons.png',
    tap: { x: 1016, y: 1446 },
    button: { x: 27, y: 1398, w: 1028, h: 68 },
    captionBottom: 440,
    zoom: 1.2,
    pop: null,
  },
  {
    // Шаг 5. Добавь «👥 Др. группы»
    frame: '05_buttons_0.png',
    tap: { x: 1016, y: 1058 },
    button: { x: 546, y: 1012, w: 509, h: 66 },
    captionBottom: 440,
    zoom: 1.22,
    pop: null,
  },
  {
    // Шаг 6. Добавь «👨‍🏫 Где препод»
    frame: '06_buttons_1.png',
    tap: { x: 506, y: 1138 },
    button: { x: 26, y: 1090, w: 509, h: 66 },
    captionBottom: 560,
    zoom: 1.22,
    pop: { x: 546, y: 1012, w: 509, h: 66 },
  },
  {
    // Шаг 7. Добавь «🎓 Поток»
    frame: '07_buttons_2.png',
    tap: { x: 1016, y: 1134 },
    button: { x: 546, y: 1090, w: 509, h: 66 },
    captionBottom: 560,
    zoom: 1.22,
    pop: { x: 26, y: 1090, w: 509, h: 66 },
  },
  {
    // Шаг 8. «👌 Готово — обновить меню»
    frame: '08_buttons_3.png',
    tap: { x: 1016, y: 1446 },
    button: { x: 27, y: 1400, w: 1028, h: 66 },
    captionBottom: 560,
    zoom: 1.2,
    pop: { x: 546, y: 1090, w: 509, h: 66 },
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
