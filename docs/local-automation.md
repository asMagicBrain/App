# Local automation

Local tools can read selected repositories and submit changes for your review. Open the **account menu → Local automation**, choose repository permissions, then **Enable for this session**.

Copy the connection path for your local tool. The connection stops working when you disconnect or quit. It is private to this computer and is not a web server.

- **Read / search:** read saved text, search, and check supported content.
- **Write:** propose an exact saved-file change.
- **Import:** propose a new ZIP repository or a reviewed package update.
- **Export:** propose a portable copy.

Writes, imports and exports wait in **Requests**. Inspect the proposed files and content before choosing **Approve this request**. **Cancel request** leaves the files unchanged. Unsaved drafts are protected.

Automation has no standalone delete operation and cannot commit, push, access account credentials or run interactive content. A reviewed full-package update can remove previously package-owned files. Imported HTML does not gain execution permission.

This initial interface accepts input ZIPs up to 256 KiB and returns exported ZIPs up to 1 MiB. Use the normal package dialog for larger collections. Retained requests also have a capacity limit; clients can read all bounds with `capabilities`. After a timeout, query status or retry the **same request ID and input**; never assume that a timeout means no work occurred.

[Back to guide](README.md)
