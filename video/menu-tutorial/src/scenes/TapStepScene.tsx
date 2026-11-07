import React from 'react';
import { Easing, interpolate, useCurrentFrame } from 'remotion';
import { TapStepProps } from '../data';
import {
  ButtonFlash,
  ButtonHighlight,
  FrameCrop,
  PhoneScreen,
  TapFinger,
} from '../Screen';

/**
 * Через сколько кадров после нажатия сцена начинает уходить в следующую.
 * Переход длится 10 кадров: ответ бота появляется через ~0.13 с после
 * нажатия и виден полностью через ~0.47 с — без паузы «бот думает».
 */
export const RESPONSE_DELAY = 4;
export const TRANSITION_FRAMES = 10;

/**
 * Один шаг без зума: экран стоит, палец подлетает к кнопке — вокруг неё
 * появляется рамка, нажатие, вспышка — и сразу ответ бота (следующая сцена).
 */
export const TapStepScene: React.FC<TapStepProps> = ({
  frame: image,
  tap,
  button,
  captionBottom,
  duration,
  pop,
}) => {
  const frame = useCurrentFrame();
  const tapAt = duration - TRANSITION_FRAMES - RESPONSE_DELAY;

  // «Поп» кнопки, где ➕ только что сменился на ✅ — сразу после появления экрана
  const popScale = interpolate(frame, [3, 9, 22], [1, 1.09, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: Easing.bezier(0.33, 1, 0.68, 1),
  });
  const popGlow = interpolate(frame, [3, 9, 28], [0, 1, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  return (
    <PhoneScreen
      frame={image}
      focus={tap}
      scale={1}
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
      <ButtonHighlight rect={button} at={tapAt} />
      <ButtonFlash rect={button} at={tapAt} />
      <TapFinger point={tap} at={tapAt} />
    </PhoneScreen>
  );
};
