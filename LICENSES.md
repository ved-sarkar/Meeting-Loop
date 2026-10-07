# Third-party licensing and provenance

No license has been selected for Meeting Loop's original code. The third-party terms below do not license the application as a whole.

The exact npm versions, resolved locations and integrity hashes remain in package-lock.json. Declared dependency licenses are summarized in docs/dependency-licenses.json. Direct dependencies include React and React DOM (MIT), Lucide React (ISC), Electron and Vite (MIT), Electron Packager (BSD-2-Clause), and Playwright Test (Apache-2.0). These declarations are copied from local metadata, not newly verified online.

The six generated Codex protocol schemas were verified against public tag `rust-v0.154.0-alpha.6.2` (commit `b5bffd3ec4db487e7e3dec59663875b0ef7b72ca`). The upstream package inherits Apache-2.0; its full LICENSE and NOTICE are retained in `server/providers/protocol/`. Five schemas match upstream bytes exactly; the extracted initialization schema carries a modification notice. See [schema provenance and notices](server/providers/protocol/README.md). Swift uses Apple system frameworks without copied framework binaries. The icon-generation source is retained, but generated image assets and application binaries are omitted.

External Ollama, whisper.cpp, FFmpeg, model weights and Electron runtime binaries are not included. Any later binary distribution needs a separate review of the actual bundled versions and notices, including Chromium, model and FFmpeg terms. The source-only dependency metadata is not a license audit of a future packaged application.
