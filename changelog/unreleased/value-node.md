---
title: Pure data leaves with value nodes
type: feature
authors:
  - mavam
  - claude
prs:
  - 15
created: 2026-07-24T20:24:02.542830Z
---

The new `value` node yields a template-interpolated JSON value without
spawning an agent. A string that is exactly one `{reference}` substitutes
the referenced JSON value itself — type preserved — while mixed strings
interpolate as text:

```yaml
kind: value
value:
  files: "{scout.files}"        # the array itself, not a string
  summary: "saw {scout.count}"  # interpolates as text
  reviewed: true
```

Use it to shape outcomes or as a `switch` arm that returns an existing
binding — previously that required an agent whose only job was to echo.
