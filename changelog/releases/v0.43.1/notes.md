Agent creation now treats empty or whitespace-only profile names as omitted instead of reporting an unknown profile error.

## 🐞 Bug fixes

### Treat blank profile names as omitted

Agent creation now treats an empty or whitespace-only profile name the same as an omitted profile. Unknown non-blank names still produce an error.

*By @sunnysab in #137.*
