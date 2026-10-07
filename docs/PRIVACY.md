# Privacy and data boundaries

The application stores meeting content in a local vault. Local storage is not encryption, and this prototype is not a clinical or organizational compliance certification.

Capture begins only after an explicit consented action. Real recordings, meeting transcripts, notes, screenshots, reference documents and generated email/report artifacts do not belong in source control. Use only fictional example content in public demonstrations.

Inference defaults to local Ollama and whisper.cpp. Cloud generation and paid fallback are disabled. The optional official Codex metadata adapter can contact an external service only after a user-initiated connection check; it is not required for the synthetic example or unit tests.

The local read-only MCP interface can expose selected vault text to a client. Connecting it to a cloud assistant is a separate data-sharing decision requiring approved scope. It is not automatically registered.

Do not publish vault backups, logs or screenshots without a separate content review. Git ignore rules reduce accidents but cannot stop a forced addition or cleanse past commits. Keep runtime vaults, credentials and personal data outside the repository.
