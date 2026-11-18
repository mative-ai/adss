# Deploying the simulator

The simulator is a static site: the production build of `packages/app`, with its 3D models. It needs no database and no
server-side code, and it sets no cookie. The image in this repository serves that
build with an unprivileged nginx on port 8080, and the host's reverse proxy ends TLS in front of it.

## Build and run

```sh
docker build -t mpc-simulator .
docker run -d --name mpc-simulator --restart unless-stopped \
  --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges:true \
  -p 127.0.0.1:8080:8080 mpc-simulator
```

or, with the same hardening, `docker compose up -d --build` (see [compose.yaml](../compose.yaml)). The container binds
to the loopback only: nothing reaches it except the proxy. It runs as a user without privileges, with a read-only
filesystem, and the compose file caps it at 128 MB of memory and 100 processes.

To update, build again and recreate the container. The build's files carry a hash in their names, so a browser never
keeps a stale script: only `index.html` is asked for again every time.

## The proxy in front

The proxy owns what the container does not:

- **TLS and the name.** A certificate for the host name, and the DNS record that points the name to the server. Nothing
  restricts which authority may issue it (the domain has no CAA record).
- **`Strict-Transport-Security`.** Start with `max-age=300`, raise it once the site works over HTTPS, and leave
  `includeSubDomains` and `preload` out unless the whole domain is ready for them.
- **The log.** A query string can carry something private (a link a visitor shares, say). The container's log keeps the
  path only; keep the query out of the proxy's too (the Caddy example below drops the URI and the cookie from its log,
  and was tried with a test value in the query: it did not appear).

With Caddy, for a name `<host>`:

```
<host> {
  reverse_proxy 127.0.0.1:8080
  header Strict-Transport-Security "max-age=300"
  log {
    format filter {
      wrap console
      fields {
        request>uri delete
        request>headers>Cookie delete
      }
    }
  }
}
```

With nginx, in a `server` that listens on 443 for the name (and an `access_log` whose `log_format` uses `$uri`, as
[nginx.conf](nginx.conf) does, never `$request` or `$request_uri`):

```
location / {
  proxy_pass http://127.0.0.1:8080;
  proxy_set_header Host $host;
  add_header Strict-Transport-Security "max-age=300" always;
}
```

The headers of the container pass through `proxy_pass` untouched, and only the line above is added.

## The headers

[security-headers.conf](security-headers.conf) is the single place of the response headers, and
[tools/deploy/headers.test.ts](../tools/deploy/headers.test.ts) guards it: the Content-Security-Policy allows nothing but
the page's own origin (no inline script, no `eval`, no WebAssembly compilation), the page cannot be embedded, no
referrer is sent, and `X-Robots-Tag` keeps the site out of search results. Change a header together with its test.

## After a deployment

```sh
curl -sI https://<host>/ | grep -iE 'content-security-policy|x-frame|referrer|strict-transport|cache-control'
curl -sI -H 'Accept-Encoding: gzip' https://<host>/assets/<a hashed file> | grep -iE 'content-encoding|cache-control'
curl -s https://<host>/third-party-licenses.txt | head -5
```

The page should answer with the headers above, the hashed files with `content-encoding: gzip` and
`cache-control: public, max-age=31536000, immutable`, and the two license files with `200`.
