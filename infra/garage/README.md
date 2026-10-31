# garage

Garage, the object storage behind Buckets (ARCHITECTURE.md, "Object
storage" and "Static sites"; decisions 81 to 84).

- `garage.yaml`: the namespace, Garage's GarageNode definition and the
  rights to its own GarageNode objects (Kubernetes discovery), its
  configuration and a StatefulSet with one node per Site, the third Site
  included. Replication factor 3, `consistent` mode: every object is stored
  once in each Site. Its website endpoint (port 3902) serves static sites;
  only the Routes operator's IngressRoutes reach it.
- `s3-route.yaml`: the public S3 endpoint, `https://<bucket>.s3.<customer
  domain>` through Traefik, with one wildcard certificate.

Both have placeholders that `infra/dev-cluster/garage.sh` fills in
(`CUSTOMER_DOMAIN`, `GARAGE_DATA_SIZE`, `CLUSTER_ISSUER`); the same script
creates the Secret `garage` (RPC secret and admin token) and assigns the
layout once. The control plane creates and deletes buckets and keys
through the admin API on port 3903, which ingress never routes.
