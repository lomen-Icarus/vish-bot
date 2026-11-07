import React from 'react';
import {
  AbsoluteFill,
  Easing,
  Img,
  interpolate,
  staticFile,
  useCurrentFrame,
} from 'remotion';
import { CAPTION_TOP, HEADER_BOTTOM, Point, Rect, SCREEN } from './data';

const clamp = (v: number, min: number, max: number) =>
  Math.min(max, Math.max(min, v));

/**
 * Камера: масштаб s и сдвиг так, чтобы точка фокуса шла к центру,
 * но края кадра не открывали пустоту.
 */
export const cameraFor = (focus: Point, s: number) => {
  const { width: W, height: H } = SCREEN;
  return {
    x: clamp(W / 2 - focus.x * s, W - W * s, 0),
    y: clamp(H / 2 - focus.y * s, H - H * s, 0),
    s,
  };
};

/**
 * Экран телефона: область чата приближается камерой, а шапка чата
 * и тёмная плашка шага остаются на месте — текст шага всегда читается.
 */
export const PhoneScreen: React.FC<{
  frame: string;
  focus: Point;
  /** 1 — без зума */
  scale: number;
  captionBottom: number | null;
  /** Оверлеи в координатах кадра 1080×1920 — двигаются вместе с камерой */
  children?: React.ReactNode;
}> = ({ frame, focus, scale, captionBottom, children }) => {
  const cam = cameraFor(focus, scale);
  const src = staticFile(`frames/${frame}`);
  // Всё выше этой линии (шапка чата + плашка шага) неподвижно, ниже — камера
  const bandBottom = captionBottom ?? HEADER_BOTTOM;
  const shadow = 0.3 * clamp((scale - 1) * 8, 0, 1);
  return (
    <AbsoluteFill style={{ backgroundColor: '#e7e8eb' }}>
      <AbsoluteFill style={{ clipPath: `inset(${bandBottom}px 0 0 0)` }}>
        <div
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            width: SCREEN.width,
            height: SCREEN.height,
            transformOrigin: '0 0',
            translate: `${cam.x}px ${cam.y}px`,
            scale: String(cam.s),
          }}
        >
          <Img
            name="Кадр"
            src={src}
            style={{ width: SCREEN.width, height: SCREEN.height }}
          />
          {children}
        </div>
      </AbsoluteFill>

      {/* Тень под плашкой (или шапкой) проявляется по мере зума */}
      <div
        style={{
          position: 'absolute',
          left: captionBottom !== null ? 25 : 0,
          top: captionBottom !== null ? CAPTION_TOP : 0,
          width: captionBottom !== null ? 1030 : SCREEN.width,
          height: bandBottom - (captionBottom !== null ? CAPTION_TOP : 0),
          borderRadius: captionBottom !== null ? 40 : 0,
          boxShadow: `0 10px 28px rgba(0,0,0,${shadow.toFixed(3)})`,
        }}
      />

      {/* Шапка чата и плашка шага — неподвижны, текст шага всегда целиком */}
      <div
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          width: SCREEN.width,
          height: bandBottom,
          overflow: 'hidden',
        }}
      >
        <Img src={src} style={{ width: SCREEN.width, height: SCREEN.height }} />
      </div>
    </AbsoluteFill>
  );
};

/** Кусок кадра (для «попа» кнопки), в координатах кадра */
export const FrameCrop: React.FC<{
  frame: string;
  rect: Rect;
  radius: number;
  style?: React.CSSProperties;
}> = ({ frame, rect, radius, style }) => (
  <div
    style={{
      position: 'absolute',
      left: rect.x,
      top: rect.y,
      width: rect.w,
      height: rect.h,
      borderRadius: radius,
      overflow: 'hidden',
      ...style,
    }}
  >
    <Img
      src={staticFile(`frames/${frame}`)}
      style={{
        position: 'absolute',
        left: -rect.x,
        top: -rect.y,
        width: SCREEN.width,
        height: SCREEN.height,
      }}
    />
  </div>
);

/**
 * Палец: полупрозрачный круг с розовым контуром подлетает к точке,
 * нажимает (сжатие), расходится волна. `at` — кадр нажатия.
 */
export const TapFinger: React.FC<{ point: Point; at: number }> = ({
  point,
  at,
}) => {
  const frame = useCurrentFrame();
  const R = 46;
  const approach = interpolate(frame, [at - 16, at], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: Easing.bezier(0.22, 1, 0.36, 1),
  });
  const opacity = interpolate(
    frame,
    [at - 16, at - 8, at + 14, at + 24],
    [0, 1, 1, 0],
    { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' },
  );
  const press = interpolate(
    frame,
    [at - 2, at + 3, at + 10],
    [1, 0.78, 1],
    {
      extrapolateLeft: 'clamp',
      extrapolateRight: 'clamp',
      easing: Easing.bezier(0.33, 1, 0.68, 1),
    },
  );
  const ripple = interpolate(frame, [at, at + 20], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: Easing.bezier(0.16, 1, 0.3, 1),
  });
  const dx = (1 - approach) * 150;
  const dy = (1 - approach) * 240;

  return (
    <>
      {frame >= at ? (
        <div
          style={{
            position: 'absolute',
            left: point.x - R,
            top: point.y - R,
            width: R * 2,
            height: R * 2,
            borderRadius: '50%',
            border: '6px solid rgba(255, 59, 107, 1)',
            boxSizing: 'border-box',
            scale: String(1 + ripple * 1.6),
            opacity: (1 - ripple) * 0.8,
          }}
        />
      ) : null}
      <div
        style={{
          position: 'absolute',
          left: point.x - R,
          top: point.y - R,
          width: R * 2,
          height: R * 2,
          borderRadius: '50%',
          backgroundColor: 'rgba(255, 255, 255, 0.45)',
          border: '6px solid rgba(255, 59, 107, 0.95)',
          boxSizing: 'border-box',
          boxShadow: '0 8px 22px rgba(0,0,0,0.28)',
          translate: `${dx}px ${dy}px`,
          scale: String(press),
          opacity,
        }}
      />
    </>
  );
};

/** Короткая подсветка нажатой кнопки */
export const ButtonFlash: React.FC<{ rect: Rect; at: number }> = ({
  rect,
  at,
}) => {
  const frame = useCurrentFrame();
  const o = interpolate(frame, [at, at + 3, at + 16], [0, 0.55, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  return (
    <div
      style={{
        position: 'absolute',
        left: rect.x,
        top: rect.y,
        width: rect.w,
        height: rect.h,
        borderRadius: 18,
        backgroundColor: 'white',
        opacity: o,
      }}
    />
  );
};
