# ADR-0001: License the platform under AGPL-3.0-only

Date: 2026-10-16
Status: accepted

## Context

openupstream's business is running this code as a hosted service. A
permissive license (Apache-2.0, MIT) would let a larger hoster take the
control plane, run it as their own product and contribute nothing back.
Several comparable projects (Coolify, Plausible, Cal.com) chose AGPL for the
same reason.

## Decision

AGPL-3.0-only for everything in this repository, including the SDK and CLI.
Dependencies we run but do not modify are not affected.

## Consequences

- Anyone may self-host, modify and offer the platform as a service, provided
  they publish their modifications under the AGPL.
- Some companies refuse AGPL code in their own products. The SDK and CLI are
  the only parts customers embed; if that becomes a real obstacle, those two
  packages can be relicensed to Apache-2.0 later without touching the platform.
- Contributions are accepted under the same license (see CONTRIBUTING.md); no
  CLA for now.
