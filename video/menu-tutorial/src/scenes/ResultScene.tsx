import React from 'react';
import { Easing, interpolate, useCurrentFrame } from 'remotion';
import { KEYBOARD_BG, NEW_MENU_BUTTONS } from '../data';
import { FrameCrop, PhoneScreen } from '../Screen';

export const RESULT_DURATION = 130;
const IMAGE = '09_result.png';

/**
 * Итог: меню перестраивается в 3 × 3 — три новые кнопки появляются
 * по очереди (масштаб 0.9 → 1), затем мягко подсвечиваются.
 */
export const ResultScene: React.FC = () => {
  const frame = useCurrentFrame();

  return (
    <PhoneScreen
      frame={IMAGE}
      focus={{ x: 540, y: 1740 }}
      scale={1}
      captionBottom={440}
    >
      {NEW_MENU_BUTTONS.map((r, i) => {
        const start = 12 + i * 7;
        const appear = interpolate(frame, [start, start + 14], [0, 1], {
          extrapolateLeft: 'clamp',
          extrapolateRight: 'clamp',
          easing: Easing.spring({ damping: 12 }),
        });
        const glow =
          frame < 45 + i * 4
            ? 0
            : 0.5 - 0.5 * Math.cos(((frame - 45 - i * 4) / 32) * 2 * Math.PI);
        return (
          <React.Fragment key={i}>
            {/* Пустое место, пока кнопка не появилась */}
            <div
              style={{
                position: 'absolute',
                left: r.x - 2,
                top: r.y - 2,
                width: r.w + 4,
                height: r.h + 4,
                backgroundColor: KEYBOARD_BG,
              }}
            />
            <FrameCrop
              frame={IMAGE}
              rect={r}
              radius={20}
              style={{
                scale: String(0.9 + 0.1 * appear),
                opacity: Math.min(1, appear * 1.4),
                boxShadow: `0 0 ${(10 + 18 * glow).toFixed(1)}px ${(1 + 5 * glow).toFixed(1)}px rgba(255, 196, 0, ${(0.8 * glow).toFixed(3)})`,
              }}
            />
          </React.Fragment>
        );
      })}
    </PhoneScreen>
  );
};
