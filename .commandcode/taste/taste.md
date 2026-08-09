# Taste
See [taste/taste.md](taste/taste.md)

### Workflow & tooling
- References code via IDE-provided `ide-context` tags (file path + line number) rather than manually pasting code snippets or describing locations in prose — relies on IDE integration to inject precise file/line context into requests. Confidence: 0.75
- After verification, cleans up all temporary artifacts: kills background servers, frees ports, deletes temp build/export directories and screenshot files, closes browser sessions, and runs a final check confirming no processes or ports remain. Confidence: 0.85
- Before removing a shared field or helper during a refactor, audits all usages first (grep references), checks whether every remaining consumer/provider can still produce it, keeps it if it has non-task-specific meaning, and removes only the task-exclusive behavior — never blindly deletes a field just because it was originally introduced for the feature being removed. Confidence: 0.8
- Scopes changes tightly to the relevant package/boundary and avoids touching server, CI, and unrelated subsystems (map implementation, polling intervals, the API client, unrelated UI) unless the task explicitly requires it. Confidence: 0.8
- When a feature is being *completely removed* (e.g. its server-side support no longer exists), deletes it outright — including the feature's code, comments, and documentation — and does not leave "disabled" stubs, fallback adapters, or empty compatibility arrays behind (distinct from temporarily-unwanted features, which are kept disabled-but-present for re-enablement). Confidence: 0.75

### Debugging & validation workflow
- When the full test suite hangs or times out, systematically runs each test file individually with a per-file timeout (e.g. `timeout 15 node --test test/filename.test.js`) to isolate which file is hanging rather than guessing. Confidence: 0.75
- Verifies that lint/test errors are pre-existing (not introduced by the current change) using `git stash`/`git stash pop` before deciding not to fix them — only fixes lint errors in files the current change touches. Confidence: 0.75
- After running build tooling (tsc/lint/expo export), confirms the tools did not mutate source files — e.g. grepping for compiler/export markers and inspecting pre-existing modified files to distinguish in-progress work from the change's own footprint. Confidence: 0.8
- Scopes lint validation to specific modified files (e.g. `npx eslint src/alerts.js test/alerts.test.js`) rather than running the full project lint, to keep fast feedback loops focused. Confidence: 0.75

### Code style & linting
- Lint convention: prefix intentionally-unused destructured variables with `_` (e.g. `{ fp: _fp, ...alert }`) to satisfy `no-unused-vars` rules rather than disabling the rule. Confidence: 0.85
