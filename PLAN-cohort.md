# Cohort Rebrand + Comic Theme Plan

**Goal:** Rename the app to **Cohort**, install the new logo + comic mech agent
avatars, and add a **Comic** palette available in both light and dark modes.
**Status:** done

## Decisions
- Rename **user-facing** strings only ("A Team" → "Cohort"). Internal identifiers
  (`ATEAM_*` env, `.ateam/` workspace prefix, git authors/branches, DB path,
  `ateam-theme`/`ateam:*` localStorage keys, package name) stay unchanged — changing
  them risks breakage for zero user benefit.
- New avatars are comic mech heads with mixed backgrounds (some transparent, most with
  baked comic-burst/solid backgrounds). Render them in a **uniform rounded frame**
  (object-cover) so they read as consistent comic badges. Team-Lead avatar + brand mark
  are derived from the **Cohort logo head**.
- Theme gains a second axis: **palette** (`default` | `comic`) × **mode**
  (`dark` | `light`) = 4 looks. Palette applied as a `comic` class on `<html>`;
  persisted under `ateam-palette`.

## Avatar mapping (source → role)
- team-lead → Cohort logo head (crop) · mark.png ← same head
- product-manager → agent11 · architect → agent2 · ux-designer → agent9
- frontend-engineer → agent7 · backend-engineer → agent5 · qa-engineer → agent6
- devops-engineer → agent8 · docs-writer → agent1 · researcher → agent3
- code-reviewer → agentr12 · security-auditor → agent4 · data-engineer → agent10

## Steps
- [x] 1. Asset pipeline script → 13 avatars (256²) + mark.png; verify contact sheet.
- [x] 2. Avatar component: framed illustrated avatars (object-cover).
- [x] 3. Rename user-facing strings to Cohort.
- [x] 4. Comic theme: theme.ts palette axis + index.html pre-paint + index.css
       (`.comic.dark`/`.comic.light` vars, ink borders, hard shadows, comic font,
       halftone bg) + palette toggle in the UI.
- [x] 5. Verify: tsc · eslint · prettier · vite build · e2e screenshots of all four
       looks (test-results/cohort/). Default theme unchanged; comic light = newsprint
       pop-art, comic dark = neon ink.

## Risks & rollback
- Baked avatar backgrounds could clash → mitigated by the uniform frame.
- Comic font (Comic Sans MS / Comic Neue) relies on locally-installed fonts; falls
  back to the sans stack if absent.
