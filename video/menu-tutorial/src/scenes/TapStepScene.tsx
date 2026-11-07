import React from 'react';
import { Easing, interpolate, useCurrentFrame } from 'remotion';
import { TapStepProps } from '../data';
import { ButtonFlash, FrameCrop, PhoneScreen, TapFinger } from '../Screen';

/** Длина сцены шага (включая по 10 кадров на переходы) */
export const TAP_STEP_DURATION = 100;
/** Кадр нажатия внутри сцены */
const TAP_AT = 52;

/**
 * Один шаг: общий план → наезд к кнопке → палец нажимает →
 * кнопка вспыхивает → камера возвращается к общему плану.
 */
export const TapStepScene: React.FC<TapStepProps> = ({
  frame: image,
  tap,
  button,
  captionBottom,
  zoom,
  pop,
}) => {
  const frame = useCurrentFrame();

  // 0 — общий план, 1 — приближено к месту нажатия
  const z = interpolate(frame, [18, 42, 68, 88], [0, 1, 1, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: Easing.bezier(0.45, 0, 0.55, 1),
  });

  // «Поп» кнопки, где ➕ только что сменился на ✅
  const popScale = interpolate(frame, [8, 16, 30], [1, 1.09, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: Easing.bezier(0.33, 1, 0.68, 1),
  });
  const popGlow = interpolate(frame, [8, 16, 36], [0, 1, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  return (
    <PhoneScreen
      frame={image}
      focus={tap}
      scale={1 + (zoom - 1) * z}
      captionBottom={captionBottom}
    >
      {pop ? (
        <FrameCrop
          frame={image}
          rect={pop}
          radius={18}
          style={{
            scale: String(popScale),
            boxShadow: `0 0 0 4px rgba(255,255,255,${(0.9 * popGlow).toFixed(3)}), 0 6px 18px rgba(0,0,0,${(0.25 * popGlow).toFixed(3)})`,
          }}
        />
      ) : null}
      <ButtonFlash rect={button} at={TAP_AT} />
      <TapFinger point={tap} at={TAP_AT} />
    </PhoneScreen>
  );
};
