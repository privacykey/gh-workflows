# Disposable job cleanup

Place this action immediately after the trusted-runner guard and **before checkout**.
It registers a final `always()` post-action. GitHub executes post-actions in reverse
registration order, so later cache saves, artifact uploads and checkout credential
cleanup finish before generated output is removed.

List only reproducible output relative to `github.workspace`. Absolute paths,
parent traversal, the workspace root and Git metadata are refused. Symlink
ancestors are refused; a listed terminal symlink is unlinked without following it.
`.ci-derived-data` is always included. The action exports `CI_DERIVED_DATA`,
`GYM_DERIVED_DATA_PATH` and `SCAN_DERIVED_DATA_PATH`; direct Xcode invocations must
pass `-derivedDataPath "$CI_DERIVED_DATA"`. Archives, exports and distribution
packages should remain outside the declared cleanup paths.

With `simulators: 'true'`, create devices using `CI_SIMULATOR_NAME_PREFIX` or the
`simulator-name` output. A device may append a profile suffix such as `-ipad`.
Pass `instance: ${{ strategy.job-index }}` for matrix jobs. Only this run, attempt,
job and matrix instance's names and their numbered test clones are removed.
The action does not delete shared devices, runtimes or other accounts' storage.
Cleanup works after success, failure or normal cancellation, including creation
that failed before a device ID was returned. A stopped/offline runner cannot
execute a post-action. Deletion failures fail the cleanup instead of claiming success.
