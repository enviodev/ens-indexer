# ENS Indexer

ENS Protocol Indexer. Built with [Envio HyperIndex](https://docs.envio.dev).

## Documentation

See [docs/](docs/README.md): coverage, ENSv2 design, schema, API (GraphQL, REST, change stream), running locally, and the archive export.

## Chains

| Network | Chain ID |
|---|---|
| Ethereum Mainnet | 1 |
| Base | 8453 |
| Linea | 59144 |
| Optimism | 10 |
| Arbitrum | 42161 |
| Scroll | 534352 |
| Sepolia (ENSv2 only) | 11155111 |

## Contracts

- **`RegistryOld`**: `NewOwner`, `Transfer`, `NewResolver`, `NewTTL`
- **`Registry`**: `NewOwner`, `Transfer`, `NewResolver`, `NewTTL`
- **`BaseRegistrar`**: `NameRegistered`, `NameRenewed`, `Transfer`
- **`NameWrapper`**: `NameWrapped`, `NameUnwrapped`, `FusesSet`, `ExpiryExtended`, `TransferSingle`, `TransferBatch`
- **`LegacyController`**: `NameRegistered`, `NameRenewed`
- **`WrappedController`**: `NameRegistered`, `NameRenewed`
- **`UnwrappedController`**: `NameRegistered`, `NameRenewed`
- **`BaseRegistrar_Base`**: `NameRegistered`, `NameRegisteredWithRecord`, `NameRenewed`, `Transfer`
- **`EAController_Base`**: `NameRegistered`
- **`RegController_Base`**: `NameRegistered`, `NameRenewed`
- **`UpgController_Base`**: `NameRegistered`, `NameRenewed`
- **`BaseRegistrar_Linea`**: `NameRegistered`, `NameRenewed`, `Transfer`
- **`EthController_Linea`**: `NameRegistered`, `NameRenewed`, `OwnerNameRegistered`, `PohNameRegistered`
- **`ThreeDNSToken`**: `NewOwner`, `Transfer`, `RegistrationCreated`, `RegistrationExtended`, `TransferSingle`, `TransferBatch`
- **`Resolver`**: `AddrChanged`, `AddressChanged`, `NameChanged`, `ABIChanged`, `PubkeyChanged`, `TextChanged`, `ContenthashChanged`, `InterfaceChanged`, `AuthorisationChanged`, `VersionChanged`, `DNSRecordChanged4`, `DNSRecordChanged5`, `DNSRecordDeleted`
- **`UniversalRenewal`**: `RenewalReferred`
- **`Seaport`**: `OrderFulfilled`
- **`StandaloneReverseRegistrar`**: `NameForAddrChanged`
- **`V2RegistryDiscovery`** / **`V2ResolverDiscovery`** (wildcard): `RegistryCreated`, `ResolverCreated`
- **`V2Registry`**: `LabelRegistered`, `LabelReserved`, `LabelUnregistered`, `ExpiryUpdated`, `SubregistryUpdated`, `ResolverUpdated`, `ParentUpdated`, `TokenRegenerated`, `TokenResource`, `EACRolesChanged`, `TransferSingle`, `TransferBatch`
- **`V2Registrar`**: `NameRegistered`, `NameRenewed`
- **`V2Resolver`**: `Linked`, `Cleared`, `AddressUpdated`, `TextUpdated`, `ContenthashUpdated`, `NameUpdated`, `EACRolesChanged`, `AliasChanged`

## Schema entities (42)

`Domain`, `Account`, `Resolver`, `Registration`, `WrappedDomain`, `DomainTransfer`, `NewOwner`, `NewResolverEvent`, `NewTTL`, `WrappedTransfer`, `NameWrappedEvent`, `NameUnwrappedEvent`, `FusesSetEvent`, `ExpiryExtendedEvent`, `NameRegisteredEvent`, `NameRenewedEvent`, `NameTransferredEvent`, `AddrChangedEvent`, `MulticoinAddrChangedEvent`, `NameChangedEvent`, `AbiChangedEvent`, `PubkeyChangedEvent`, `TextChangedEvent`, `ContenthashChangedEvent`, `InterfaceChangedEvent`, `AuthorisationChangedEvent`, `VersionChangedEvent`, `PAResolver`, `PAResolverRecords`, `PAResolverAddressRecord`, `PAResolverTextRecord`, `DomainResolverRelation`, `ReverseNameRecord`, `MigratedNode`, `Subregistry`, `RegistrationLifecycle`, `RegistrarAction`, `RegistrarActionMetadata`, `NameToken`, `NameSale`, `RegistrationDailyStat`, `NamespaceStat`

## Indexes and aggregates

The schema is indexed for the queries an API needs: exact and prefix label search (`name`, `labelName`), names by owner, registrant or wrapped owner sorted by expiry, subdomains sorted by creation time, event history per domain / resolver / registration ordered by block, registrar actions by name, registrant and referrer over time, resolver records by node, and NFT sales by name, buyer, seller and currency.

Two aggregate entities are maintained by the registrar handlers: `registration_daily_stat` (registrations, renewals and known cost per namespace per UTC day) and `namespace_stat` (running totals per namespace). A namespace is a subregistry, identified `eip155:{chainId}:{contract}`.

## ENSv2

ENSv2 lives on Ethereum (and Sepolia). The other chains here have v1-era contracts only.

- **Discovery.** Every `PermissionedRegistry` and `PermissionedResolver` is watched from the block it is created, through wildcard listeners on `RegistryCreated` and `ResolverCreated`. A `SubregistryUpdated` or `ResolverUpdated` from a watched registry also adds its target, so registries and custom resolvers that emit no creation event are still covered.
- **Provenance.** Being watched is not being trusted. `v2_registry.proven` is true only for the configured root and `.eth` registries, and for a registry linked from a domain in a proven registry. Names are written only for proven registries, so an arbitrary contract that emits the right events gets no name. Unlinking a registry clears the names below it.
- **Order independence.** A label can be stored before its registry is linked. The name is derived when the link arrives, and pushed down the tree.
- **Stable identity.** `tokenId` changes on regeneration. `v2_domain` is keyed by storage id (`tokenId` with its version bits cleared), and `v2_token_resource` maps each `tokenId` to its EAC resource. The burn and mint inside a regeneration are classified in `v2_transfer`, so they are not mistaken for a change of owner.
- **Migration.** Premigrated reservations are `RESERVED` with `isPremigrated`. A `LabelRegistered` sent by a migration controller sets `isMigrated` and writes `v2_migration`.
- **Aliases.** Current resolvers link several nodes to one record (`Linked`, `v2_record_link`). Older deployments used `AliasChanged` (`v2_alias`).
- **Unified view.** v1 and v2 join on node (`v2_domain.node = subgraph_domain.id`). The API exposes that join as one `Domain`: a registered v2 name replaces its v1 row, while a reservation does not.

## API

`api/` serves the indexed data. It reads the indexer's Postgres directly.

| Path | Purpose |
|---|---|
| `POST /subgraphs/name/ensdomains/ens` | GraphQL with the ENS subgraph's query shape: `domains`, `accounts`, `registrations`, `wrappedDomains`, `resolvers`, `_meta` |
| `GET /v1/resolve/:name` | Owner, resolver, addresses, texts and contenthash. `?coinTypes=60&texts=avatar` narrows the records |
| `GET /v1/primary/:address` | Primary name, with a forward-resolution check |
| `GET /v1/status` | Sync progress per chain |
| `GET /v1/stream` | Name-level changes as Server-Sent Events, resumable by cursor, filtered by name, address and kind |

Add `?chain=<id>` to query a chain other than the default. GraphQL `block` arguments are rejected: past-block queries are not implemented.

`api/parity/replay.mjs` (ENSv2) and `api/parity/replay-v1.mjs` (v1 owner, resolver, expiry, ETH address and reverse names) check indexed state against raw HyperSync event data. `api/parity/latency.mjs` measures API latency against a synced database.

`api/export/export.mjs` writes tables to Parquet by chain and block range, to a directory or S3-compatible storage (R2, MinIO). See [docs/export.md](docs/export.md).

## Run locally

```bash
pnpm install
pnpm dev
```

GraphQL playground at [http://localhost:8080](http://localhost:8080) (local password: `testing`).

## Generate from `config.yaml` or `schema.graphql`

```bash
pnpm codegen
```

## Pre-requisites

- [Node.js v22+ (v24 recommended)](https://nodejs.org/en/download/current)
- `ENVIO_API_TOKEN` (HyperSync) for `pnpm dev` and `pnpm test`; the tests index real blocks
- [pnpm](https://pnpm.io/installation)
- [Docker](https://www.docker.com/products/docker-desktop/) or [Podman](https://podman.io/)

## Resources

- [Envio docs](https://docs.envio.dev)
- [HyperIndex overview](https://docs.envio.dev/docs/HyperIndex/overview)
- [Discord](https://discord.gg/envio)

## License

[MIT](LICENSE). Portions are derived from [ENSNode](https://github.com/namehash/ensnode) (MIT, Copyright (c) 2026 NameHash Inc.), and that notice is kept in the license file.
