# OpenAI Codex protocol schemas

These six JSON schema files are third-party protocol material from OpenAI Codex, not Meeting Loop's original implementation. Copyright 2025 OpenAI. They are distributed under Apache-2.0 with the unmodified [upstream license](LICENSE.txt) and full [upstream NOTICE](NOTICE.txt) retained here. This license applies to this third-party material; it does not select a license for Meeting Loop's original code.

## Exact origin

- Generator recorded by the original project: `codex app-server generate-json-schema`.
- Recorded version: `0.154.0-alpha.6.2`; generation date: 2026-09-19.
- Public release: `openai/codex`, tag `rust-v0.154.0-alpha.6.2`.
- Resolved commit: `b5bffd3ec4db487e7e3dec59663875b0ef7b72ca`.
- Source package: `codex-app-server-protocol`, which inherits the workspace's Apache-2.0 license and version.
- [Pinned upstream license](https://github.com/openai/codex/blob/b5bffd3ec4db487e7e3dec59663875b0ef7b72ca/LICENSE), [NOTICE](https://github.com/openai/codex/blob/b5bffd3ec4db487e7e3dec59663875b0ef7b72ca/NOTICE), [package metadata](https://github.com/openai/codex/blob/b5bffd3ec4db487e7e3dec59663875b0ef7b72ca/codex-rs/app-server-protocol/Cargo.toml), and [workspace metadata](https://github.com/openai/codex/blob/b5bffd3ec4db487e7e3dec59663875b0ef7b72ca/codex-rs/Cargo.toml).

## Files and modifications

| Local file | Verified origin / treatment |
| --- | --- |
| `v2/GetAccountParams.json` | Byte-identical to the pinned upstream schema |
| `v2/GetAccountResponse.json` | Byte-identical to the pinned upstream schema |
| `v2/ModelListParams.json` | Byte-identical to the pinned upstream schema |
| `v2/ModelListResponse.json` | Byte-identical to the pinned upstream schema |
| `v2/GetAccountRateLimitsResponse.json` | Byte-identical to the pinned upstream schema |
| `InitializeParams.json` | Extracted from `definitions.InitializeParams` in the combined schema, with transitive `InitializeCapabilities` and `ClientInfo` definitions; upstream `title` omitted. A prominent `$comment` modification/attribution notice was added for release. Validation constraints are unchanged. |

The upstream files are in [the pinned schema directory](https://github.com/openai/codex/tree/b5bffd3ec4db487e7e3dec59663875b0ef7b72ca/codex-rs/app-server-protocol/schema/json); initialization is derived from `codex_app_server_protocol.schemas.json`. The [manifest](manifest.json) preserves the originally recorded hashes separately from current release hashes and pins the upstream commit.

The complete upstream NOTICE is retained conservatively, including its Ratatui attribution. This does not mean Ratatui implementation code is included in these six metadata schemas. No generator binary, model, account response, credential or runtime state is included.

## Verification scope

On 2026-10-07 the five v2 files matched upstream bytes exactly. The initialization schema matched the corresponding upstream JSON structure after the documented extraction and title omission. Only the non-validating `$comment` was then added. Source/tag identity, workspace/package license declarations and notice contents were verified through the public upstream repository.

The historical generation command was not replayed during source verification. The adapter requires the pinned schema version and refuses a mismatched installed CLI; compatibility with another version is not implied.
