# ENS HyperIndex Migration Plan

> Ponder (ENSNode) → Envio HyperIndex

**Last updated:** 2026-02-25
**Source:** `/ensnode/` (Ponder monorepo)
**Target:** `/ens-hyperindex/` (Envio HyperIndex)

---

## Table of Contents

- [Migration Overview](#migration-overview)
- [Current Status Summary](#current-status-summary)
- [Phase 1: Core Mainnet (Subgraph Plugin)](#phase-1-core-mainnet-subgraph-plugin) — DONE
- [Phase 2: Tests for Phase 1](#phase-2-tests-for-phase-1) — DONE
- [Phase 3: Multi-Chain Subgraph Extensions](#phase-3-multi-chain-subgraph-extensions)
- [Phase 4: Protocol Acceleration Plugin](#phase-4-protocol-acceleration-plugin)
- [Phase 5: Registrars Plugin](#phase-5-registrars-plugin)
- [Phase 6: TokenScope Plugin](#phase-6-tokenscope-plugin)
- [Phase 7: ENSv2 Plugin](#phase-7-ensv2-plugin)
- [Contract Reference](#contract-reference)
- [Schema Reference](#schema-reference)

---

## Migration Overview

The ENSNode Ponder indexer is a monorepo with **8 plugins** across **6 chains** indexing **~40 contracts** into **~50+ entities**. The HyperIndex migration targets feature parity.

### Progress At a Glance

| Phase | Plugin | Status | Priority |
|-------|--------|--------|----------|
| 1 | Subgraph (Mainnet core) | DONE | — |
| 2 | Tests for Phase 1 | DONE | — |
| 3a | Basenames (Base L2) | NOT STARTED | High |
| 3b | Lineanames (Linea L2) | NOT STARTED | High |
| 3c | ThreeDNS (Optimism + Base) | NOT STARTED | Medium |
| 4 | Protocol Acceleration | NOT STARTED | High |
| 5 | Registrars | NOT STARTED | Medium |
| 6 | TokenScope | NOT STARTED | Medium |
| 7 | ENSv2 | NOT STARTED | Low (future protocol) |

---

## Current Status Summary

### What's Done

The HyperIndex indexer fully covers the **Subgraph Plugin for Ethereum Mainnet** — the core ENS v1 protocol:

- **10 contracts** configured in `config.yaml` (RegistryOld, Registry, BaseRegistrar, NameWrapper, 3 Controllers, Resolver dynamic)
- **4 handler files**: `Registry.ts`, `Registrar.ts`, `NameWrapper.ts`, `Resolver.ts`
- **1 helper library**: `helpers.ts` (13 utility functions)
- **25 schema entities** (7 core + 18 event logs)
- **~26 event types** handled
- All handlers are production-quality — no TODOs, stubs, or placeholders

### What's Missing

- **5 additional chains** (Base, Linea, Optimism, Arbitrum, Scroll)
- **~30 additional contracts**
- **~25+ additional entities** (ensv2, registrars, protocol-acceleration, tokenscope schemas)
- **7 remaining plugins** worth of handler logic

---

## Phase 1: Core Mainnet (Subgraph Plugin)

**Status: DONE**

### Contracts Migrated

| Contract | Address | Start Block |
|----------|---------|-------------|
| RegistryOld | `0x314159265dd8dbb310642f98f50c066173c1259b` | 3,327,417 |
| Registry | `0x00000000000c2e074ec69a0dfb2997ba6c7d2e1e` | 9,380,380 |
| BaseRegistrar | `0x57f1887a8bf19b14fc0df6fd9b2acc9af147ea85` | 9,380,410 |
| NameWrapper | `0xd4416b13d2b3a9abae7acd5d6c2bbdbe25686401` | 16,925,608 |
| LegacyController | `0x283af0b28c62c092c9727f1ee09c02ca627eb7f5` | 9,380,471 |
| WrappedController | `0x253553366da8546fc250f225fe3d25d0c782303b` | 16,925,618 |
| UnwrappedController | `0x59e16fccd424cc24e280be16e11bcd56fb0ce547` | 22,764,821 |
| Resolver | Dynamic (via `contractRegister`) | — |

### Handlers Migrated

| File | Events | Lines |
|------|--------|-------|
| `src/handlers/Registry.ts` | NewOwner, Transfer, NewResolver, NewTTL (x2 for Old+New) | ~365 |
| `src/handlers/Registrar.ts` | BR: NameRegistered, NameRenewed, Transfer; Controllers: NameRegistered, NameRenewed (x3) | ~297 |
| `src/handlers/NameWrapper.ts` | NameWrapped, NameUnwrapped, FusesSet, ExpiryExtended, TransferSingle, TransferBatch | ~332 |
| `src/handlers/Resolver.ts` | AddrChanged, AddressChanged, NameChanged, ABIChanged, PubkeyChanged, TextChanged, ContenthashChanged, InterfaceChanged, AuthorisationChanged, VersionChanged | ~299 |
| `src/lib/helpers.ts` | Shared utilities, constants, upsert functions, GC logic | ~218 |

### Schema Entities (25 total)

**Core (7):** Domain, Account, Resolver, Registration, WrappedDomain, DomainTransfer, NewOwner

**Domain Events (7):** NewResolverEvent, NewTTL, WrappedTransfer, NameWrappedEvent, NameUnwrappedEvent, FusesSetEvent, ExpiryExtendedEvent

**Registration Events (3):** NameRegisteredEvent, NameRenewedEvent, NameTransferredEvent

**Resolver Events (8):** AddrChangedEvent, MulticoinAddrChangedEvent, NameChangedEvent, AbiChangedEvent, PubkeyChangedEvent, TextChangedEvent, ContenthashChangedEvent, InterfaceChangedEvent, AuthorisationChangedEvent, VersionChangedEvent

---

## Phase 2: Tests for Phase 1

**Status: DONE**
**Priority: —**
**Effort: Medium**

Full test suite using Vitest + Envio's `createTestIndexer()` framework with real on-chain data via HyperSync.

### Test Summary

| File | Tests | Type | Description |
|------|-------|------|-------------|
| `test/helpers.test.ts` | 36 | Unit | Pure function tests for `src/lib/helpers.ts` — constants, node computation, ID generators, encoding, sanitization |
| `test/Registry.test.ts` | 5 | Integration | RegistryOld root init, new Registry migration, Transfer, NewResolver + dynamic registration, NewTTL |
| `test/Registrar.test.ts` | 6 | Integration | BaseRegistrar NameRegistered/NameRenewed/Transfer, LegacyController + WrappedController label reveals, full registration flow |
| `test/NameWrapper.test.ts` | 7 | Integration | NameWrapped + TransferSingle, WrappedDomain creation, FusesSet, ExpiryExtended, wrappedOwner, kitchen sink block |
| `test/Resolver.test.ts` | 8 | Integration | AddrChanged, AddressChanged (multicoin), TextChanged, ContenthashChanged, VersionChanged, resolver ID format, dynamic registration, full resolver flow |
| **Total** | **62** | | |

### Key Test Blocks (real on-chain data)

| Block | Content | Used In |
|-------|---------|---------|
| 3,327,417–3,328,000 | RegistryOld deployment + first NewOwner events | Registry, Registrar, Resolver |
| 9,380,380–9,381,000 | New Registry migration (isMigrated=true) | Registry |
| 9,500,000–9,500,100 | BaseRegistrar NameRenewed events | Registrar |
| 12,010,405 | "luki.eth" registration (BaseRegistrar + LegacyController) | Registrar |
| 12,062,607 | "buytaert.eth" full registration flow | Registry, Registrar, Resolver |
| 12,100,000–12,100,100 | ContenthashChanged events | Resolver |
| 16,925,700–16,926,200 | NameWrapper FusesSet + ExpiryExtended + VersionChanged | NameWrapper, Resolver |
| 18,965,734 | "mergendise.eth" kitchen sink — NameWrapper + Controller + Registry + Resolver | NameWrapper, Registrar, Resolver |

### Completed Tasks

- [x] Unit tests for `src/lib/helpers.ts` (36 tests)
- [x] Integration tests for Registry events (5 tests)
- [x] Integration tests for Registrar events (6 tests)
- [x] Integration tests for NameWrapper events (7 tests)
- [x] Integration tests for Resolver events (8 tests)

### Notes

- Tests use Envio's `createTestIndexer()` + `indexer.process()` with real Ethereum mainnet data via HyperSync
- Requires `ENVIO_API_TOKEN` environment variable for HyperSync access
- `vitest.config.ts` sets `testTimeout: 120_000` and `hookTimeout: 60_000` for network latency
- Run with `pnpm test` or `npx vitest run`

---

## Phase 3: Multi-Chain Subgraph Extensions

### Phase 3a: Basenames (Base L2)

**Status: NOT STARTED**
**Priority: High**
**Effort: Medium**
**Source:** `ensnode/apps/ensindexer/src/plugins/subgraph/plugins/basenames/`

Basenames is the `.base.eth` subregistry on Base L2. It reuses similar patterns to the mainnet subgraph but with Base-specific contracts and controllers.

#### Contracts to Add

| Contract | Chain | Address | Start Block |
|----------|-------|---------|-------------|
| Registry | Base (8453) | `0xb94704422c2a1e396835a571837aa5ae53285a95` | 17,571,480 |
| BaseRegistrar | Base (8453) | `0x03c4738ee98ae44591e1a4a4f3cab6641d95dd9a` | 17,571,486 |
| EARegistrarController | Base (8453) | `0xd3e6775ed9b7dc12b205c8e608dc3767b9e5efda` | 17,575,699 |
| RegistrarController | Base (8453) | `0x4ccb0bb02fcaba27e82a56646e81d8c5bc4119a5` | 18,619,035 |
| UpgradeableRegistrarController | Base (8453) | `0xa7d2607c6bd39ae9521e514026cbb078405ab322` | 35,286,620 |
| L2Resolver1 | Base (8453) | `0xc6d566a56a1aff6508b41f6c90ff131615583bcd` | 17,575,714 |
| L2Resolver2 | Base (8453) | `0x426fa03fb86e510d0dd9f70335cf102a98b10875` | 35,286,620 |
| Resolver | Base (8453) | Dynamic | 17,571,480 |

#### Handler Work

- [ ] Add Base chain (8453) to `config.yaml`
- [ ] Add Basenames contract definitions and ABIs
- [ ] Migrate `basenames/Registry.ts` handlers — reuses shared registry handler patterns
- [ ] Migrate `basenames/Registrar.ts` handlers — NameRegistered, NameRegisteredWithRecord, NameRenewed, Transfer
- [ ] Note: Basenames has `NameRegisteredWithRecord` event not present in mainnet — check ABI
- [ ] Note: RegistrarController has an `endBlock` (35,936,564) — HyperIndex may need end block config
- [ ] Resolver dynamic registration for Base resolvers
- [ ] Verify schema entities work cross-chain (Domain IDs may need chain scoping)

#### Key Differences from Mainnet

- No NameWrapper on Base
- Different controller contract set (EA, Regular, Upgradeable)
- `NameRegisteredWithRecord` event (registers + sets resolver records in one tx)
- L1Resolver on mainnet (`0xde9049636f4a1dfe0a64d1bfe3155c0a14c54f31`, block 20,420,641) bridges Base names to L1

---

### Phase 3b: Lineanames (Linea L2)

**Status: NOT STARTED**
**Priority: High**
**Effort: Medium**
**Source:** `ensnode/apps/ensindexer/src/plugins/subgraph/plugins/lineanames/`

Lineanames is the `.linea.eth` subregistry on Linea L2. Closer to mainnet in structure (has NameWrapper).

#### Contracts to Add

| Contract | Chain | Address | Start Block |
|----------|-------|---------|-------------|
| Registry | Linea (59144) | `0x50130b669b28c339991d8676fa73cf122a121267` | 6,682,888 |
| BaseRegistrar | Linea (59144) | `0x6e84390dcc5195414ec91a8c56a5c91021b95704` | 6,682,892 |
| EthRegistrarController | Linea (59144) | `0xdb75db974b1f2bd3b5916d503036208064d18295` | 6,682,978 |
| NameWrapper | Linea (59144) | `0xa53cca02f98d590819141aa85c891e2af713c223` | 6,682,956 |
| DefaultPublicResolver | Linea (59144) | `0x86c5aed9f27837074612288610fb98ccc1733126` | 6,682,994 |
| Resolver | Linea (59144) | Dynamic | 6,682,888 |

#### Handler Work

- [ ] Add Linea chain (59144) to `config.yaml`
- [ ] Add Lineanames contract definitions and ABIs
- [ ] Migrate `lineanames/Registry.ts` handlers
- [ ] Migrate `lineanames/Registrar.ts` handlers
- [ ] Migrate `lineanames/NameWrapper.ts` handlers — Linea has NameWrapper unlike Base
- [ ] Resolver dynamic registration for Linea resolvers
- [ ] L1Resolver on mainnet (`0xde16ee87b0c019499cebdde29c9f7686560f679a`, block 20,410,692) bridges Linea names to L1

#### Key Differences from Mainnet

- Has NameWrapper (similar to mainnet)
- Single controller (EthRegistrarController)
- Different registry/registrar contract addresses

---

### Phase 3c: ThreeDNS (Optimism + Base)

**Status: NOT STARTED**
**Priority: Medium**
**Effort: Medium**
**Source:** `ensnode/apps/ensindexer/src/plugins/subgraph/plugins/threedns/`

ThreeDNS is a third-party DNS integration for ENS, deployed on Optimism and Base.

#### Contracts to Add

| Contract | Chain | Address | Start Block |
|----------|-------|---------|-------------|
| ThreeDNSToken | Optimism (10) | `0xbb7b805b257d7c76ca9435b3ffe780355e4c4b17` | 110,393,959 |
| ThreeDNSResolver | Optimism (10) | `0xf97aac6c8dbaebcb54ff166d79706e3af7a813c8` | 110,393,959 |
| ThreeDNSToken | Base (8453) | `0xbb7b805b257d7c76ca9435b3ffe780355e4c4b17` | 17,522,624 |
| ThreeDNSResolver | Base (8453) | `0xf97aac6c8dbaebcb54ff166d79706e3af7a813c8` | 17,522,624 |

#### Handler Work

- [ ] Add Optimism chain (10) to `config.yaml`
- [ ] Add ThreeDNS contract definitions and ABIs
- [ ] Migrate `ThreeDNSToken.ts` handlers — Transfer, Approval, URI events
- [ ] Migrate `ThreeDNSResolver.ts` handlers — resolver record events
- [ ] ThreeDNS uses ERC721 token model — tokenId represents DNS domain
- [ ] Handle domain creation from token mint events

#### Key Differences

- ERC721-based (not ENS Registry model)
- Token Transfer creates/updates domain ownership
- Custom resolver model for DNS records
- Same contract addresses on both Optimism and Base

---

## Phase 4: Protocol Acceleration Plugin

**Status: NOT STARTED**
**Priority: High**
**Effort: Large**
**Source:** `ensnode/apps/ensindexer/src/plugins/protocol-acceleration/`

This plugin provides fast domain resolution by caching resolver records and domain-resolver relationships. Critical for production ENS resolution performance.

### New Schema Entities

| Entity | Purpose |
|--------|---------|
| `reverseNameRecord` | ENSIP-19 reverse records (address → name by coinType) |
| `domainResolverRelation` | Domain-to-resolver mapping cache |
| `resolver` | Resolver contract references (chainId, address) |
| `resolverRecords` | Resolver records per (chainId, address, node) |
| `resolverAddressRecord` | Address records indexed by coinType |
| `resolverTextRecord` | Text records indexed by key |
| `migratedNode` | RegistryOld → Registry migration tracking |

### Contracts Involved (across 6 chains)

**Registry events** (domain-resolver relationship):
- ENSv1Registry on Mainnet
- Registries on Base, Linea (from Phase 3)

**Resolver events** (record caching):
- All Resolver contracts from all chains (Mainnet, Base, Linea, Optimism, Arbitrum, Scroll)
- Tracks: AddrChanged, MulticoinAddrChanged, TextChanged, NameChanged

**StandaloneReverseRegistrar** (ENSIP-19 reverse resolution):

| Chain | Address | Start Block |
|-------|---------|-------------|
| Mainnet (1) | `0x283f227c4bd38ece252c4ae7ece650b0e913f1f9` | 22,764,819 |
| Base (8453) | `0x0000000000d8e504002cc26e3ec46d81971c1664` | 31,808,582 |
| Linea (59144) | `0x0000000000d8e504002cc26e3ec46d81971c1664` | 20,173,340 |
| Optimism (10) | `0x0000000000d8e504002cc26e3ec46d81971c1664` | 137,403,854 |
| Arbitrum (42161) | `0x0000000000d8e504002cc26e3ec46d81971c1664` | 349,263,357 |
| Scroll (534352) | `0x0000000000d8e504002cc26e3ec46d81971c1664` | 16,604,272 |

**Additional Mainnet reverse resolvers:**
- DefaultReverseResolver2: `0x231b0ee14048e9dccd1d247744d114a4eb5e8e63` (block 16,925,619)
- DefaultReverseResolver3: `0xa7d635c8de9a58a228aa69353a1699c7cc240dcf` (block 22,764,871)
- Multiple DefaultPublicResolver versions (0-5)
- BaseReverseResolver: `0xc800dbc8ff9796e58efba2d7b35028ddd1997e5e` (block 22,764,838)
- LineaReverseResolver: `0x0ce08a41bdb10420fb5cac7da8ca508ea313aef8` (block 22,764,840)
- OptimismReverseResolver: `0xf9edb1a21867ac11b023ce34abad916d29abf107` (block 22,764,854)
- ArbitrumReverseResolver: `0x4b9572c03aaa8b0efa4b4b0f0cc0f0992bedb898` (block 22,764,837)
- ScrollReverseResolver: `0xc4842814ca523e481ca5aa85f719fed1e9cac614` (block 22,921,284)

### Handler Work

- [ ] Add `resolverRecords`, `resolverAddressRecord`, `resolverTextRecord` entities to schema
- [ ] Add `domainResolverRelation` entity to schema
- [ ] Add `reverseNameRecord` entity to schema
- [ ] Add `migratedNode` entity to schema
- [ ] Migrate `ENSv1Registry.ts` handler — tracks domain-resolver relationships
- [ ] Migrate `Resolver.ts` handler — caches individual resolver records (addr, text, name)
- [ ] Migrate `StandaloneReverseRegistrar.ts` handler — ReverseNameUpdated events across 6 chains
- [ ] Add StandaloneReverseRegistrar ABIs and contract config for all 6 chains
- [ ] Add all reverse resolver contracts to config
- [ ] Migrate `ThreeDNSToken.ts` handler — 3DNS reverse record tracking

### Architecture Decision

> The Ponder version uses separate handler registrations per-plugin, so the same contract events (e.g., Registry.NewResolver) fire handlers in BOTH the subgraph plugin AND protocol-acceleration plugin. In HyperIndex, a single handler per event must incorporate both codepaths. Plan how to merge or compose these.

---

## Phase 5: Registrars Plugin

**Status: NOT STARTED**
**Priority: Medium**
**Effort: Medium**
**Source:** `ensnode/apps/ensindexer/src/plugins/registrars/`

Unified registration lifecycle tracking across all subregistries (Ethnames, Basenames, Lineanames).

### New Schema Entities

| Entity | Purpose |
|--------|---------|
| `subregistries` | Subregistry metadata (CAIP-10 ID, namehash) |
| `registrationLifecycles` | Current registration state per managed name |
| `registrarActions` | Logical registration/renewal actions with cost breakdown |

### Handler Work

- [ ] Add `subregistries`, `registrationLifecycles`, `registrarActions` entities to schema
- [ ] Migrate `Ethnames_Registrar.ts` — BaseRegistrar events for .eth
- [ ] Migrate `Ethnames_RegistrarController.ts` — controller events with cost/referrer parsing
- [ ] Migrate `Ethnames_UniversalRegistrarRenewalWithReferrer.ts` — universal renewal handler
- [ ] Migrate `Basenames_Registrar.ts` — BaseRegistrar events for .base.eth
- [ ] Migrate `Basenames_RegistrarController.ts` — Base controller events
- [ ] Migrate `Lineanames_Registrar.ts` — BaseRegistrar events for .linea.eth
- [ ] Migrate `Lineanames_RegistrarController.ts` — Linea controller events
- [ ] Port shared library logic:
  - `registrar-action.ts` — logical action aggregation
  - `registrar-events.ts` — event normalization
  - `registration-lifecycle.ts` — lifecycle state machine
  - `subregistry.ts` — subregistry tracking

### Additional Mainnet Contract

| Contract | Address | Start Block |
|----------|---------|-------------|
| UniversalRegistrarRenewalWithReferrer | `0xf55575bde5953ee4272d5ce7cdd924c74d8fa81a` | 23,784,217 |

### Architecture Note

> The registrars plugin tracks the same BaseRegistrar/Controller events as the subgraph plugin but writes to different entities. Same merge/compose consideration as Phase 4.

---

## Phase 6: TokenScope Plugin

**Status: NOT STARTED**
**Priority: Medium**
**Effort: Small-Medium**
**Source:** `ensnode/apps/ensindexer/src/plugins/tokenscope/`

Tracks ENS NFT transfers and secondary market sales via Seaport.

### New Schema Entities

| Entity | Purpose |
|--------|---------|
| `nameSales` | Secondary market sales (buyer, seller, price, currency, Seaport order) |
| `nameTokens` | NFT token state (CAIP-19 asset ID, owner, mint/burn status) |

### Contracts to Add

| Contract | Chain | Address | Start Block |
|----------|-------|---------|-------------|
| Seaport 1.5 | Mainnet (1) | `0x00000000000000adc04c56bf30ac9d3c0aaf14dc` | 17,129,405 |

### Handler Work

- [ ] Add `nameSales` and `nameTokens` entities to schema
- [ ] Add Seaport 1.5 ABI and contract config
- [ ] Migrate `BaseRegistrars.ts` handler — ERC721 Transfer tracking for Eth + Base BaseRegistrars
- [ ] Migrate `NameWrapper.ts` handler — ERC1155 Transfer tracking
- [ ] Migrate `ThreeDNSToken.ts` handler — Transfer and Approval events
- [ ] Migrate `Seaport.ts` handler — OrderFulfilled events for secondary market
- [ ] Port `handle-nft-transfer.ts` library — mint/burn detection, CAIP-19 asset ID generation

### Notes

- Seaport handler parses complex order structures to extract ENS domain sales
- CAIP-19 asset IDs follow `eip155:{chainId}/{namespace}:{contract}/{tokenId}` format
- TokenScope reuses Transfer events from BaseRegistrar and NameWrapper (same merge concern)

---

## Phase 7: ENSv2 Plugin

**Status: NOT STARTED**
**Priority: Low (protocol still in development)**
**Effort: Large**
**Source:** `ensnode/apps/ensindexer/src/plugins/ensv2/`

Next-generation ENS protocol with new registry and registrar contracts.

### New Schema Entities

| Entity | Purpose |
|--------|---------|
| `event` | On-chain event metadata |
| `registry` | Registry contract instances |
| `v1Domain` | ENSv1 domain state (bridged) |
| `v2Domain` | ENSv2 domain state |
| `registration` | Polymorphic registration (NameWrapper, BaseRegistrar, ThreeDNS, ENSv2Registry) |
| `renewal` | Renewal events |
| `label` | Label rainbow table (labelHash → interpreted label) |
| `permissions` | ENSv2 access control permissions |
| `permissionsResource` | Resource-level permissions |
| `permissionsUser` | User-level permissions |
| `registryCanonicalDomain` | Canonical domain tracker per registry |

### Contracts to Add

| Contract | Chain | Address | Notes |
|----------|-------|---------|-------|
| ENSv2 Registry | Mainnet (1) | TBD | New v2 registry |
| ENSv2 ETHRegistrar | Mainnet (1) | TBD | New v2 registrar |
| EnhancedAccessControl | Mainnet (1) | TBD | Permissions contract |

### Handler Work

- [ ] Add all ENSv2 schema entities
- [ ] Add ENSv2 contract ABIs (Registry, ETHRegistrar, EnhancedAccessControl)
- [ ] Migrate `ensv1/BaseRegistrar.ts` — v1 BaseRegistrar events in v2 context
- [ ] Migrate `ensv1/ENSv1Registry.ts` — v1 Registry events in v2 context
- [ ] Migrate `ensv1/NameWrapper.ts` — v1 NameWrapper events in v2 context
- [ ] Migrate `ensv1/RegistrarController.ts` — v1 controller events in v2 context
- [ ] Migrate `ensv2/ENSv2Registry.ts` — new v2 Registry events
- [ ] Migrate `ensv2/ETHRegistrar.ts` — new v2 ETHRegistrar events
- [ ] Migrate `ensv2/EnhancedAccessControl.ts` — permissions/access control events
- [ ] Label rainbow table population

### Notes

- ENSv2 contracts may not be deployed yet — monitor ENS team announcements
- This plugin tracks BOTH v1 and v2 domains simultaneously for migration period
- Polymorphic registrations support 4 types with type-specific fields

---

## Contract Reference

### All Chains Summary

| Chain | ID | Contracts | Plugins Using |
|-------|----|-----------|---------------|
| Ethereum Mainnet | 1 | ~15 | All plugins |
| Base | 8453 | ~8 | Subgraph, ProtocolAccel, Registrars, TokenScope |
| Linea | 59144 | ~6 | Subgraph, ProtocolAccel, Registrars |
| Optimism | 10 | ~3 | Subgraph (3DNS), ProtocolAccel |
| Arbitrum | 42161 | ~1 | ProtocolAccel (reverse resolver only) |
| Scroll | 534352 | ~1 | ProtocolAccel (reverse resolver only) |

### ABI Files Needed (from `ensnode/packages/datasources/src/abis/`)

**Already have (mainnet core):**
- `Registry.ts`, `BaseRegistrar.ts`, `NameWrapper.ts`
- `LegacyEthRegistrarController.ts`, `WrappedEthRegistrarController.ts`, `UnwrappedEthRegistrarController.ts`
- `Resolver.ts`

**Need to add:**
- **Basenames:** `basenames/BaseRegistrar.ts`, `basenames/EARegistrarController.ts`, `basenames/RegistrarController.ts`, `basenames/UpgradeableRegistrarController.ts`, `basenames/L1Resolver.ts`, `basenames/Registry.ts`, `basenames/ReverseRegistrar.ts`
- **Lineanames:** `lineanames/BaseRegistrar.ts`, `lineanames/EthRegistrarController.ts`, `lineanames/NameWrapper.ts`, `lineanames/Registry.ts`
- **ThreeDNS:** `threedns/ThreeDNSToken.ts`
- **Shared:** `StandaloneReverseRegistrar.ts`, `AbstractReverseResolver.ts`, `LegacyPublicResolver.ts`
- **Seaport:** `Seaport1.5.ts`
- **ENSv2:** `ensv2/Registry.ts`, `ensv2/ETHRegistrar.ts`, `ensv2/EnhancedAccessControl.ts`
- **Other Mainnet:** `UniversalRegistrarRenewalWithReferrer.ts`, `UniversalResolver.ts`

---

## Schema Reference

### Entity Count by Plugin

| Plugin | Core Entities | Event Entities | Total |
|--------|--------------|----------------|-------|
| Subgraph (Phase 1) | 5 | 20 | 25 |
| Protocol Acceleration (Phase 4) | 7 | 0 | 7 |
| Registrars (Phase 5) | 3 | 0 | 3 |
| TokenScope (Phase 6) | 2 | 0 | 2 |
| ENSv2 (Phase 7) | 11 | 0 | 11 |
| **Total** | **28** | **20** | **~48** |

---

## Architectural Considerations

### 1. Multi-Plugin Event Handling

In Ponder, the same contract event can trigger handlers in multiple plugins (e.g., Registry.NewResolver fires in both Subgraph and Protocol Acceleration). In HyperIndex, each event has a single handler. Options:

- **Option A:** Merge logic from multiple plugins into a single handler per event
- **Option B:** Use a dispatcher pattern that calls into plugin-specific functions
- **Option C:** Run separate HyperIndex instances per plugin (independent databases)

### 2. Cross-Chain Entity IDs

Entities like Domain, Registration etc. currently use mainnet-only IDs (namehash). When adding L2 chains, need to decide:

- Prefix IDs with chainId to avoid collisions?
- Or keep separate entity namespaces per chain (like Ponder's `subgraph_` prefix)?

### 3. Shared Handler Patterns

The Ponder codebase uses shared handlers (e.g., `shared-handlers/Registry.ts`) that are parameterized per chain. Consider creating a similar pattern in HyperIndex to avoid duplicating handler logic for Basenames/Lineanames.

### 4. End Block Support

Basenames `RegistrarController` has an `endBlock` (35,936,564) — verify if HyperIndex config supports `end_block` for contracts that are superseded.
