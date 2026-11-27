# garage

Garage, the object storage behind Buckets (ARCHITECTURE.md, "Object
storage" and "Static sites"; decisions 81 to 84).

- `crd.yaml`: Garage's GarageNode definition (Kubernetes discovery),
  applied and established before any node starts.
- `garage.yaml`: the namespace, the rights to Garage's own GarageNode
  objects, its
  configuration and a StatefulSet with three nodes in three different
  Sites, a non-compute Site included (one per Site up to three, ADR-0007).
  Replication factor 3, `consistent` mode: every object is stored once in
  each of those Sites. Its website endpoint (port 3902) serves static sites;
  only the Routes operator's IngressRoutes reach it. Each pod has a second
  container, nginx on port 3905, between Traefik and Garage's S3 API: it
  restores the `Content-Length: 0` that Traefik leaves out of requests
  without a body, which some S3 clients sign (decision 134). Its
  configuration is the ConfigMap `garage-s3-proxy`, mounted by `subPath`:
  restart the pods after changing it.
- `s3-route.yaml`: the public S3 endpoint, `https://<bucket>.s3.<customer
  domain>` through Traefik, with one wildcard certificate. It goes to port
  3905, never to Garage's own 3900.

Both have placeholders that `infra/dev-cluster/garage.sh` fills in
(`CUSTOMER_DOMAIN`, `GARAGE_DATA_SIZE`, `GARAGE_NODES`, `CLUSTER_ISSUER`).
`GARAGE_NODES` is 3, or 1 on a single-node dev cluster: one node, one copy
of every object, nothing survives losing it (decision 112). The same script
creates the Secret `garage` (RPC secret and admin token) and assigns the
layout once. The control plane creates and deletes buckets and keys
through the admin API on port 3903, which ingress never routes.
