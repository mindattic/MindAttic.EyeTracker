# MindAttic project agent entrypoint

Read the shared protocol at ..\mindattic-agent-standard\AGENTS.md and this project's own
documentation. Common prompt commands are implemented by the shared runner; do not add a second
copy under a provider-specific command folder.

Project context: `docs/ARCHITECTURE.md` (how gaze is computed, the three platform clients),
`docs/PROTOCOL.md` (the bridge wire format every client speaks), `docs/BEST-PRACTICES.md`.
Build with `npm run build`. Tests are `npm test` (vitest), run only when the user asks.
