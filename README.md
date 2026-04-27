# ENS Indexer

A multichain ENS Protocol indexer built with [Envio HyperIndex](https://docs.envio.dev). Indexes registrations, renewals, name wrapping, resolver records, and domain transfers across the ENS deployments on Ethereum, Optimism, Base, Arbitrum, Linea, and Scroll.

## Chains

| Chain | ID |
|---|---|
| Ethereum Mainnet | 1 |
| Optimism | 10 |
| Base | 8453 |
| Arbitrum | 42161 |
| Linea | 59144 |
| Scroll | 534352 |

## What it indexes

- **Registry contracts** (`Registry`, `RegistryOld`): owner, resolver, and TTL changes for every node
- **BaseRegistrar** and per-chain BaseRegistrar deployments: `.eth` name registrations, renewals, and transfers
- **NameWrapper**: wrapped names, fuses, expiry extensions, ERC-1155 transfers
- **Registrar Controllers** (`LegacyController`, `EthController_Linea`, `EAController_Base`, `RegController_Base`, `UnwrappedController`, `UpgController_Base`, `UniversalRenewal`): name registrations and renewals via the various controller versions
- **Resolver**: address records, multicoin addresses, name changes, content hash, text records
- **StandaloneReverseRegistrar**: reverse name resolution
- **ThreeDNSToken** and **Seaport**: third-party integrations relevant to ENS

## Schema

40 GraphQL entities including `Domain`, `Account`, `Resolver`, `Registration`, `WrappedDomain`, plus event-level entities (`NameRegisteredEvent`, `NameWrappedEvent`, `AddrChangedEvent`, etc.).

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
