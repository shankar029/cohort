import { AbsoluteFill, Audio, Sequence, staticFile } from 'remotion';
import { scenes, sceneFrames, LEAD, FPS } from './scenes';
import { SceneView } from './SceneView';

const TOTAL = scenes.reduce((n, s) => n + sceneFrames(s), 0);

export const CohortDemo: React.FC = () => {
  let from = 0;
  return (
    <AbsoluteFill style={{ backgroundColor: '#0b0713' }}>
      {scenes.map((s) => {
        const dur = sceneFrames(s);
        const gFrom = from;
        const el = (
          <Sequence key={s.id} from={from} durationInFrames={dur} name={`Scene ${s.id}`}>
            <SceneView scene={s} durationInFrames={dur} globalFrom={gFrom} total={TOTAL} />
            <Sequence from={Math.round(LEAD * FPS)} name="vo">
              <Audio src={staticFile(s.vo)} volume={1} />
            </Sequence>
          </Sequence>
        );
        from += dur;
        return el;
      })}
      {/* subtle music bed across the whole video, if present */}
      <Audio src={staticFile('music/bed.mp3')} volume={0.12} />
    </AbsoluteFill>
  );
};
