# operators

Kubernetes reconcilers written in TypeScript. They watch the control plane's
desired state and the cluster's actual state and close the gap.

Kept deliberately thin: every behaviour that CloudNativePG, cert-manager or
Traefik already implements is configured, not reimplemented.
