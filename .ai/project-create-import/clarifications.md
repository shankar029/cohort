# Clarifications — project-create-import

The invocation is a delivery task with no live Q&A channel. Cohort is explicitly a **local,
single-user app** (server + user share one machine — `app.ts:147-149`; the folder picker already
browses the entire local filesystem — `listDirs`). That framing makes the three research UNKNOWNs
resolvable with strong, low-risk defaults. These are recorded as **assumptions with recommended
defaults** and are presented prominently at the Gate 2 design sign-off.

| # | Question | Recommended default (assumption taken) | Rationale |
|---|----------|----------------------------------------|-----------|
| Q1 | Where does a URL clone land on disk? | User picks a **parent directory** (reuse the existing folder picker). Repo name is derived from the URL; we clone into `<parent>/<repo-name>`. The target subdir **must not already exist** (mirrors `git clone <url>` default). | Matches native `git clone` behavior and the existing "pick a folder" UX; avoids clobbering existing dirs. |
| Q2 | Private-repo authentication? | v1 supports **public HTTPS** clone and relies on the user's **ambient git credential helper** for private repos (git CLI uses machine-configured creds automatically). Set `GIT_TERMINAL_PROMPT=0` so a missing-credential clone **fails fast with a clear error** instead of hanging. No token is stored by Cohort. | No credential handling exists today (`git.ts:70-93`); ambient creds are the standard local-dev path; failing fast avoids the #1 hang risk. |
| Q3 | URL validation / SSRF? | Accept well-formed `https://…(.git)` and `git@host:…` / `ssh://` git URLs; **require host to be a real git remote form**, trim whitespace, reject empty/malformed. No host allow-list beyond that. | The user already has full local shell + filesystem access via this app, so SSRF is not a meaningful new threat; validation is for UX correctness, not a security boundary. |

If any default is wrong, it is changed at the design gate before implementation — no code depends
on these until Phase 4.
