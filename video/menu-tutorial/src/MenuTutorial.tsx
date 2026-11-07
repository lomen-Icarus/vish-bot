import React from 'react';
import { linearTiming, TransitionSeries } from '@remotion/transitions';
import { fade } from '@remotion/transitions/fade';
import { STEPS } from './data';
import { CoverScene } from './scenes/CoverScene';
import { TapStepScene, TRANSITION_FRAMES } from './scenes/TapStepScene';
import { ResultScene } from './scenes/ResultScene';
import { FinalScene } from './scenes/FinalScene';

const COVER = 100;
const RESULT = 130;
const FINAL = 120;

/**
 * Обложка 100 + шаг 1 96 + шаги 2–8 по 76 + итог 130 + финал 120
 * − 10 переходов × 10 = 878 кадров ≈ 29.3 с при 30 fps.
 */
export const TOTAL_DURATION =
  COVER +
  STEPS.reduce((sum, s) => sum + s.duration, 0) +
  RESULT +
  FINAL -
  (STEPS.length + 2) * TRANSITION_FRAMES;

export const MenuTutorial: React.FC = () => (
  <TransitionSeries>
    <TransitionSeries.Sequence name="Обложка" durationInFrames={COVER}>
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
          durationInFrames={step.duration}
        >
          <TapStepScene {...step} />
        </TransitionSeries.Sequence>
      </React.Fragment>
    ))}
    <TransitionSeries.Transition
      presentation={fade()}
      timing={linearTiming({ durationInFrames: TRANSITION_FRAMES })}
    />
    <TransitionSeries.Sequence name="Готово: меню 3 × 3" durationInFrames={RESULT}>
      <ResultScene />
    </TransitionSeries.Sequence>
    <TransitionSeries.Transition
      presentation={fade()}
      timing={linearTiming({ durationInFrames: TRANSITION_FRAMES })}
    />
    <TransitionSeries.Sequence name="Финал" durationInFrames={FINAL}>
      <FinalScene />
    </TransitionSeries.Sequence>
  </TransitionSeries>
);
