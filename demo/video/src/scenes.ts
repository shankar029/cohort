import voDur from './vo-durations.json';

export type Scene = {
  id: number;
  clip: string; // video in public/clips
  vo: string; // wav in public/vo
  clipDuration: number; // seconds (scene length; see cut-clips.sh)
  label: string;
  caption: string;
  kind: 'title' | 'shot' | 'outro' | 'intro';
  accent: string;
  focus?: { x: number; y: number; zoom: number }; // optional punch-in target (0..1)
};

export const FPS = 30;
export const LEAD = 0.35; // seconds before VO starts within a scene

// Scene lengths were used to cut/time-remap the clips (see cut-clips.sh).
const clipDur: Record<string, number> = {
  scene00: 5.36, // spoken brand intro (what is Cohort) ~5s
  scene01: 14.55, // create team (Agents)
  scene02: 6.82, // hook (chat typing, sped up)
  scene03: 8.31, // the brief (send + reply + epic)
  scene04: 9.95, // team lead plans
  scene05: 12.66, // kanban board
  scene06: 8.69, // team discussion
  scene07: 7.62, // reviewer catches bug
  scene08: 6.67, // quality gates (notifications)
  scene09: 8.45, // fixes as new work items (board)
  scene10: 6.28, // git merge
  scene11: 6.86, // dashboard
  scene12: 9.98, // finale
};

export const scenes: Scene[] = [
  {
    id: 0,
    clip: '',
    vo: 'vo/scene00.wav',
    clipDuration: clipDur.scene00,
    label: 'Cohort',
    caption: '',
    kind: 'intro',
    accent: '#8b5cf6',
  },
  {
    id: 1,
    clip: 'clips/scene01.mp4',
    vo: 'vo/scene01.wav',
    clipDuration: clipDur.scene01,
    label: 'Agents · Build your team',
    caption: 'First, assemble a team of AI specialists',
    kind: 'shot',
    accent: '#f59e0b',
  },
  {
    id: 2,
    clip: 'clips/scene02.mp4',
    vo: 'vo/scene02.wav',
    clipDuration: clipDur.scene02,
    label: 'Team Lead',
    caption: 'Then send one message — just describe what you want',
    kind: 'shot',
    accent: '#8b5cf6',
  },
  {
    id: 3,
    clip: 'clips/scene03.mp4',
    vo: 'vo/scene03.wav',
    clipDuration: clipDur.scene03,
    label: 'The brief',
    caption: 'Attach a brief, hit send — that one sentence is the plan',
    kind: 'shot',
    accent: '#6366f1',
  },
  {
    id: 4,
    clip: 'clips/scene04.mp4',
    vo: 'vo/scene04.wav',
    clipDuration: clipDur.scene04,
    label: 'Team Lead · Planning',
    caption: 'It becomes an epic — planned as parallel streams',
    kind: 'shot',
    accent: '#a855f7',
  },
  {
    id: 5,
    clip: 'clips/scene05.mp4',
    vo: 'vo/scene05.wav',
    clipDuration: clipDur.scene05,
    label: 'Kanban Board',
    caption: 'Decomposed into parallel, stream-tagged tasks',
    kind: 'shot',
    accent: '#ec4899',
  },
  {
    id: 6,
    clip: 'clips/scene06.mp4',
    vo: 'vo/scene06.wav',
    clipDuration: clipDur.scene06,
    label: 'Team Discussion',
    caption: 'Grounded agents brainstorm and align first',
    kind: 'shot',
    accent: '#14b8a6',
  },
  {
    id: 7,
    clip: 'clips/scene07.mp4',
    vo: 'vo/scene07.wav',
    clipDuration: clipDur.scene07,
    label: 'Live Review',
    caption: 'The reviewer catches a real bug — PR blocked',
    kind: 'shot',
    accent: '#06b6d4',
  },
  {
    id: 8,
    clip: 'clips/scene08.mp4',
    vo: 'vo/scene08.wav',
    clipDuration: clipDur.scene08,
    label: 'Quality Gates',
    caption: 'Every task must pass QA, security & coverage',
    kind: 'shot',
    accent: '#ef4444',
  },
  {
    id: 9,
    clip: 'clips/scene09.mp4',
    vo: 'vo/scene09.wav',
    clipDuration: clipDur.scene09,
    label: 'Verification Gate',
    caption: 'Failures become new work items — then re-verified',
    kind: 'shot',
    accent: '#f97316',
  },
  {
    id: 10,
    clip: 'clips/scene10.mp4',
    vo: 'vo/scene10.wav',
    clipDuration: clipDur.scene10,
    label: 'Git · Merge',
    caption: 'Quality bar met — reviewed, then a real merge',
    kind: 'shot',
    accent: '#22c55e',
  },
  {
    id: 11,
    clip: 'clips/scene11.mp4',
    vo: 'vo/scene11.wav',
    clipDuration: clipDur.scene11,
    label: 'Dashboard',
    caption: 'One dashboard — the whole operation at a glance',
    kind: 'shot',
    accent: '#eab308',
  },
  {
    id: 12,
    clip: 'clips/scene12.mp4',
    vo: 'vo/scene12.wav',
    clipDuration: clipDur.scene12,
    label: 'Done',
    caption: 'From one sentence to shipped, reviewed code',
    kind: 'outro',
    accent: '#8b5cf6',
  },
];

export const sceneFrames = (s: Scene) => Math.round(s.clipDuration * FPS);
export const voDurations = voDur as Record<string, number>;
