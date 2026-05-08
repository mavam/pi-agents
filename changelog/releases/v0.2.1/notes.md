This release keeps the extension compatible with current Pi releases after the upstream package-scope migration and streamlines the README installation instructions.

## 🐞 Bug fixes

### Pi package scope migration compatibility

The extension now works with Pi's new `@earendil-works/*` package scope after the upstream repository migration. Users can install or build the package against current Pi releases without resolving stale `@mariozechner/*` internal package references.

*By @mavam.*
