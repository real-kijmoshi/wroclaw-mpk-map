# Taste
See [taste/taste.md](taste/taste.md)

### Workflow & tooling
- References code via IDE-provided `ide-context` tags (file path + line number) rather than manually pasting code snippets or describing locations in prose — relies on IDE integration to inject precise file/line context into requests. Confidence: 0.75
- Before removing a shared field or helper during a refactor, audits all usages first (grep references), checks whether every remaining consumer/provider can still produce it, keeps it if it has non-task-specific meaning, and removes only the task-exclusive behavior — never blindly deletes a field just because it was originally introduced for the feature being removed. Confidence: 0.8
- Scopes changes tightly to the relevant package/boundary and avoids touching server, CI, and unrelated subsystems (map implementation, polling intervals, the API client, unrelated UI) unless the task explicitly requires it. Confidence: 0.8
- When a feature is being *completely removed* (e.g. its server-side support no longer exists), deletes it outright — including the feature's code, comments, and documentation — and does not leave "disabled" stubs, fallback adapters, or empty compatibility arrays behind (distinct from temporarily-unwanted features, which are kept disabled-but-present for re-enablement). Confidence: 0.75
