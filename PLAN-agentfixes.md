# ateam — Agent UX + Orchestration Fixes

**Status:** done

## Goal
Fix agent-management UX and make the Team Lead a real, self-driving manager.

## Steps
- [x] Replace avatars with user's transparent PNGs (13 mapped, downscaled 256px)
- [x] 1. Avatars render transparent (blend w/ page), Team Lead avatar shows
- [x] 2. Remove-agent works (root cause: body-less DELETE sent `Content-Type:
       application/json` → Fastify 500; now only set it with a body) + added a
       Remove button to the Agents list page
- [x] 3. Block adding a catalog agent already on the team (UI “Added” badge +
       server 409 guard)
- [x] 4. Add multiple agents without the panel closing (catalog adds keep it open)
- [x] 5. Route specialist “needs input” → Team Lead decides → escalate to user
       only when it needs a human (ESCALATE protocol); answer relayed back
- [x] 6. Team Lead self-heals: assigns backlog+todo, re-drives assigned/stalled
       work each tick, empty-build parks + auto-resumes on answer

## Decisions log
- Avatars: user supplied transparent set; code-reviewer←WHITE+CHK, data-engineer←N2
  (N1/N14 still had baked checker). Avatar `src` renders bare/transparent (no tint).

## Risks
- Orchestration changes (5,6) touch the lead loop — must not crash ticks or
  double-run work items. Guard with existing status checks + tests.
