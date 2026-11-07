import React from 'react';
import {
  AbsoluteFill,
  Easing,
  Img,
  interpolate,
  staticFile,
  useCurrentFrame,
} from 'remotion';
import { COVER_NEW_BUTTONS } from '../data';

export const COVER_DURATION = 100;

/** Обложка: лёгкий зум-аут, три новые кнопки мягко пульсируют */
export const CoverScene: React.FC = () => {
  const frame = useCurrentFrame();
  const pulse = (delay: number) =>
    frame < 18 + delay
      ? 0
      : 0.5 - 0.5 * Math.cos(((frame - 18 - delay) / 30) * 2 * Math.PI);

  return (
    <AbsoluteFill style={{ backgroundColor: '#24382a', overflow: 'hidden' }}>
      <AbsoluteFill
        style={{
          scale: interpolate(frame, [0, 100], [1.08, 1], {
            extrapolateLeft: 'clamp',
            extrapolateRight: 'clamp',
            easing: Easing.bezier(0.16, 1, 0.3, 1),
            output: 'perceptual-scale',
          }),
        }}
      >
        <Img
          name="Обложка"
          src={staticFile('frames/00_cover.png')}
          style={{ width: 1080, height: 1920 }}
        />
        {COVER_NEW_BUTTONS.map((r, i) => (
          <div
            key={i}
            style={{
              position: 'absolute',
              left: r.x,
              top: r.y,
              width: r.w,
              height: r.h,
              borderRadius: 22,
              boxShadow: `0 0 ${(14 + 22 * pulse(i * 5)).toFixed(1)}px ${(2 + 6 * pulse(i * 5)).toFixed(1)}px rgba(255, 196, 0, ${(0.85 * pulse(i * 5)).toFixed(3)})`,
              scale: String(1 + 0.03 * pulse(i * 5)),
            }}
          />
        ))}
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
