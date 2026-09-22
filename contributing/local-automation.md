# Local automation protocol 1

The desktop host owns file access, expected hashes, drafts and publication. The client connects to one running app through a same-user Unix socket. No HTTP, remote agent, separate workspace writer, commit, push, deletion or artifact-run interface is provided.

Enable explicit repository scopes in the account menu. Copy the connection-file path, then invoke the installed executable. On macOS:

```sh
/Applications/asMagicBrain.app/Contents/MacOS/asMagicBrain \
  --automation-cli --connection /absolute/connection.json \
  --request /absolute/request.json
```

On Ubuntu preview use `/opt/asmagicbrain-preview/asmagicbrain`. Omit `--request` to read one UTF-8 JSON object from stdin. This process is a client; it exits before profile, window or host setup. The connection file contains a session token: never copy it into logs, repositories or bug reports.

## Discover and read

```json
{"protocolVersion":1,"requestId":"cap-1","operation":"capabilities","args":{}}
```

Replies contain `protocolVersion`, matching `requestId`, `ok`, and either `value` or a bounded `error`. `catalog` with `{}` lists read-granted repositories; use their `stableId` as `repoId`. IDs are local and survive managed rename. They are not portable collection IDs.

| Operation | `args` |
|---|---|
| `read` | `repoId`, relative `path` |
| `search` | `repoId`, literal `query`, boolean `caseSensitive` |
| `validate` | `repoId` |
| `status` / `cancel` | `operationId` (operation UUID or original request ID) |

Read returns saved `text` and SHA-256 `sourceHash`. Validation is bounded (256 files, 64 KiB text each), reports truncation, and distinguishes import support, preview support, runtime eligibility and permission. It never runs the imported content or verifies an author's scientific claim.

## Propose a write

```json
{
  "protocolVersion":1,
  "requestId":"write-note-1",
  "operation":"write.plan",
  "args":{"repoId":"ID_FROM_CATALOG","path":"notes/example.md","expectedHash":null,"text":"# Example\n"}
}
```

`expectedHash:null` means the path must be absent. Replacing a saved file requires its exact SHA-256. The plan lists before/after content and hashes. Only explicit approval in the app can apply it, after revalidating source and drafts. The client cannot send an approval command.

Other reviewed operations:

| Operation | Exact arguments besides `repoId` |
|---|---|
| `import.plan` | `name`, `archiveBase64`; creates an unborn local Git repository with no automatic commit |
| `package.plan` | `archiveBase64`, `semantics` (`patch` or `snapshot`), `version`, `choices` array of `{path,choice}`; target must have a recorded original package |
| `export.plan` | `kind` (`source` or `offline`), `collectionId`, `version`; completed result carries a bounded ZIP as base64 |

Choices are `keep-current`, `use-incoming`, or `keep-both`, where the reviewed row permits them. Package ownership and recovery rules are described in [package exchange](package-exchange.md).

## Lifetimes and limits

Requests are serialized through the running host. The private operation journal binds a request ID to its exact input digest. Retrying identical input returns its existing operation; different input under the same ID fails. Completion is journaled. Interrupted writes are inspected against saved hashes, and imported repositories are matched against the importer's durable identity/digest receipt. Unproven effects require a new review; restart never blindly replays them.

Grants and connection tokens do not survive disconnect or quit. Durable request receipts do. Closing revokes admission and drains accepted work before the profile owner releases its lock. A cancelled app close leaves automation disabled until explicitly enabled again.

Initial bounds are disclosed by `capabilities.limits`:

| Field | Bound |
|---|---|
| `requestBytes` | 1 MiB inbound JSON frame, unchanged for every operation |
| `textBytes` / `archiveBytes` | 64 KiB proposed text / 256 KiB input ZIP |
| `resultBytes` | 512 KiB ordinary retained result |
| `exportArchiveBytes` / `exportResultBytes` | 1 MiB exported ZIP / 1.5 MiB serialized export result, including base64 and warnings |
| `responseBytes` | 2 MiB outbound frame for completed export/status/retry receipts only; other responses remain limited to 1 MiB |
| `operations` / `journalBytes` | 16 retained mutation requests / 3 MiB complete journal state |

The larger export allowance accommodates a small offline reader with its bundled math fonts. Completed exports retain the exact ZIP, checksum and filename across restart; status does not rebuild from changed source. Larger exports use the normal package UI.

Before applying a reviewed operation, the broker reserves space for its maximum completed result. Insufficient space refuses approval before any effect. An interrupted operation holds that capacity: new mutation plans/approvals wait until status inspection or explicit package recovery resolves it. A rejected read-only export leaves a failed receipt and does not prevent ordinary app use.

There is no silent expiration of idempotency receipts. When full, the API refuses new mutations; the normal app remains available. `--timeout-ms` accepts 10–300000 ms; default 30000. A timeout never triggers an automatic retry.

The CLI waits for its complete response to finish writing before exiting. Output has a separate 30-second bound; a broken or blocked output pipe returns a nonzero exit status without sending the request again or appending a second response. Treat incomplete output as an uncertain receipt and check the original operation's status.

Scopes are cooperative same-user boundaries, not protection against a fully compromised operating-system account. Executable qualification and denied-path/race evidence belong in DevDocs; this guide defines the interface only.
