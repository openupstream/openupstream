#!/usr/bin/env bash
# Registers `oup` in madAuth as a public OpenID Connect client that may use
# the device authorization grant (ARCHITECTURE.md, decision 87), and prints
# its client ID for the control plane's CLI_CLIENT_ID. Once per madAuth.
#
#   ./register-cli.sh https://openupstream.com
#
# Signs in as an admin with e-mail and password (asked here, never on the
# command line): madAuth lets only an admin who signed in within the last
# two minutes add clients, not an API key or the setup token. An admin with
# a second factor registers the client from madAuth's admin API in the
# browser instead: Madauth.admin.addClient({ name: 'oup CLI', public: true,
# deviceFlow: true, redirectUris: ['http://127.0.0.1/callback'] }).
#
# Needs: curl, jq. CURL_OPTIONS, e.g. -k for a dev cluster's staging
# certificate.
set -euo pipefail

ISSUER=${1:?usage: register-cli.sh <madAuth issuer, e.g. https://openupstream.com>}
read -r -p 'admin e-mail: ' EMAIL
read -r -s -p 'password: ' PASSWORD
echo
JAR=$(mktemp)
trap 'rm -f "$JAR"' EXIT
call() { # path, JSON body
  curl -fsS ${CURL_OPTIONS:-} -b "$JAR" -c "$JAR" -X POST -H "Origin: $ISSUER" -H 'content-type: application/json' "$ISSUER$1" --data @- <<<"$2"
}

signed_in=$(call /auth/password/signin "$(jq -n --arg e "$EMAIL" --arg p "$PASSWORD" '{email: $e, password: $p}')")
unset PASSWORD
jq -e '.user' <<<"$signed_in" >/dev/null || { echo 'the sign-in needs a second step; register the client in the browser (see above)' >&2; exit 1; }

# The loopback redirect URI (any port) leaves room for a browser sign-in later; the device grant needs none.
call /auth/admin/clients/add '{"name": "oup CLI", "public": true, "deviceFlow": true, "redirectUris": ["http://127.0.0.1/callback"]}' |
  jq -r '"CLI_CLIENT_ID=\(.client.id)"'
