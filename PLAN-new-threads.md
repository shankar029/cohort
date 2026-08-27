# New Team Lead Threads Plan

**Goal:** Let the user start a fresh conversation with the Team Lead (a new
top-level thread) instead of piling every new epic into the single "Team Lead"
channel.

**Status:** done

## Design

- Reuse the existing `dm` thread kind for user↔Lead conversations (participant =
  Lead, `includesUser: true`). The single `main` thread stays as the default
  "Team Lead" channel; user-created conversations sit alongside it in a
  **Conversations** section at the top of the rail.
- A conversation auto-titles from the user's first message (ChatGPT-style).
- Sending targets the currently-selected user-facing thread (`main` or `dm`).
  Epic `group` threads stay read-only for the user (they're team discussions).
- Each conversation can still spawn an epic, which gets its own `group` thread as
  today — nothing about epic delivery changes.

## Changes

- **store:** `renameThread(threadId, topic)`.
- **api schema:** `sendChatSchema` gains optional `threadId`.
- **orchestrator:** `createLeadThread(topic?)` (creates a `dm` thread, publishes
  `thread.updated`); `chat(content, threadId?)` routes to the target thread,
  auto-titles a fresh `dm` from the first message, and scopes history + the Lead
  reply to that thread.
- **app.ts:** `POST /api/projects/:id/threads` → `createLeadThread`; `POST /chat`
  forwards `threadId`.
- **client:** `api.createThread`, `sendChat(…, threadId?)`; ChatPage gets a
  "+ New" button, a Conversations section, per-thread send, and a read-only
  composer hint on group threads.

## Tests

- Integration: `POST /threads` creates a `dm` thread; a chat to that thread posts
  the user msg + Lead reply there (not main) and auto-titles it.
- E2E: "+ New" creates a conversation, selecting it, sending routes there.
