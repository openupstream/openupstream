# ADR-0002: Three Sites at three providers

Date: 2026-10-16
Status: accepted

## Context

The v1 plan ran everything in two Hetzner locations, FSN1 and NBG1. Two of
its parts need a majority to keep working:

- **etcd** (the k3s datastore). With members split 2+1 or 3+2 across two
  Sites, losing the larger Site loses quorum. Without the Kubernetes API,
  CloudNativePG cannot fail over, so a Database whose primary was in that
  Site stays down until someone resets etcd by hand.
- **Garage**. With replication factor 2 across two Sites, losing either Site
  makes object storage read-only (write quorum is 2). With replication factor
  3 across two Sites, some partitions also lose read quorum. Garage has no
  witness or arbiter node, so a third Site must hold a full copy of the data.

The requirement is that the loss of any one Site still lets applications
write to their Databases and Buckets. Customer data must stay in the EU.

What we found when placing the Sites (checked 2026-10-16):

- Hetzner offers its standard dedicated servers only in FSN1 and HEL1, not
  NBG1. A 64 GB cloud server in NBG1 costs about €276/month, against €59 for a
  64 GB dedicated server.
- FSN1↔HEL1 is about 1,500 km and 25 ms round-trip, too far for the two
  Postgres instances.
- OVHcloud Limburg (Frankfurt region) is about 300 km and 6 ms from FSN1, with
  64 GB dedicated servers at about €74/month.
- netcup Nuremberg is about 3 ms from FSN1 and sells small VMs.
- Hetzner sells no managed Kubernetes and has no product that fails over
  between locations by itself. Its API was partly down for 1.5 hours on
  2026-10-14.

## Decision

- Run one k3s cluster across three Sites with one etcd member each:
  - `hetzner-fsn1`: Hetzner dedicated server, compute Site, default Home site.
  - `ovh-lim`: OVHcloud dedicated server in Limburg, compute Site.
  - `netcup-nbg`: netcup VM in Nuremberg, etcd and a Garage zone only.
- Databases have two instances, one per compute Site. Their failover needs
  the Kubernetes API, not a third Postgres instance.
- Garage uses replication factor 3 with one zone per Site.
- Nodes connect over public IPs with WireGuard. Ingress is active-active in
  both compute Sites, with DNS health checks dropping a failed Site.

## Consequences

- Any one Site, or any one provider, can fail and Databases, Buckets and the
  Kubernetes API keep accepting writes. Services from a failed compute Site
  restart in the other one.
- All customer data is in Germany today.
- There is no private network across providers. All node traffic crosses the
  public internet inside WireGuard, and no failover IP can move between
  providers, which is why ingress relies on DNS.
- Three hosting providers to contract with and list as subprocessors, three
  Terraform setups (netcup has no official provider).
- Object storage costs three copies of every byte. Unit prices for Bucket
  storage have to cover that.
- Rejected:
  - Hetzner FSN1 + HEL1 for compute: replication over 1,500 km.
  - OVH Limburg + OVH Strasbourg on OVH's private network: both Postgres
    instances at one provider.
  - Two Sites without a tie-breaker: losing the larger Site means manual
    recovery and no writes for the duration.
