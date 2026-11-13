# Schema

`schema.graphql` is the source. The tables fall into four groups. Every table has a `chainId` column; IDs are unique within a chain.

## ENSv1 (subgraph-shaped)

`subgraph_domain`, `subgraph_account`, `subgraph_registration`, `subgraph_wrapped_domain` and `subgraph_resolver` mirror the ENS subgraph's entities. Each event has its own table (`subgraph_transfer`, `subgraph_new_owner`, `subgraph_text_changed`, ...) with block, transaction and timestamp.

- `subgraph_domain.id` is the node (namehash).
- `subgraph_resolver.id` is `{chainId}-{resolver}-{node}`.
- `subgraph_registration.id` is the node.

## ENSv2 in the v1 tables

The v1 tables follow the ENS subgraph's rules for the ENSv2 era (ens-subgraph 16846b1, `src/legacyGovernance.ts`, `src/ensv2Domain.ts`):

- **A live ENSv2 name owns its v1 row.** For a registered v2 name on a proven path (any registry but the root registry), `subgraph_domain` holds the v2 holder as `owner` and `registrant`, the v2 expiry (plus the 28-day v2 grace period for `.eth` names), the v2 resolver, and no wrapped state. A v2 name that never existed in v1 gets a row. The `.eth` name's `subgraph_registration` follows too. v1 registry, `.eth` registrar and NameWrapper events for the name only add event rows. Unregistering the name on v2 clears the row (owner `0x0`).
- **Sinks never hold a name.** The Graveyard, the GraveyardRepairer and the migration controllers never appear as `owner`, `registrant` or wrapped owner. A `.eth` name handed to one keeps its owner. A subname handed to one is deleted (owner `0x0`).
- **Graveyard retirements are not registrations.** When the Graveyard re-registers an expired `.eth` name to itself, the name keeps its lapsed registrant and expiry. The registrar tables do not count it.
- **Expiry is clamped.** `expiryDate` in `subgraph_domain`, `subgraph_registration` and `subgraph_wrapped_domain` is at most 253402300799 (9999-12-31). Event rows and the v2 tables keep the raw value, which can be 2^64 - 1.
- **Known labels.** `eth`, `reverse` and `addr` are named. Other labels that no event carries stay encoded as `[labelhash]`; the subgraph names many of them from graph-node's label table.

## Resolver records

These hold record values, which the subgraph shape does not keep:

- `resolver_records`, `resolver_address_record` and `resolver_text_record` hold current values by resolver and node.
- `domain_resolver_relation` holds the resolver each registry assigns to each node.
- `reverse_name_record` holds primary names by address and coin type.

## Registrar activity

`registrar_action`, `registration_lifecycle`, `subregistry`, `registration_daily_stat`, `namespace_stat`, `expiry_day_stat` and `referrer_stat` hold registrations and renewals with cost and referrer, with daily and running totals. `name_token` and `name_sale` track ENS names as NFTs and their sales.

## ENSv2

| Table | Key | Holds |
|---|---|---|
| `v2_registry` | `{chainId}-{address}` | Every registry seen, whether it is proven, and its name and node |
| `v2_registry_edge` | parent domain + child registry | Links between registries; a registry can have several parents |
| `v2_domain` | `{chainId}-{registry}-{storageId}` | Each label: status, owner, expiry, resolver, subregistry, current token id and resource, premigration and migration flags |
| `v2_token_resource` | `{registry}-{tokenId}` | Token id to access-control resource |
| `v2_token_regeneration`, `v2_transfer` | event id | Token history; transfers are classified |
| `v2_permission` | contract + resource + account | Role bitmaps from `EACRolesChanged` |
| `v2_registration`, `v2_renewal` | event id | Registrar payments: `paymentToken`, `base`, `premium` (registration) or `amount` (renewal), as emitted |
| `v2_migration` | node | Names moved from v1 |
| `v2_resolver` | `{chainId}-{address}` | Resolvers seen, and whether a proven registry points at them |
| `v2_record`, `v2_record_*`, `v2_record_link` | resolver + record id | Records of permissioned resolvers, and which names link to them |
| `v2_node_*` | resolver + node | Node-keyed records of resolvers that ENSv2 registries use |
| `v2_alias` | resolver + node | Legacy aliases |

v1 and v2 meet on node: `v2_domain.node` equals `subgraph_domain.id`. The API's `ens_unified_domain` view joins them. A registered v2 name replaces its v1 row there, and a reservation does not.

## Change log

`name_event` records name-level changes that have no event table of their own: v2 registrations, reservations, expiry, resolver, subregistry and record changes, aliases, and primary names. The change stream reads it together with the event tables above.

Payment amounts are stored in the units of the token that paid. Do not add them across tokens without converting.
