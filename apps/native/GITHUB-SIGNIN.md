# Optional GitHub connection

GitHub connection is separate from the application account. Local repositories, Save, search, and commits need neither. Builds default to offline configuration. See [build configuration](../../contributing/development.md#configure-optional-accounts) and [user privacy](../../docs/accounts-and-privacy.md).

## Registration and consent

A registered build selects a public GitHub App Client ID and slug, with device flow and appropriate read-only permissions. Never include a client secret, private key, or token. Registration does not grant user consent, installation access, or account eligibility.

The host uses fixed admitted GitHub endpoints; the renderer cannot redirect credential traffic. Package metadata records registration identity.

## Session behavior

The account button starts the code/browser flow, with status, retry, and Cancel. GitHub owns credential entry and consent. The renderer receives display information and opaque status identifiers, never tokens or the private device code.

Copy feedback belongs to one expiring attempt. Late responses cannot replace another code or reopen a closed dialog. Pending authorization supplies no private-operation credential. Connecting does not change Git author preferences; adopting profile details is a separate action.

Tokens stay in main-process memory until full quit. The app does not persist them in Keychain or read earlier credential files. Renderer recovery can keep the host session; restarting needs reconnection. Disconnect settles authenticated work before forgetting identity and preserves local files.

## Host and tests

`github-account-coordinator.mjs` serializes account changes and clone/check cancellation. Normal close pauses authorization, invalidates requests, and drains work. Failed close may resume ordinary work without reviving a cancelled flow. Transport has fixed endpoints, deadlines, response limits, and sanitized errors.

Keep device codes, tokens, secrets, and raw provider responses out of logs, screenshots, repository config, and public response objects. Anonymous acquisition never silently borrows account credentials.

Synthetic tests cover local state transitions. Real login, refresh/revocation, installation access, and private clone/update each need authorized live checks with disposable data. A device-code request alone proves only initiation. See [native acceptance](acceptance/README.md).
