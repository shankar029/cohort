import React from 'react';
import {
  AbsoluteFill,
  OffthreadVideo,
  Img,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
  interpolate,
  spring,
  Easing,
} from 'remotion';
import { Scene, LEAD, FPS } from './scenes';

const FONT =
  '"Segoe UI", -apple-system, BlinkMacSystemFont, "Inter", Roboto, Helvetica, Arial, sans-serif';

const hexA = (hex: string, a: number) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
};

const Background: React.FC<{ accent: string }> = ({ accent }) => {
  const frame = useCurrentFrame();
  const d = frame / 60;
  const x1 = 22 + Math.sin(d * 1.1) * 9;
  const y1 = 16 + Math.cos(d) * 7;
  return (
    <AbsoluteFill>
      <AbsoluteFill style={{ backgroundColor: '#0b0713' }} />
      <AbsoluteFill
        style={{
          background: `radial-gradient(60% 60% at ${x1}% ${y1}%, ${hexA(accent, 0.4)} 0%, rgba(11,7,19,0) 60%)`,
        }}
      />
      <AbsoluteFill
        style={{
          background: `radial-gradient(55% 55% at ${92 - x1}% ${86 - y1}%, ${hexA('#3b1d6e', 0.5)} 0%, rgba(11,7,19,0) 62%)`,
        }}
      />
      <AbsoluteFill
        style={{
          backgroundImage:
            'linear-gradient(rgba(255,255,255,0.03) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.03) 1px, transparent 1px)',
          backgroundSize: '64px 64px',
          maskImage: 'radial-gradient(80% 70% at 50% 45%, black 20%, transparent 80%)',
        }}
      />
    </AbsoluteFill>
  );
};

const Chip: React.FC<{ label: string; accent: string; delay: number }> = ({ label, accent, delay }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  if (!label) return null;
  const s = spring({ frame: frame - delay, fps, config: { damping: 200 } });
  return (
    <div
      style={{
        position: 'absolute',
        left: 220,
        top: 62,
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        opacity: s,
        transform: `translateY(${(1 - s) * -14}px)`,
      }}
    >
      <div style={{ width: 12, height: 12, borderRadius: 12, background: accent, boxShadow: `0 0 16px 2px ${hexA(accent, 0.8)}` }} />
      <div style={{ fontFamily: FONT, fontSize: 30, fontWeight: 700, color: 'white', textShadow: '0 2px 18px rgba(0,0,0,0.5)' }}>{label}</div>
    </div>
  );
};

const BrowserFrame: React.FC<{ scene: Scene; local: number; dur: number }> = ({ scene, local, dur }) => {
  const { fps } = useVideoConfig();
  const W = 1480;
  const H = Math.round((W * 884) / 1920); // 681
  const enter = spring({ frame: local, fps, config: { damping: 200 }, durationInFrames: 24 });
  const t = interpolate(local, [0, dur], [0, 1], { extrapolateRight: 'clamp' });
  const base = 1.0; // start at full width — aspect matches source, so no left/right crop
  const zoomTo = scene.focus ? Math.min(scene.focus.zoom, 1.05) : 1.028;
  const scale = interpolate(t, [0, 1], [base, zoomTo], { easing: Easing.inOut(Easing.quad) });
  const origin = scene.focus ? `${scene.focus.x * 100}% ${scene.focus.y * 100}%` : '50% 46%';
  return (
    <div
      style={{
        position: 'absolute',
        left: (1920 - W) / 2,
        top: 116,
        width: W,
        borderRadius: 16,
        overflow: 'hidden',
        background: '#15101f',
        border: '1px solid rgba(255,255,255,0.09)',
        boxShadow: `0 40px 120px -20px rgba(0,0,0,0.75), 0 0 0 1px ${hexA(scene.accent, 0.25)}, 0 0 90px -25px ${hexA(scene.accent, 0.6)}`,
        opacity: enter,
        transform: `translateY(${(1 - enter) * 40}px) scale(${0.985 + enter * 0.015})`,
      }}
    >
      <div
        style={{
          height: 46,
          display: 'flex',
          alignItems: 'center',
          gap: 9,
          padding: '0 18px',
          background: 'linear-gradient(#211a30,#191325)',
          borderBottom: '1px solid rgba(255,255,255,0.06)',
        }}
      >
        <div style={{ width: 13, height: 13, borderRadius: 13, background: '#ff5f57' }} />
        <div style={{ width: 13, height: 13, borderRadius: 13, background: '#febc2e' }} />
        <div style={{ width: 13, height: 13, borderRadius: 13, background: '#28c840' }} />
        <div
          style={{
            marginLeft: 18,
            flex: 1,
            maxWidth: 440,
            height: 26,
            borderRadius: 8,
            background: 'rgba(255,255,255,0.06)',
            display: 'flex',
            alignItems: 'center',
            padding: '0 12px',
            fontFamily: FONT,
            fontSize: 14,
            color: 'rgba(255,255,255,0.55)',
          }}
        >
          localhost:5319 — Cohort
        </div>
      </div>
      <div style={{ width: W, height: H, overflow: 'hidden', background: '#efe9d8' }}>
        <OffthreadVideo
          src={staticFile(scene.clip)}
          muted
          style={{ width: '100%', height: '100%', objectFit: 'cover', transform: `scale(${scale})`, transformOrigin: origin }}
        />
      </div>
    </div>
  );
};

