# ADR-0009: Site names in the control plane, neutral Site ids

Date: 2026-11-28
Status: accepted

## Context

ADR-0007 put a Site's description, the text shown next to its id (e.g.
"Falkenstein (Hetzner) · hetzner-fsn1"), in the node annotation
`openupstream.io/site-description`, set by the node setup script. On the
first self-hosted cluster that went wrong in two ways:

- **It could only be changed with `kubectl`.** The "Sites & nodes" page
  (ADR-0008) showed the description but could not change it: the control
  plane only reads nodes, and an admin without a kubeconfig had no way to
  name a Site. A Site's description was also whatever its oldest node
  said, so it changed when nodes were replaced.
- **The defaults named places that weren't true.** The Incus scripts gave
  their three VMs production's Site ids, so a mini PC at home showed
  `oup-home-hetzner-fsn1` in Site `hetzner-fsn1`, described as "Incus VM
  oup-home-hetzner-fsn1". None of it said where the machines are. The
  script can't know that either: the same scripts run at home, in an
  office or in a cloud.

A Site id cannot be changed later. It is the nodes' zone label (which k3s
sets when a node first joins), the Home site stored in every Database,
Service and Job, the zone the operators prefer, and a zone in Garage's
layout. Renaming one would mean changing all four together.

## Decision

1. **A Site's description is the control plane's, not the nodes'.** The
   table `site_descriptions` (Site id, description up to 100 characters)
   in the control plane's Postgres holds what people call each Site. The
   installation's admins (madAuth's role `admin`, ADR-0008) set it on the
   "Sites & nodes" page, through `PUT /v1/admin/sites/{id}`, for any Site
   that has a node, compute or not; empty removes it, so the id is shown
   alone. `GET /v1/sites`, the dashboard's Site lists and `oup sites`
   show it. The annotation is gone, and no node setup script writes a
   description.
2. **Labels say where things run; the control plane says what they are
   called.** The node setup still writes the labels and the taint
   (ADR-0007); the control plane still only reads nodes.
3. **Site ids are permanent and claim no place.** The Incus scripts default
   to `site-1`, `site-2` (compute, `site-1` the default) and `site-3`
   (quorum-only), VMs `oup-site-1` to `oup-site-3`; a single node
   defaults to `site-1`. `SITES` and `SITE` choose others, once. The
   Hetzner dev cluster keeps production's ids: it runs at those providers.
   Like an AWS availability zone id (`use1-az1`) next to its name, the id
   stays and the name is free to change.

## Consequences

- An admin names a Site in the browser; every Site list shows the name at
  once.
- A description outlives the Site's nodes: when all its nodes are
  replaced, or a Site comes back, it keeps its name. It is backed up with
  the control plane's Database.
- Renaming a Site's id stays unsupported; the docs say to choose ids once.
- Breaking for SDK users of `SITE_DESCRIPTION_ANNOTATION` and of
  `NodeInfo.description` (SDK 0.8.0). `NodesReport` lists the Sites with
  their descriptions.
- The Incus cluster set up before keeps its names until it is reinstalled.
- Considered and turned down: the page writing the annotation (the control
  plane would need `patch` on nodes, which can also change labels, plus a
  ValidatingAdmissionPolicy to limit it to one annotation); keeping the
  annotation and only showing the `kubectl annotate` command (renaming
  would still need a cluster-admin's terminal); defaults named after the
  machine the VMs run on (wrong as soon as a Site moves, and the id cannot
  follow).
- Amends ADR-0007: its Site descriptions.
