# Contributing

Start with [development setup](contributing/development.md), [architecture](contributing/architecture.md), and the [user guide](docs/README.md).

## Propose and make a change

Describe the problem and intended result in an [issue](https://github.com/asMagicBrain/App/issues). For larger changes, agree on scope before implementation. Maintainers decide which contributions fit the product and release plans.

Use a focused branch and keep unrelated changes separate. Preserve the shared interface, saved files, drafts, Git history, and normal close/restart behavior. Keep test data and generated output outside the checkout; never test against a personal workspace.

Run the checks relevant to your change. Tests should verify behavior or failure handling. Documentation-only edits usually need link and rendered-reading checks. In your pull request, explain the final behavior, compatibility effects, checks run, and anything untested. Update the user guide when behavior changes.

## Protect data

Use synthetic examples. Remove tokens, account details, private repository names, personal paths, and document content from reports and screenshots. Do not run imported repository hooks, credential helpers, or project code. Live provider actions and remote writes need authorization; offline tests do not establish live account behavior.

Preserve failures and recovery evidence. Do not delete unknown data, ownership records, or old releases to make tests pass.

## License and community

Contributions of original work use the project's [MIT license](LICENSE). Retain third-party notices and identify the origin and license of adapted code or assets. This project does not require a separate contributor license agreement.

Follow the [Code of Conduct](CODE_OF_CONDUCT.md). Use [Support](SUPPORT.md) for bug-report details and [Security](SECURITY.md) for private vulnerability reports. More contributor guides are in [contributing/](contributing/README.md).
