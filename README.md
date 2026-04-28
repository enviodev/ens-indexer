# ENS Indexer

ENS Protocol Indexer. Built with [Envio HyperIndex](https://docs.envio.dev).

## Chains

| Network | Chain ID |
|---|---|
| Ethereum Mainnet | 1 |
| Base | 8453 |
| Linea | 59144 |
| Optimism | 10 |
| Arbitrum | 42161 |
| Scroll | 534352 |

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

## Schema entities (40)

`Domain`, `Account`, `Resolver`, `Registration`, `WrappedDomain`, `DomainTransfer`, `NewOwner`, `NewResolverEvent`, `NewTTL`, `WrappedTransfer`, `NameWrappedEvent`, `NameUnwrappedEvent`, `FusesSetEvent`, `ExpiryExtendedEvent`, `NameRegisteredEvent`, `NameRenewedEvent`, `NameTransferredEvent`, `AddrChangedEvent`, `MulticoinAddrChangedEvent`, `NameChangedEvent`, `AbiChangedEvent`, `PubkeyChangedEvent`, `TextChangedEvent`, `ContenthashChangedEvent`, `InterfaceChangedEvent`, `AuthorisationChangedEvent`, `VersionChangedEvent`, `PAResolver`, `PAResolverRecords`, `PAResolverAddressRecord`, `PAResolverTextRecord`, `DomainResolverRelation`, `ReverseNameRecord`, `MigratedNode`, `Subregistry`, `RegistrationLifecycle`, `RegistrarAction`, `RegistrarActionMetadata`, `NameToken`, `NameSale`

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
- [pnpm](https://pnpm.io/installation)
- [Docker](https://www.docker.com/products/docker-desktop/) or [Podman](https://podman.io/)

## Resources

- [Envio docs](https://docs.envio.dev)
- [HyperIndex overview](https://docs.envio.dev/docs/HyperIndex/overview)
- [Discord](https://discord.gg/envio)