const Caption: React.FC<{ text: string; accent: string; delay: number }> = ({ text, accent, delay }) => {
  const frame = useCurrentFrame();
  const words = text.split(' ');
  return (
    <div style={{ position: 'absolute', left: 0, right: 0, top: 884, display: 'flex', justifyContent: 'center', padding: '0 150px' }}>
      <div
        style={{
          fontFamily: FONT,
          fontSize: 48,
          fontWeight: 800,
          lineHeight: 1.14,
          textAlign: 'center',
          color: 'white',
          letterSpacing: -0.5,
          textShadow: '0 4px 30px rgba(0,0,0,0.6)',
          maxWidth: 1560,
        }}
      >
        {words.map((w, i) => {
          const dd = delay + i * 2.1;
          const o = interpolate(frame, [dd, dd + 8], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
          const ty = interpolate(frame, [dd, dd + 8], [16, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.out(Easing.cubic) });
          const hi = /one|AI|team|epic|parallel|quality|merge|shipped|reviewed|black box|online|specialists|brainstorm|align|dashboard|glance|grounded|streams|bug|blocked|gate|gates|verified|verification|assemble/i.test(w);
          return (
            <span key={i} style={{ display: 'inline-block', opacity: o, transform: `translateY(${ty}px)`, marginRight: 13, color: hi ? accent : 'white' }}>
              {w}
            </span>
          );
        })}
      </div>
    </div>
  );
};

const ProgressFill: React.FC<{ accent: string; from: number; dur: number; total: number }> = ({ accent, from, dur, total }) => {
  const frame = useCurrentFrame();
  const p = interpolate(from + frame, [0, total], [0, 1], { extrapolateRight: 'clamp' });
  return (
    <div style={{ position: 'absolute', left: 220, right: 220, bottom: 44, height: 4, borderRadius: 4, background: 'rgba(255,255,255,0.08)', overflow: 'hidden' }}>
      <div style={{ width: `${p * 100}%`, height: '100%', background: `linear-gradient(90deg, ${hexA(accent, 0.5)}, ${accent})`, boxShadow: `0 0 12px ${accent}` }} />
    </div>
  );
};

const BrandLockup: React.FC<{ accent: string; sub: string; big?: boolean }> = ({ accent, sub, big }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const s = spring({ frame, fps, config: { damping: 200 }, durationInFrames: 30 });
  const logo = big ? 180 : 116;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 22, transform: `scale(${0.9 + s * 0.1})`, opacity: s }}>
      <Img src={staticFile('logo.png')} style={{ width: logo, height: logo, borderRadius: 32, boxShadow: `0 20px 80px -10px ${hexA(accent, 0.7)}` }} />
      <div style={{ fontFamily: FONT, fontSize: big ? 132 : 96, fontWeight: 900, letterSpacing: -2, color: 'white', textShadow: '0 6px 40px rgba(0,0,0,0.6)' }}>Cohort</div>
      <div style={{ fontFamily: FONT, fontSize: 38, fontWeight: 600, color: hexA('#ffffff', 0.82), textAlign: 'center', maxWidth: 1180 }}>{sub}</div>
    </div>
  );
};

