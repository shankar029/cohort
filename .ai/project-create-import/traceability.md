# Traceability — project-create-import

| AC  | Requirement | Design (component/method) | Task | Test / check | Evidence | Verdict |
|-----|-------------|---------------------------|------|--------------|----------|---------|
| AC1 | Create a new project from a local repo dir (existing) — regression-guarded | validateRepoDir + createProjectWithLead (unchanged); createProjectSchema back-compat | I1 | back-compat unit test; existing validateRepoDir/fsBrowse tests; _createdir e2e | — | — |
| AC2 | Import a project by GitHub URL: clone locally, then create project from the clone | cloneRepoToDir (clone.ts) + importProjectFromUrl + POST branch | I2 | integration: clone fixture → project created | — | — |
| AC2.1 | Invalid/malformed URL rejected with clear error | isGitUrl refine in createProjectSchema; deriveRepoName | I1, I3 | unit: isGitUrl table; route 400; modal inline error e2e | — | — |
| AC2.2 | Clone failure surfaces clear error, no hang, no partial project | cloneRepoToDir (GIT_TERMINAL_PROMPT=0) + importProjectFromUrl (no store write on fail) | I2 | integration: failure → 400, no row, bounded time | — | — |
| AC2.3 | New Project modal offers import-by-URL vs create-local | CreateProjectModal tabs (+ FolderPicker reuse) | I3 | e2e: tabs render, import fields show | — | — |
