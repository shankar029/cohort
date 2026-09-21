import { Composition } from 'remotion';
import { CohortDemo } from './CohortDemo';
import { scenes, sceneFrames, FPS } from './scenes';

const total = scenes.reduce((n, s) => n + sceneFrames(s), 0);

export const RemotionRoot: React.FC = () => {
  return (
    <Composition
      id="CohortDemo"
      component={CohortDemo}
      durationInFrames={total}
      fps={FPS}
      width={1920}
      height={1080}
    />
  );
};
