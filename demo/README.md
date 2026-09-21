# Cohort — Hackathon Demo Video (v6: real footage cut, ~1:52)

A ~1:52, 1080p/30fps narrated product demo, edited from a **real recorded Cohort run**
("Build a personal finance manager app"), composited in Remotion with a branded browser
frame, punch-in zooms, animated captions, an **Azure Neural TTS** voiceover, and a soft
music bed.

## Output
- **`video/out/cohort-demo.mp4`** — the finished demo (1920×1080, H.264 + AAC, ~112s,
  loudness-normalized to ~-16 LUFS).

## Story (12 beats — team-first, with a verification-gate arc)
1. **Create the team** — Agents: Add-agent catalog → roster → per-agent model → system prompt
2. **Hook** — send one message to the Team Lead (request typing is sped up)
3. **The brief** — attach a brief, hit send; that one sentence becomes the plan
4. **Team online** — the Lead plans parallel streams
5. **Decomposed** — Kanban board fills with stream-tagged tasks
6. **Team discussion** — specialists brainstorm and align in a shared thread
7. **Review catch** — the Code Reviewer catches a real bug and blocks the PR
8. **Quality gates** — Notifications: QA/security/coverage sign-off blocked; Lead assigns fixes
9. **Verification gate** — failures become new work items (Task-details + Gate badges), re-verified
10. **Merge** — Git: PR open, independent review, real merge
11. **Dashboard** — command center: metrics, task distribution, tokens, who's active
12. **Done** — final dashboard (10/10 completed) → brand outro

## Speed / time-remap
`cut-clips.sh` accepts an optional source-span arg: the clip is time-remapped to fill the
scene. Used to **speed up** the slow request-typing (scene02 1.6×, scene03 1.27×, scene01
1.2×) and gently **slow** the short Notifications window (scene08).

## Source clips
Cut from `C:/Users/shbs/Downloads/Cohort-Demo-1-1.mp4` by `cut-clips.sh` into
`video/public/clips/scene0N.mp4` (12 clips) — each timed to its voiceover line + padding,
with optional speed/slow time-remap. Edit the start/duration/span in `cut-clips.sh` to re-cut.

## Voiceover (Azure Neural TTS)
- Script text: `vo-scenes.json` (one block per scene).
- Generator: `gen-vo-azure.mjs` → writes `video/public/vo/scene0N.wav` + `vo-durations.json`.
- Uses Azure Speech creds from `C:/code/projects/wonder-studio/.env`
  (`AZURE_SPEECH_KEY`, `AZURE_SPEECH_REGION`, `AZURE_SPEECH_VOICE`).
- Voice: `en-US-AndrewMultilingualNeural` (override with `COHORT_VOICE`, rate with `COHORT_RATE`).

```bash
cd demo
node gen-vo-azure.mjs                 # regenerate VO + durations
cp vo-durations.json video/src/vo-durations.json   # keep the copy Remotion imports in sync
```

## Music
`video/public/music/bed.mp3` — a soft ambient pad generated with ffmpeg (mixed at 12% under
the VO). Replace the file to swap the track.

## Build the video
```bash
cd demo/video
npm install
npm run studio        # preview/edit interactively (localhost:3000)
npm run build:video   # render + loudness-normalize -> out/cohort-demo.mp4
```
(`build:video` = `render` to `out/cohort-demo-raw.mp4`, then `finalize` normalizes audio.)

## Tweaks
- **Captions / labels / accent colors / punch-in focus:** `video/src/scenes.ts`.
- **Layout & motion (browser frame, zoom, brand cards):** `video/src/SceneView.tsx`.
- **Re-cut a beat:** change start/duration in `cut-clips.sh`, re-run, then re-render.
- **Different length/pace:** edit `vo-scenes.json`, regenerate VO, re-cut clips to match.

## Files
- `SCRIPT.md` — the narration + on-screen mapping.
- `vo-scenes.json`, `gen-vo-azure.mjs`, `vo-durations.json` — voiceover.
- `cut-clips.sh` — extracts the source sub-clips.
- `video/` — the Remotion project (`src/`, `public/clips`, `public/vo`, `public/music`).

> Note: the older screenshot-based first draft (`gen-vo.ps1`, image shots) has been
> superseded by this real-footage cut.
