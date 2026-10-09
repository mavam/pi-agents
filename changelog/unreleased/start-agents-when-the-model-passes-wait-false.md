---
title: 'Start agents when the model passes wait: false'
type: bugfix
authors:
  - mavam
created: 2026-10-08T19:37:48.402907Z
---

Pi no longer fails to start an agent when the model passes `wait: false` for "don't wait", or quotes the number of seconds. Such values now mean no wait, and quoted numbers count.
