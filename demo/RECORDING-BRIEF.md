# Cohort Demo — Recording Brief (for real screen-capture footage)

Goal: capture the app **actually working** so I can edit it into a professional ~2:00 demo.
Judges only see the demo — so we lead with the "wow" (a whole team spins up from one message),
then show how it works, then the payoff (PR → merge).

---

## Global capture settings (do this once)
- **Resolution:** record the browser at **1920×1080** (maximize window on a 1080p screen, or set
  the browser window to 1920×1080). If your display is 4K, even better — record 1920×1080 region.
- **Frame rate:** 60fps if the recorder allows, else 30fps.
- **Format:** MP4 (H.264) or WebM. Either is fine.
- **Clean chrome:** hide the bookmarks bar, use a clean/empty browser profile, full-screen the app
  (F11) if you want to avoid the browser toolbar — I'll add a stylized browser frame in the edit.
- **Cursor:** keep it visible. Move deliberately and **pause ~1s** on the thing you're pointing at.
- **Pace:** move slowly and let UI settle. Record each clip **5–10s longer than needed** — I trim.
- **Audio:** no need to talk; I'll use the existing voiceover. (If you accidentally record system
  sound, that's fine, I'll mute it.)
- **One action per clip.** Separate files are easier to edit than one long take (but a long take is
  OK too — just tell me the timestamps).

Name the files `clipA_chat.mp4`, `clipB_dashboard.mp4`, etc., and drop them in `demo/footage/`.

---

## Shot list (8 clips) — mapped to the story

### Clip A — "The one message" (Threads / Chat)  ⭐ hero
Show the **Team Lead** conversation. Type a real, meaty request and hit send, e.g.
> "Build a landing page: hero, features, pricing, and a contact form — with tests."
Let the Lead start responding / planning. Capture the send + first reply.
**~15–25s.** This is the cold-open hook.

### Clip B — "A team wakes up" (Dashboard)  ⭐ hero
Go to **Dashboard** right as work kicks off, so the counters move:
Epics, Active tasks, **Working now**, Open PRs going from 0 → non-zero, and "Active now" showing
agents spinning up. If it's already populated, a slow pan/scroll over the live numbers works.
**~10–15s.**

### Clip C — "Work, decomposed" (Board / Kanban)  ⭐ hero
The **Board** with real cards: tasks across **Backlog → In Progress → Review**, cards showing the
assigned agent avatar + stream tag (frontend/qa/etc.) + progress bars. If a card auto-moves columns
while recording, gold. Otherwise slowly scroll across the columns.
**~15–20s.**

### Clip D — "Agents brainstorm" (Threads → team discussion)
Open a **team discussion** thread where specialists are posting (Frontend Engineer, QA, Team Lead…),
including a live **"… is working"** typing indicator. Slowly scroll through a few messages.
**~15–20s.**

### Clip E — "Watch them think" (Activity)
The **Activity** feed streaming live log lines — reasoning, tool calls, timestamps ticking.
Let several new lines appear. **~10–15s.**

### Clip F — "Your team" (Agents)
The **Agents** page: Team Lead + the specialist roster. Optional flourish: open **Add agent**,
show the catalog, click **Add** on one so it joins the team. **~10–15s.**

### Clip G — "Ship it" (Git / PR)  ⭐ payoff
The **Git** view: epic branch + isolated worktree, commits list, and ideally a **PR → review →
"Merged"** state. Scroll from commits down to the merged badge. **~15–20s.**

### Clip H — (optional) Result
Anything that shows the actual output the team produced (a merged diff, a built page, a passing
test run). Even 5–10s adds a strong payoff.

---

## Nice-to-have extras (only if easy)
- A quick clip of **switching between two projects/teams** (shows parallel teams).
- A clip of an **escalation** (an agent's question routed to you) and your answer flowing back.
- **Recordings** or **Notifications** panel with real content.

---

## What I'll do with the footage
- Composite each clip in a clean rounded browser frame on a branded background.
- Add subtle **cursor-follow zooms / punch-ins** on the key moments (counters ticking, a card moving,
  the Merged badge).
- Sync the existing **voiceover** + animated captions to each clip; add smooth transitions and light
  **background music**; color/scale-normalize everything to 1080p.
- Deliver the final `cohort-demo.mp4` (~2:00).

If any clip is a different length than suggested, no problem — I adapt the edit and can re-pace the
voiceover to match.
