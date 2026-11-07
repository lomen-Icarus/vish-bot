import React from 'react';
import { Composition, Folder } from 'remotion';
import { MenuTutorial, TOTAL_DURATION } from './MenuTutorial';
import { CoverScene } from './scenes/CoverScene';
import { TapStepScene } from './scenes/TapStepScene';
import { ResultScene } from './scenes/ResultScene';
import { FinalScene } from './scenes/FinalScene';

export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition
        id="MenuTutorial"
        component={MenuTutorial}
        durationInFrames={TOTAL_DURATION}
        fps={30}
        width={1080}
        height={1920}
      />
      <Folder name="MenuTutorial-Scenes">
        <Composition
          id="Cover"
          component={CoverScene}
          durationInFrames={100}
          fps={30}
          width={1080}
          height={1920}
        />
        <Composition
          id="Step1"
          component={TapStepScene}
          durationInFrames={96}
          fps={30}
          width={1080}
          height={1920}
          defaultProps={{
            frame: '01_start_tap_more.png',
            tap: { x: 640, y: 1866 },
            button: { x: 372, y: 1800, w: 336, h: 95 },
            captionBottom: 440,
            duration: 96,
            pop: null,
          }}
        />
        <Composition
          id="Step6"
          component={TapStepScene}
          durationInFrames={76}
          fps={30}
          width={1080}
          height={1920}
          defaultProps={{
            frame: '06_buttons_1.png',
            tap: { x: 475, y: 1127 },
            button: { x: 28, y: 1090, w: 502, h: 67 },
            captionBottom: 560,
            duration: 76,
            pop: { x: 550, y: 1012, w: 500, h: 68 },
          }}
        />
        <Composition
          id="Result"
          component={ResultScene}
          durationInFrames={130}
          fps={30}
          width={1080}
          height={1920}
        />
        <Composition
          id="Final"
          component={FinalScene}
          durationInFrames={120}
          fps={30}
          width={1080}
          height={1920}
        />
      </Folder>
    </>
  );
};
