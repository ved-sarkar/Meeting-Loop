# Feature status

Meeting Loop is a personal macOS prototype. This page describes the implemented product and the boundaries relevant to trying it. The [validation record](docs/VALIDATION.md) lists what has actually been tested.

| Area | Available in the source | Current boundary |
| --- | --- | --- |
| Meeting workspace | Overview, transcripts, separate personal notes, settings, themes and floating copilot | Desktop interaction checks remain unverified in the latest restricted test environment; accessibility and multi-monitor behavior need evaluation |
| Audio capture and recovery | Swift capture helper, consent flow, durable chunks and recovery journals | Synthetic recovery tests passed; real two-sided calls, device changes, sleep and long sessions are unvalidated |
| Transcription | Local whisper.cpp adapter, queued work, retries, timestamps and corrections that preserve original evidence | Diarization, overlapping speech, final-pass reconciliation and transcription quality are not established |
| Notes and questions | Versioned notes, evidence-linked decisions and questions, local streamed answers and cancellation | Model output requires review; extraction accuracy and preferred writing styles have not been systematically evaluated |
| Project memory | Project-scoped lexical search, source references, briefs and artifact integrity checks | Search is not semantic; large-vault performance is unbenchmarked |
| Action items | Source-constrained proposals, explicit approval, deduplication, cancellation and stale-context checks | Complex commitments and relative dates can be missed; no general unattended scheduler |
| Local drafts | Saved report proposals and unsent email drafts with no inferred recipient | No email/calendar publishing connector or general code-execution agent; a draft is not externally completed work |
| References | Explicit text/PDF import and local screenshot preview | Text models cannot interpret image pixels; PDF extraction expects a local command-line dependency |
| Local data | SQLite vault, scoped paths, exports, backups, core restore and managed deletion | Local storage is not encryption; restore and scheduled retention do not have complete user interfaces |
| Integrations | Local inference adapters, read-only MCP interface, optional version-gated Codex metadata | Cloud generation and paid fallback are disabled; cloud access to vault text requires an explicitly configured client and scope |
| Distribution | Editable source, dependency lockfile, build and synthetic test scripts | Fresh-machine installation, packaged distribution and notarization are not validated |

The built-in fictional example supports exploration without capture or model inference. Generating notes, answers and drafts requires separately provisioned local models. See the [demo guide](docs/DEMO.md) and [architecture](docs/ARCHITECTURE.md).
