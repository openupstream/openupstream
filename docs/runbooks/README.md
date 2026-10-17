Operational runbooks. Each one is written the first time the procedure is done
for real, not before.

- [failover-test.md](failover-test.md): switch a whole compute Site off, check
  that writes continue, then fail back.
- [restore-from-backup.md](restore-from-backup.md): restore a Database to a
  point in time from Hetzner Object Storage.

Planned: bootstrap, add-node, rotate-secrets.
