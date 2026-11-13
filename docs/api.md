# API

The API in `api/` reads the indexer's Postgres directly. Start it with `node api/src/server.mjs` (see [Running](running.md)). Add `?chain=<id>` to any request for a chain other than the default (`API_DEFAULT_CHAIN`, 1).

## GraphQL

`POST /subgraphs/name/ensdomains/ens` (also `/graphql`) takes the ENS subgraph's queries:

- `domains`, `domain`, `accounts`, `account`, `registrations`, `registration`, `wrappedDomains`, `wrappedDomain`, `resolvers`, `resolver`, and `_meta`;
- `where` filters with the subgraph's suffixes (`_in`, `_not`, `_gt`, `_contains`, `_starts_with_nocase` and the rest), plus `and` and `or`;
- `first` (up to 1,000), `skip` (up to 5,000), `orderBy` and `orderDirection`;
- nested relations: owner, parent, subdomains, resolver, registration, wrapped domain.

`Domain` covers v1 and v2 names (see `ens_unified_domain` in [Schema](schema.md)). It has an extra field, `protocol`. Queries at a past block (`block:` arguments) are rejected.

```graphql
{ domains(where: { name: "nick.eth" }) { id name owner { id } resolver { address texts } expiryDate } }
```

## REST

| Request | Returns |
|---|---|
| `GET /v1/resolve/{name}` | Owner, expiry, resolver, addresses, texts, contenthash; `authority` (v1 or v2), `recordsFrom` and `migration`. `?coinTypes=60,0&texts=avatar,url` narrows the records |
| `GET /v1/primary/{address}` | The primary name for the coin type (default 60 on Ethereum), and `verified`: whether the name resolves back to the address |
| `GET /v1/status` | Per chain: start, head and committed blocks, events processed, and blocks behind |
| `GET /healthz` | `{ "ok": true }` |

## Change stream

`GET /v1/stream` sends name-level changes as Server-Sent Events, in block and log order, as far as the committed head.

| Parameter | Meaning |
|---|---|
| `chain` | Chain id |
| `from` | First block to send. Without it, the stream starts at the head |
| `cursor` | Resume after this change: the `id` of the last change received. The `Last-Event-ID` header works too |
| `name` | Comma-separated names; only changes to those names |
| `address` | Comma-separated addresses; only changes involving them (owner, resolver, primary-name address) |
| `kinds` | Comma-separated kinds |

Kinds: `REGISTRATION`, `RESERVATION`, `UNREGISTRATION`, `EXPIRY`, `TRANSFER`, `RESOLVER`, `SUBREGISTRY`, `RECORD`, `ALIAS`, `MIGRATION`, `PRIMARY_NAME`, `PAYMENT`, `SUBNAME_OWNER`, `TTL`, `WRAP`, `UNWRAP`, `FUSES`.

Messages:

```
id: <cursor>
event: change
data: {"chainId":1,"block":...,"logIndex":...,"kind":"RECORD","protocol":"v1","node":"0x...","address":"0x...","transactionHash":"0x...","timestamp":"...","detail":{...}}

event: reorg
data: {"chainId":1,"fromBlock":12345}

: ping <committed block>
```

On `reorg`, drop every change you received from `fromBlock` on. The stream then resends from that block. Changes from an ENSv2 registry carry a node only once that registry is proven.

`expiry` changes are sent when an expiry is set or extended. The passing of an expiry date is not an event, so it is not sent.
