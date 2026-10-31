# cli

`oup` — the openupstream command line tool. Built on `@openupstream/sdk`.

```sh
npm i -g @openupstream/cli
oup login
oup site deploy dist --bucket my-site
```

- `oup login [--api <url>] [--no-browser]`: signs in through madAuth's
  device authorization grant (ARCHITECTURE.md, decision 87). It opens the
  approval page with the code filled in; over SSH, or with `--no-browser`,
  it prints the URL and the code to open on any device. The tokens go to
  `$XDG_CONFIG_HOME/openupstream/credentials.json` (`~/.config/…`, mode
  600); the access token is refreshed when it has less than a minute left,
  by one `oup` process at a time (a lock file next to it).
- `oup logout`: forgets them and ends the CLI's refresh tokens at madAuth.
- `oup site deploy <dir> --bucket <name> [--keep] [--force]`: makes the
  Bucket mirror the directory (decision 88): changed files only, `index.html`
  files last, then deletes what the directory no longer has, unless
  `--keep`. `--force` uploads every file, which also rewrites the headers
  of objects another S3 client uploaded. Cache
  headers come from the name: hashed assets a year and immutable,
  `index.html` `no-cache`, the rest five minutes.

In CI, set `OUP_API_KEY` to a madAuth API key instead of signing in, and
`OUP_API_URL` for another API than `https://api.openupstream.com`.

`src/oidc.ts` is the device grant and refresh, `src/session.ts` the token
for each call, `src/deploy.ts` the deploy (`planDeploy` is pure).
