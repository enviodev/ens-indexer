# ENSv2

## Discovery and trust

In ENSv2 a name lives in a registry, and a registry can point any of its names at a child registry. Registries nest without limit, and anyone can deploy one.

The indexer separates seeing a contract from trusting it.

- **Seeing.** Events unique to ENSv2 are matched on any address, from the ENSv2 start block, on the chains with an ENSv2 deployment. Nothing is lost when a registry or resolver is used before anything links to it.
- **Trusting.** `v2_registry.proven` is true only for the root and `.eth` registries, and for a registry linked from a domain in a proven registry. Only proven registries get names. A contract that emits ENSv2 events without being linked keeps its rows, but they have no name and no node. If a link is removed, the names below it are cleared.

A registry may claim a parent with `ParentUpdated`. The claim decides between real links when there are several. It never creates one.

## Names

A domain's name is its label joined to its registry's name. Names are derived when a registry becomes proven, and pushed down the tree. So the order of events does not matter. A label can be written in the same block as, and before, the link that names its registry, and it still gets its name.

## Token ids

A name's `tokenId` changes when roles change (`TokenRegenerated`) and when it is registered again. The stable key is the storage id: the token id with its low 32 version bits cleared. `v2_domain` is keyed by registry and storage id.

`v2_token_resource` maps every token id to its access-control resource. In a regeneration the registry burns the old token, emits `TokenRegenerated`, and mints the new one. `v2_transfer` marks those two transfers `REGENERATION_BURN` and `REGENERATION_MINT`, so they are not read as a change of owner.

## Migration from v1

ENS premigrates `.eth` names: each v1 name is reserved on v2 (`RESERVED`, no owner), with a resolver that reads v1 records. While a name is only reserved, v1 still answers for it. When its owner migrates it, a migration controller registers it on v2. `v2_domain.isMigrated` is set, and `v2_migration` records the block and controller.

The API's `/v1/resolve` reports which protocol answers (`authority`), where records come from (`recordsFrom`), and the migration.

## Aliases

A permissioned resolver stores records by record id, and `Linked` points a name at a record. Two names linked to one record are aliases: they resolve to the same records. Older deployments used `AliasChanged` instead.

## Resolution

The API resolves a name by walking registries from the root, as the ENSv2 Universal Resolver does. At each label it reads the entry's resolver and subregistry, treats expired entries as empty, and keeps the deepest resolver it finds. When no entry exists for the full name, an ancestor's resolver answers (wildcard).
