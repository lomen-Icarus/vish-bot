import React from 'react';
import { linearTiming, TransitionSeries } from '@remotion/transitions';
import { fade } from '@remotion/transitions/fade';
import { STEPS } from './data';
import { CoverScene } from './scenes/CoverScene';
import { TapStepScene } from './scenes/TapStepScene';
import { ResultScene } from './scenes/ResultScene';
import { FinalScene } from './scenes/FinalScene';

/** Мягкий переход между экранами: 10 кадров ≈ 0.33 с */
export const TRANSITION_FRAMES = 10;

// Обложка 100 + 8 шагов × 100 + итог 130 + финал 120 − 10 переходов × 10
// = 1050 кадров = 35 с при 30 fps.
export const MenuTutorial: React.FC = () => (
  <TransitionSeries>
    <TransitionSeries.Sequence name="Обложка" durationInFrames={100}>
      <CoverScene />
    </TransitionSeries.Sequence>
    {STEPS.map((step, i) => (
      <React.Fragment key={step.frame}>
        <TransitionSeries.Transition
          presentation={fade()}
          timing={linearTiming({ durationInFrames: TRANSITION_FRAMES })}
        />
        <TransitionSeries.Sequence
          name={`Шаг ${i + 1}`}
          durationInFrames={100}
        >
          <TapStepScene {...step} />
        </TransitionSeries.Sequence>
      </React.Fragment>
    ))}
    <TransitionSeries.Transition
      presentation={fade()}
      timing={linearTiming({ durationInFrames: TRANSITION_FRAMES })}
    />
    <TransitionSeries.Sequence name="Готово: меню 3 × 3" durationInFrames={130}>
      <ResultScene />
    </TransitionSeries.Sequence>
    <TransitionSeries.Transition
      presentation={fade()}
      timing={linearTiming({ durationInFrames: TRANSITION_FRAMES })}
    />
    <TransitionSeries.Sequence name="Финал" durationInFrames={120}>
      <FinalScene />
    </TransitionSeries.Sequence>
  </TransitionSeries>
);
