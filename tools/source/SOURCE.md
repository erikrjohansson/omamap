# Vendored source data

`ne_50m_admin_0_countries.geojson` is Natural Earth's 1:50m Admin 0 – Countries layer,
committed here verbatim so Omamap's map can be regenerated offline, forever, by anyone.

| | |
|---|---|
| Upstream | <https://github.com/nvkelso/natural-earth-vector> |
| File | `geojson/ne_50m_admin_0_countries.geojson` |
| Tag | `v5.1.2` |
| URL | <https://raw.githubusercontent.com/nvkelso/natural-earth-vector/v5.1.2/geojson/ne_50m_admin_0_countries.geojson> |
| Size | 3,083,490 bytes |
| SHA-256 | `3e458fc036ad0a66411f2c1e6cac49c5d7bfb81cb1123bc513b22511a2b7fdeb` |
| Retrieved | 2026-08-22 |
| Licence | Public domain (Natural Earth terms of use) |

This is Natural Earth itself, not a repackaging — no CDN and no intermediary in between.

## Verifying it

```sh
sha256sum -c SHA256SUMS
```

Or re-fetch and compare against upstream without overwriting anything:

```sh
curl -sL https://raw.githubusercontent.com/nvkelso/natural-earth-vector/v5.1.2/geojson/ne_50m_admin_0_countries.geojson | sha256sum
```

`build-data.mjs` checks this sum on every run and refuses to write on a mismatch. It also runs
semantic checks on the decoded geometry — country count, total land area, the size ordering of
the ten largest countries — so bad data fails loudly rather than quietly shipping a wrong map.

The file is only ever handed to `JSON.parse`. It is never executed.
