import React from 'react';
import {
  AbsoluteFill,
  Easing,
  Interactive,
  interpolate,
  useCurrentFrame,
} from 'remotion';
import { FONT_FAMILY } from '../fonts';
import { PhoneScreen } from '../Screen';

export const FINAL_DURATION = 120;

/** Чистый итог: медленный зум к нижнему меню и крупное «Готово!» */
export const FinalScene: React.FC = () => {
  const frame = useCurrentFrame();

  const z = interpolate(frame, [0, 110], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: Easing.bezier(0.45, 0, 0.55, 1),
  });

  return (
    <AbsoluteFill>
      <PhoneScreen
        frame="10_final_clean.png"
        focus={{ x: 540, y: 1740 }}
        scale={1 + 0.18 * z}
        captionBottom={null}
      />
      <Interactive.Div
        name="Готово"
        style={{
          position: 'absolute',
          left: 60,
          top: 360,
          width: 960,
          paddingTop: 48,
          paddingBottom: 52,
          borderRadius: 48,
          backgroundColor: 'rgba(44, 45, 36, 0.96)',
          boxShadow: '0 16px 40px rgba(0,0,0,0.3)',
          color: 'white',
          fontFamily: FONT_FAMILY,
          textAlign: 'center',
          opacity: interpolate(frame, [12, 24], [0, 1], {
            extrapolateLeft: 'clamp',
            extrapolateRight: 'clamp',
          }),
          scale: interpolate(frame, [12, 34], [0.8, 1], {
            extrapolateLeft: 'clamp',
            extrapolateRight: 'clamp',
            easing: Easing.spring({ damping: 12 }),
            output: 'perceptual-scale',
          }),
        }}
      >
        <div style={{ fontSize: 132, fontWeight: 800, lineHeight: 1.05 }}>
          Готово!
        </div>
        <div
          style={{
            fontSize: 46,
            fontWeight: 600,
            marginTop: 18,
            color: 'rgba(255,255,255,0.78)',
          }}
        >
          Новое меню 3 × 3 — уже внизу
        </div>
      </Interactive.Div>
    </AbsoluteFill>
  );
};
