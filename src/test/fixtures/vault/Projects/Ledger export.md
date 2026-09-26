---
title: Ledger export
aliases:
  - Ledger CSV
  - LEDG export
tags: [project, finance/ledger]
status: active
owner: "[[Dana Kim]]"
jira: LEDG-142
---
# Ledger export

Monthly export of the general ledger to CSV for the finance team. Owned by
[[People/Dana Kim|Dana]]. Tracked in LEDG-142. #q3

## Decisions

- Keep the export in UTC; finance converts on their side.
- Retention of generated files is 90 days.

## Open questions

- Does the auditor need the reversal entries?

```bash
# regenerate locally (#notatag, [[Not A Link]])
make ledger-export
```
