Operational runbooks. Each one is written the first time the procedure is done
for real, or before as a draft marked as such, which the first run fills in.

- [failover-test.md](failover-test.md): switch a whole compute Site off, check
  that writes continue, then fail back.
- [restore-from-backup.md](restore-from-backup.md): restore a Database to a
  point in time from Hetzner Object Storage.
- [node-maintenance.md](node-maintenance.md) (draft, not yet run): take one
  node out for a k3s upgrade, operating system updates or a repair, and
  back, without downtime for customers.

Planned: bootstrap, add-node, rotate-secrets.