// Access the running offset for the global progress bar via a module-scoped map.
export const SceneView: React.FC<{ scene: Scene; durationInFrames: number; globalFrom?: number; total?: number }> = ({ scene, durationInFrames, globalFrom = 0, total }) => {
  const local = useCurrentFrame();
  const voStart = Math.round(LEAD * FPS);
  const T = total ?? durationInFrames;

  if (scene.kind === 'intro') {
    const enter = spring({ frame: local, fps: FPS, config: { damping: 200 }, durationInFrames: 30 });
    const floatY = Math.sin((local / FPS) * 1.1) * 8;
    const stages = ['Plan', 'Build', 'Review', 'Ship'];
    const outo = interpolate(local, [durationInFrames - 12, durationInFrames], [1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
    return (
      <AbsoluteFill style={{ opacity: outo }}>
        <Background accent={scene.accent} />
        <AbsoluteFill style={{ justifyContent: 'center', alignItems: 'center', gap: 30 }}>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 26, transform: `translateY(${(1 - enter) * 30 + floatY}px) scale(${0.9 + enter * 0.1})`, opacity: enter }}>
            <Img src={staticFile('logo.png')} style={{ width: 190, height: 190, borderRadius: 34, boxShadow: `0 24px 90px -10px ${hexA(scene.accent, 0.75)}` }} />
            <div style={{ fontFamily: FONT, fontSize: 140, fontWeight: 900, letterSpacing: -3, color: 'white', textShadow: '0 6px 44px rgba(0,0,0,0.6)', lineHeight: 1 }}>Cohort</div>
            <div style={{ fontFamily: FONT, fontSize: 40, fontWeight: 600, color: hexA('#ffffff', 0.85), textAlign: 'center', maxWidth: 1280 }}>
              An entire AI engineering team, on your own machine
            </div>
          </div>
          <div style={{ display: 'flex', gap: 18, marginTop: 20 }}>
            {stages.map((label, i) => {
              const at = 34 + i * 20;
              const a = interpolate(local, [at, at + 12], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
              return (
                <React.Fragment key={label}>
                  {i > 0 && <div style={{ alignSelf: 'center', color: hexA(scene.accent, 0.6 * a + 0.1), fontSize: 34, opacity: a }}>→</div>}
                  <div
                    style={{
                      fontFamily: FONT,
                      fontSize: 34,
                      fontWeight: 800,
                      padding: '14px 30px',
                      borderRadius: 999,
                      color: 'white',
                      background: hexA(scene.accent, 0.14),
                      border: `1.5px solid ${hexA(scene.accent, 0.55)}`,
                      boxShadow: `0 0 ${a * 26}px ${hexA(scene.accent, a * 0.7)}`,
                      opacity: 0.35 + a * 0.65,
                      transform: `translateY(${(1 - a) * 14}px)`,
                    }}
                  >
                    {label}
                  </div>
                </React.Fragment>
              );
            })}
          </div>
        </AbsoluteFill>
        <ProgressFill accent={scene.accent} from={globalFrom} dur={durationInFrames} total={T} />
      </AbsoluteFill>
    );
  }

  if (scene.kind === 'outro') {
    const revealAt = 0;
    const showBrandAt = 96; // hold on final dashboard, then brand
    const brandIn = interpolate(local, [showBrandAt, showBrandAt + 14], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
    return (
      <AbsoluteFill>
        <Background accent={scene.accent} />
        <BrowserFrame scene={scene} local={Math.max(0, local - revealAt)} dur={durationInFrames} />
        <Chip label={scene.label} accent={scene.accent} delay={6} />
        <Caption text={scene.caption} accent={scene.accent} delay={voStart} />
        {brandIn > 0.01 && (
          <AbsoluteFill style={{ backgroundColor: `rgba(11,7,19,${brandIn * 0.96})`, justifyContent: 'center', alignItems: 'center', opacity: 1 }}>
            <div style={{ opacity: brandIn, transform: `translateY(${(1 - brandIn) * 20}px)` }}>
              <BrandLockup accent={scene.accent} big sub="Your AI engineering team — powered by the GitHub Copilot SDK" />
            </div>
          </AbsoluteFill>
        )}
        <ProgressFill accent={scene.accent} from={globalFrom} dur={durationInFrames} total={T} />
      </AbsoluteFill>
    );
  }

  if (scene.kind === 'title') {
    // Deliberate intro: fade in, hold ~2.8s, then fade out to reveal the app.
    const brandIn = interpolate(local, [0, 14], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
    const brandOut = interpolate(local, [84, 104], [1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
    const brand = Math.min(brandIn, brandOut);
    const introScale = interpolate(local, [0, 14], [0.94, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.out(Easing.cubic) });
    return (
      <AbsoluteFill>
        <Background accent={scene.accent} />
        <BrowserFrame scene={scene} local={local} dur={durationInFrames} />
        <Chip label={scene.label} accent={scene.accent} delay={100} />
        <Caption text={scene.caption} accent={scene.accent} delay={108} />
        {brand > 0.01 && (
          <AbsoluteFill style={{ backgroundColor: `rgba(11,7,19,${brand})`, justifyContent: 'center', alignItems: 'center' }}>
            <div style={{ opacity: brand, transform: `scale(${introScale})` }}>
              <BrandLockup accent={scene.accent} sub="An entire AI engineering team, on your real repo" />
            </div>
          </AbsoluteFill>
        )}
        <ProgressFill accent={scene.accent} from={globalFrom} dur={durationInFrames} total={T} />
      </AbsoluteFill>
    );
  }

  return (
    <AbsoluteFill>
      <Background accent={scene.accent} />
      <BrowserFrame scene={scene} local={local} dur={durationInFrames} />
      <Chip label={scene.label} accent={scene.accent} delay={6} />
      <Caption text={scene.caption} accent={scene.accent} delay={voStart} />
      <ProgressFill accent={scene.accent} from={globalFrom} dur={durationInFrames} total={T} />
    </AbsoluteFill>
  );
};
