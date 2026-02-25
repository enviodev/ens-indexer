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
- [Phase 4: Protocol Acceleration Plugin](#phase-4-protocol-acceleration-plugin) — DONE
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
| 3a | Basenames (Base L2) | DONE | — |
| 3b | Lineanames (Linea L2) | DONE | — |
| 3c | ThreeDNS (Optimism + Base) | DONE | — |
| 4 | Protocol Acceleration | DONE | — |
| 5 | Registrars | NOT STARTED | Medium |
| 6 | TokenScope | NOT STARTED | Medium |
| 7 | ENSv2 | NOT STARTED | Low (future protocol) |

---

## Current Status Summary

### What's Done

The HyperIndex indexer covers the **Subgraph Plugin for Ethereum Mainnet** (Phase 1), **Basenames on Base L2** (Phase 3a), **Lineanames on Linea L2** (Phase 3b), **ThreeDNS on Optimism + Base** (Phase 3c), and the **Protocol Acceleration Plugin** (Phase 4):

- **6 chains**: Ethereum Mainnet (1), Base (8453), Linea (59144), Optimism (10), Arbitrum (42161), Scroll (534352)
- **20 contracts** configured in `config.yaml` (10 mainnet + 6 Base + 2 Linea + ThreeDNSToken shared + StandaloneReverseRegistrar across 5 chains, with Registry, Resolver, and NameWrapper reused cross-chain)
- **8 handler files**: `Registry.ts`, `Registrar.ts`, `NameWrapper.ts`, `Resolver.ts`, `BaseRegistrar.ts`, `LineaRegistrar.ts`, `ThreeDNS.ts`, `ReverseRegistrar.ts`
- **2 helper libraries**: `helpers.ts` (20 utility functions), `protocol-acceleration.ts` (PA helper module with ID generators, coin type utilities, interpretation functions, DB helpers)
- **32 schema entities** (7 core + 18 event logs + 7 PA entities)
- **~52 event types** handled (26 mainnet + 9 Base + 7 Linea + 4 ThreeDNS + 3 DNS record + 1 StandaloneReverseRegistrar + PA logic merged into existing handlers)
- All handlers are production-quality — no TODOs, stubs, or placeholders

### What's Missing

- **~15 additional contracts** (registrars, tokenscope, ensv2)
- **~17+ additional entities** (ensv2, registrars, tokenscope schemas)
- **3 remaining plugins** worth of handler logic

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
| `src/handlers/Registrar.ts` | BR: NameRegistered, NameRenewed, Transfer; Controllers: NameRegistered, NameRenewed (x3) | ~243 |
| `src/handlers/NameWrapper.ts` | NameWrapped, NameUnwrapped, FusesSet, ExpiryExtended, TransferSingle, TransferBatch | ~332 |
| `src/handlers/Resolver.ts` | AddrChanged, AddressChanged, NameChanged, ABIChanged, PubkeyChanged, TextChanged, ContenthashChanged, InterfaceChanged, AuthorisationChanged, VersionChanged | ~299 |
| `src/lib/helpers.ts` | Shared utilities, constants, upsert functions, GC logic, setNamePreimage, tokenIdToLabelHash | ~280 |

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
| `test/helpers.test.ts` | 49 | Unit | Pure function tests for `src/lib/helpers.ts` — constants (incl. BASE_ETH_NODE, LINEA_ETH_NODE, THREEDNS_RESOLVER), node computation, ID generators, encoding, tokenIdToLabelHash, decodeDnsEncodedName, sanitization |
| `test/Registry.test.ts` | 5 | Integration | RegistryOld root init, new Registry migration, Transfer, NewResolver + dynamic registration, NewTTL |
| `test/Registrar.test.ts` | 6 | Integration | BaseRegistrar NameRegistered/NameRenewed/Transfer, LegacyController + WrappedController label reveals, full registration flow |
| `test/NameWrapper.test.ts` | 7 | Integration | NameWrapped + TransferSingle, WrappedDomain creation, FusesSet, ExpiryExtended, wrappedOwner, kitchen sink block |
| `test/Resolver.test.ts` | 8 | Integration | AddrChanged, AddressChanged (multicoin), TextChanged, ContenthashChanged, VersionChanged, resolver ID format, dynamic registration, full resolver flow |
| `test/BaseRegistrar.test.ts` | 2 | Integration | Base L2 BaseRegistrar_Base NameRegistered + EAController_Base label preimage with cost=0 |
| `test/LineaRegistrar.test.ts` | 2 | Integration | Linea L2 BaseRegistrar_Linea NameRegistered + EthController_Linea label preimage |
| `test/ThreeDNS.test.ts` | 2 | Integration | ThreeDNS NewOwner + RegistrationCreated on Optimism and Base |
| **Total** | **79** | | |

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

- [x] Unit tests for `src/lib/helpers.ts` (41 tests, incl. BASE_ETH_NODE, LINEA_ETH_NODE, tokenIdToLabelHash)
- [x] Integration tests for Registry events (5 tests)
- [x] Integration tests for Registrar events (6 tests)
- [x] Integration tests for NameWrapper events (7 tests)
- [x] Integration tests for Resolver events (8 tests)
- [x] Integration tests for Base L2 registrar events (2 tests)
- [x] Integration tests for Linea L2 registrar events (2 tests)

### Notes

- Tests use Envio's `createTestIndexer()` + `indexer.process()` with real Ethereum mainnet data via HyperSync
- Requires `ENVIO_API_TOKEN` environment variable for HyperSync access
- `vitest.config.ts` sets `testTimeout: 120_000` and `hookTimeout: 60_000` for network latency
- Run with `pnpm test` or `npx vitest run`

---

## Phase 3: Multi-Chain Subgraph Extensions

### Phase 3a: Basenames (Base L2)

**Status: DONE**
**Priority: —**
**Effort: Medium**
**Source:** `ensnode/apps/ensindexer/src/plugins/subgraph/plugins/basenames/`

Basenames is the `.base.eth` subregistry on Base L2. Reuses existing `Registry` and `Resolver` contract handlers (same events fire for both Ethereum and Base). New `BaseRegistrar_Base` + 3 controller contract names for Base-specific registrar logic.

#### Contracts Added

| Contract | HyperIndex Name | Chain | Address | Start Block |
|----------|----------------|-------|---------|-------------|
| Registry | `Registry` (reused) | Base (8453) | `0xb94704422c2a1e396835a571837aa5ae53285a95` | 17,571,480 |
| BaseRegistrar | `BaseRegistrar_Base` | Base (8453) | `0x03c4738ee98ae44591e1a4a4f3cab6641d95dd9a` | 17,571,486 |
| EARegistrarController | `EAController_Base` | Base (8453) | `0xd3e6775ed9b7dc12b205c8e608dc3767b9e5efda` | 17,575,699 |
| RegistrarController | `RegController_Base` | Base (8453) | `0x4ccb0bb02fcaba27e82a56646e81d8c5bc4119a5` | 18,619,035 |
| UpgradeableRegistrarController | `UpgController_Base` | Base (8453) | `0xa7d2607c6bd39ae9521e514026cbb078405ab322` | 35,286,620 |
| Resolver | `Resolver` (reused) | Base (8453) | Dynamic | 17,571,480 |

#### Implementation Summary

**Files changed:**

| File | Action | Changes |
|------|--------|---------|
| `src/lib/helpers.ts` | Modified | Added `BASE_ETH_NODE` constant, exported `tokenIdToLabelHash()` and parameterized `setNamePreimage()` |
| `src/handlers/Registrar.ts` | Modified | Imports shared `tokenIdToLabelHash` + `setNamePreimage` from helpers (removed local copies) |
| `src/handlers/Registry.ts` | Modified | Changed `rootNodeInitialized` boolean to per-chain `Set<number>` for multi-chain support |
| `config.yaml` | Modified | Added 4 Base contract definitions + Base chain (8453) section with 6 contracts |
| `src/handlers/BaseRegistrar.ts` | Created | All Base registrar + controller handlers (~230 lines) |
| `test/helpers.test.ts` | Modified | Added `BASE_ETH_NODE` and `tokenIdToLabelHash` tests (+3 tests) |
| `test/BaseRegistrar.test.ts` | Created | Integration tests for Base registrations |

**Handlers registered (9 total):**
- `BaseRegistrar_Base.NameRegistered` — creates Registration + Domain with preminting support
- `BaseRegistrar_Base.NameRegisteredWithRecord` — same as NameRegistered (extra resolver/ttl args ignored per subgraph behavior)
- `BaseRegistrar_Base.NameRenewed` — extends expiry
- `BaseRegistrar_Base.Transfer` — updates registrant
- `EAController_Base.NameRegistered` — sets name preimage (cost=0)
- `RegController_Base.NameRegistered` — sets name preimage (cost=0)
- `RegController_Base.NameRenewed` — sets name preimage (cost=0)
- `UpgController_Base.NameRegistered` — sets name preimage (cost=0)
- `UpgController_Base.NameRenewed` — sets name preimage (cost=0)

**Key design decisions:**
- **Contract name reuse**: `Registry` and `Resolver` handlers fire for both Ethereum and Base automatically
- **Multi-chain root init**: `rootNodeInitializedChains` Set ensures root domain creation check fires once per chain
- **Shared functions**: `tokenIdToLabelHash` and `setNamePreimage` extracted to `helpers.ts` with `managedNode`/`managedName` parameters
- **Controller arg remapping**: All 3 controllers have swapped arg names (`name` = plaintext label, `label` = labelHash)
- **Cost = 0n**: All Base controllers pass 0n cost

#### Remaining items (deferred)

- RegistrarController `endBlock` (35,936,564) — HyperIndex `end_block` config support not yet verified
- L1Resolver on mainnet (`0xde9049636f4a1dfe0a64d1bfe3155c0a14c54f31`, block 20,420,641) for bridging Base names to L1 — deferred to Phase 4 or later

---

### Phase 3b: Lineanames (Linea L2)

**Status: DONE**
**Priority: —**
**Effort: Medium**
**Source:** `ensnode/apps/ensindexer/src/plugins/subgraph/plugins/lineanames/`

Lineanames is the `.linea.eth` subregistry on Linea L2. Unlike Base, Linea has a NameWrapper. Reuses existing `Registry`, `Resolver`, and `NameWrapper` contract handlers. New `BaseRegistrar_Linea` and `EthController_Linea` contract names for Linea-specific registrar logic.

#### Contracts Added

| Contract | HyperIndex Name | Chain | Address | Start Block |
|----------|----------------|-------|---------|-------------|
| Registry | `Registry` (reused) | Linea (59144) | `0x50130b669b28c339991d8676fa73cf122a121267` | 6,682,888 |
| BaseRegistrar | `BaseRegistrar_Linea` | Linea (59144) | `0x6e84390dcc5195414ec91a8c56a5c91021b95704` | 6,682,892 |
| NameWrapper | `NameWrapper` (reused) | Linea (59144) | `0xa53cca02f98d590819141aa85c891e2af713c223` | 6,682,956 |
| EthRegistrarController | `EthController_Linea` | Linea (59144) | `0xdb75db974b1f2bd3b5916d503036208064d18295` | 6,682,978 |
| Resolver | `Resolver` (reused) | Linea (59144) | Dynamic | 6,682,888 |

#### Implementation Summary

**Files changed:**

| File | Action | Changes |
|------|--------|---------|
| `src/lib/helpers.ts` | Modified | Added `LINEA_ETH_NODE` constant, added `MANAGED_NODES` set for multi-chain NameWrapper support |
| `src/handlers/NameWrapper.ts` | Modified | Changed expiryDate preservation check from `ETH_NODE` to `MANAGED_NODES.has()` for multi-chain unwrapping |
| `config.yaml` | Modified | Added 2 Linea contract definitions + Linea chain (59144) section with 5 contracts |
| `src/handlers/LineaRegistrar.ts` | Created | All Linea registrar + controller handlers (~190 lines) |
| `test/helpers.test.ts` | Modified | Added `LINEA_ETH_NODE` test (+1 test) |
| `test/LineaRegistrar.test.ts` | Created | Integration tests for Linea registrations |

**Handlers registered (7 total):**
- `BaseRegistrar_Linea.NameRegistered` — creates Registration + Domain with preminting support
- `BaseRegistrar_Linea.NameRenewed` — extends expiry
- `BaseRegistrar_Linea.Transfer` — updates registrant
- `EthController_Linea.NameRegistered` — sets name preimage (cost = baseCost + premium)
- `EthController_Linea.NameRenewed` — sets name preimage (cost = cost)
- `EthController_Linea.OwnerNameRegistered` — sets name preimage (cost = 0, free for controller owner)
- `EthController_Linea.PohNameRegistered` — sets name preimage (cost = 0, free for PoH holders)

**Key design decisions:**
- **Contract name reuse**: `Registry`, `Resolver`, and `NameWrapper` handlers fire for Ethereum, Base, and Linea automatically
- **NameWrapper multi-chain fix**: `NameUnwrapped` handler now checks `MANAGED_NODES` set instead of just `ETH_NODE` to correctly preserve expiryDate for `.linea.eth` 2LDs
- **Controller arg remapping**: Same pattern as Base — `name` = plaintext label, `label` = labelHash
- **4 controller events**: Paid `NameRegistered` (baseCost+premium), `NameRenewed` (cost), free `OwnerNameRegistered` and `PohNameRegistered` (cost=0)

#### Remaining items (deferred)

- L1Resolver on mainnet (`0xde16ee87b0c019499cebdde29c9f7686560f679a`, block 20,410,692) for bridging Linea names to L1 — deferred to Phase 4 or later

---

### Phase 3c: ThreeDNS (Optimism + Base)

**Status: DONE**
**Priority: —**
**Effort: Medium**
**Source:** `ensnode/apps/ensindexer/src/plugins/subgraph/plugins/threedns/`

ThreeDNS is a third-party DNS integration for ENS, deployed on both Optimism and Base with identical contract addresses. It uses a completely different architecture from the standard ENS Registry model — ERC1155-based tokens with a hardcoded protocol-wide resolver.

#### Contracts Added

| Contract | HyperIndex Name | Chain | Address | Start Block |
|----------|----------------|-------|---------|-------------|
| ThreeDNSToken | `ThreeDNSToken` | Optimism (10) | `0xbb7b805b257d7c76ca9435b3ffe780355e4c4b17` | 110,393,959 |
| ThreeDNSResolver | `Resolver` (reused, static) | Optimism (10) | `0xf97aac6c8dbaebcb54ff166d79706e3af7a813c8` | 110,393,959 |
| ThreeDNSToken | `ThreeDNSToken` | Base (8453) | `0xbb7b805b257d7c76ca9435b3ffe780355e4c4b17` | 17,522,624 |
| ThreeDNSResolver | `Resolver` (reused, static) | Base (8453) | `0xf97aac6c8dbaebcb54ff166d79706e3af7a813c8` | 17,522,624 |

#### Implementation Summary

**Files changed:**

| File | Action | Changes |
|------|--------|---------|
| `src/lib/helpers.ts` | Modified | Added `THREEDNS_RESOLVER` constant, `decodeDnsEncodedName()` function, `ensureRootDomain()` function |
| `src/handlers/Registry.ts` | Modified | Refactored to use shared `ensureRootDomain()` from helpers, removed local `createRootDomain` |
| `config.yaml` | Modified | Added ThreeDNSToken contract definition, Optimism chain (10), ThreeDNSToken + static Resolver to Base chain |
| `src/handlers/ThreeDNS.ts` | Created | All ThreeDNS event handlers (~200 lines) |
| `test/helpers.test.ts` | Modified | Added `THREEDNS_RESOLVER` + `decodeDnsEncodedName` tests (+8 tests) |
| `test/ThreeDNS.test.ts` | Created | Integration tests for ThreeDNS on Optimism + Base |

**Handlers registered (4 total):**
- `ThreeDNSToken.NewOwner` — creates/updates domain with hardcoded ThreeDNS resolver, handles root node init per chain
- `ThreeDNSToken.Transfer` — updates domain ownership
- `ThreeDNSToken.RegistrationCreated` — decodes DNS-encoded FQDN, sets labelName/name/expiryDate, creates Registration
- `ThreeDNSToken.RegistrationExtended` — extends expiry on Domain and Registration

**Key design decisions:**
- **Resolver reuse**: ThreeDNS resolver at `0xf97aac6c8dbaebcb54ff166d79706e3af7a813c8` is registered as a static address for the existing `Resolver` contract on both Optimism and Base. Standard Resolver.ts handlers (AddrChanged, TextChanged, etc.) fire automatically.
- **No Registry on Optimism**: Optimism only has ThreeDNSToken + static Resolver. Root domain init handled by ThreeDNS NewOwner handler via shared `ensureRootDomain()`.
- **DNS name decoding**: New `decodeDnsEncodedName()` function decodes DNS wire-format FQDNs from RegistrationCreated events to extract labels and construct domain names.
- **Hardcoded resolver**: ThreeDNS NewOwner handler creates Resolver entities with the hardcoded `THREEDNS_RESOLVER` address and sets `domain.resolver_id` automatically (no dynamic NewResolver registration needed).
- **No grace period**: ThreeDNS uses raw expiry values (unlike mainnet/Base/Linea registrars which add GRACE_PERIOD_SECONDS).
- **DNS-specific resolver events (DNSRecordChanged, DNSRecordDeleted, etc.) skipped**: Not handled in subgraph-compatible mode per the Ponder reference implementation.

#### Remaining items (deferred)

- DNS-specific resolver events (DNSRecordChanged with TTL, DNSRecordDeleted, DNSZonehashChanged, ZoneCreated) — deferred, not handled in subgraph mode
- On-chain metadata reading for label healing via ThreeDNSToken.uri() — deferred to Protocol Acceleration plugin

---

## Phase 4: Protocol Acceleration Plugin

**Status: DONE**
**Priority: —**
**Effort: Large**
**Source:** `ensnode/apps/ensindexer/src/plugins/protocol-acceleration/`

This plugin provides fast domain resolution by caching resolver records and domain-resolver relationships. Critical for production ENS resolution performance.

### Schema Entities Added (7)

| Entity | Purpose |
|--------|---------|
| `PAResolver` | Resolver contract references (chainId, address) |
| `PAResolverRecords` | Resolver records per (chainId, address, node) |
| `PAResolverAddressRecord` | Address records indexed by coinType |
| `PAResolverTextRecord` | Text records indexed by key |
| `DomainResolverRelation` | Domain-to-resolver mapping cache |
| `ReverseNameRecord` | ENSIP-19 reverse records (address → name by coinType) |
| `MigratedNode` | RegistryOld → Registry migration tracking |

### Contracts Configured (across 6 chains)

**StandaloneReverseRegistrar** (ENSIP-19 reverse resolution):

| Chain | Address | Start Block |
|-------|---------|-------------|
| Mainnet (1) | `0x283f227c4bd38ece252c4ae7ece650b0e913f1f9` | 22,764,819 |
| Base (8453) | `0x0000000000d8e504002cc26e3ec46d81971c1664` | 31,808,582 |
| Linea (59144) | `0x0000000000d8e504002cc26e3ec46d81971c1664` | 20,173,340 |
| Optimism (10) | `0x0000000000d8e504002cc26e3ec46d81971c1664` | 137,403,854 |
| Arbitrum (42161) | `0x0000000000d8e504002cc26e3ec46d81971c1664` | 349,263,357 |
| Scroll (534352) | `0x0000000000d8e504002cc26e3ec46d81971c1664` | 16,604,272 |

**Static mainnet reverse resolvers added to Resolver contract:**
- DefaultReverseResolver2: `0x231b0ee14048e9dccd1d247744d114a4eb5e8e63`
- DefaultReverseResolver3: `0xa7d635c8de9a58a228aa69353a1699c7cc240dcf`
- BaseReverseResolver: `0xc800dbc8ff9796e58efba2d7b35028ddd1997e5e`
- LineaReverseResolver: `0x0ce08a41bdb10420fb5cac7da8ca508ea313aef8`
- OptimismReverseResolver: `0xf9edb1a21867ac11b023ce34abad916d29abf107`
- ArbitrumReverseResolver: `0x4b9572c03aaa8b0efa4b4b0f0cc0f0992bedb898`
- ScrollReverseResolver: `0xc4842814ca523e481ca5aa85f719fed1e9cac614`

**DNS record events added to Resolver contract:**
- `DNSRecordChanged` (4-arg, without TTL)
- `DNSRecordChanged` (5-arg, with TTL) — custom event name `DNSRecordChanged5` to avoid codegen collision
- `DNSRecordDeleted`

### Implementation Summary

**Files changed:**

| File | Action | Changes |
|------|--------|---------|
| `schema.graphql` | Modified | Added 7 PA entities |
| `config.yaml` | Modified | Added StandaloneReverseRegistrar contract, DNS events to Resolver, Arbitrum + Scroll chains, static reverse resolver addresses, StandaloneReverseRegistrar to existing chains |
| `src/lib/protocol-acceleration.ts` | Created | PA helper module (~325 lines): ID generators, coin type utilities (ETH_COIN_TYPE, DEFAULT_EVM_COIN_TYPE, evmChainIdToCoinType, bigintToCoinType), interpretation functions (interpretNameRecordValue, interpretAddressRecordValue, interpretTextRecordKey, interpretTextRecordValue), DB helpers (ensurePAResolver, ensurePAResolverRecords, handlePAAddressRecordUpdate, handlePATextRecordUpdate, handlePANameUpdate, upsertDomainResolverRelation, migrateNode, nodeIsMigrated, upsertReverseNameRecord) |
| `src/handlers/Registry.ts` | Modified | Added `isOldRegistry` param to `handleNewResolver`, appended PA calls: `upsertDomainResolverRelation` (with migration check for RegistryOld on chainId 1) + `migrateNode` in `handleNewOwner` for Registry on chainId 1 |
| `src/handlers/Resolver.ts` | Modified | Appended PA calls to AddrChanged (ETH address), AddressChanged (multicoin), NameChanged, TextChanged handlers; added DNS record helpers (parseRRSet, decodeTXTData, parseDnsTxtRecordArgs) and 3 new PA-only handlers: DNSRecordChanged4, DNSRecordChanged5, DNSRecordDeleted |
| `src/handlers/ThreeDNS.ts` | Modified | Appended `upsertDomainResolverRelation` call to NewOwner handler |
| `src/handlers/ReverseRegistrar.ts` | Created | StandaloneReverseRegistrar.NameForAddrChanged handler (~22 lines) — indexes ENSIP-19 reverse name records per address and coinType |
| `package.json` | Modified | Added `dns-packet` dependency + `@types/dns-packet` dev dependency |

### Completed Tasks

- [x] Add 7 PA entities to `schema.graphql` (PAResolver, PAResolverRecords, PAResolverAddressRecord, PAResolverTextRecord, DomainResolverRelation, ReverseNameRecord, MigratedNode)
- [x] Create `src/lib/protocol-acceleration.ts` helper module with ID generators, interpretation functions, coin type utilities, and DB helpers
- [x] Add StandaloneReverseRegistrar contract definition and DNS events to Resolver in `config.yaml`
- [x] Add Arbitrum (42161) and Scroll (534352) chains to `config.yaml`
- [x] Add static reverse resolver addresses to mainnet Resolver contract in `config.yaml`
- [x] Add StandaloneReverseRegistrar to existing chains (Mainnet, Base, Linea, Optimism)
- [x] Install `dns-packet` + `@types/dns-packet` dependencies
- [x] Run `pnpm codegen` — generates types for all 7 new entities + StandaloneReverseRegistrar + DNS events
- [x] Merge PA logic into `Registry.ts` — `upsertDomainResolverRelation` in `handleNewResolver`, `migrateNode` in `handleNewOwner`, migration check for RegistryOld
- [x] Merge PA logic into `ThreeDNS.ts` — `upsertDomainResolverRelation` in NewOwner handler
- [x] Merge PA logic into `Resolver.ts` — PA calls appended to AddrChanged, AddressChanged, NameChanged, TextChanged
- [x] Add DNS record event handlers (DNSRecordChanged4, DNSRecordChanged5, DNSRecordDeleted) with RRSet parsing via `dns-packet`
- [x] Create `src/handlers/ReverseRegistrar.ts` for StandaloneReverseRegistrar.NameForAddrChanged
- [x] Type check passes (`pnpm tsc --noEmit` — zero errors)
- [x] Existing tests pass (79/81 — 2 timeouts are pre-existing network issues)

### Architecture Decision (Resolved)

PA logic is **merged into existing handlers** via PA helper function calls appended after the existing subgraph logic. This preserves zero changes to subgraph behavior while adding PA functionality. PA helper functions live in `src/lib/protocol-acceleration.ts`. The key patterns:

- **Registry.handleNewResolver** → existing subgraph logic + `upsertDomainResolverRelation()`
- **Registry.handleNewOwner** → existing subgraph logic + `migrateNode()` (ENS Root only)
- **Resolver.AddrChanged/AddressChanged/NameChanged/TextChanged** → existing subgraph logic + PA record upsert/delete
- **ThreeDNS.NewOwner** → existing subgraph logic + `upsertDomainResolverRelation()`
- **StandaloneReverseRegistrar.NameForAddrChanged** → PA-only (new handler)
- **DNSRecordChanged/Deleted** → PA-only (new handlers)

### Deferred Items

- **Legacy 3-arg TextChanged** (`TextChanged(bytes32 indexed node, string indexed indexedKey, string key)`) — emitted by legacy resolvers (LegacyPublicResolver, DefaultPublicResolver3) without a `value` param. Requires Effect API for on-chain `text(node, key)` reads. Only affects historical events from 2 specific contracts on mainnet.
- **ENSv2Registry.ResolverUpdated** — deferred to Phase 7 (ENSv2 Plugin)

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
- [ ] Migrate `Lineanames_RegistrarController.ts` — 4 events: `OwnerNameRegistered`, `PohNameRegistered`, `NameRegistered`, `NameRenewed`
- [ ] Port shared library logic:
  - `registrar-action.ts` — logical action aggregation
  - `registrar-events.ts` — BaseRegistrar event handlers (NameRegistered, NameRenewed)
  - `registrar-controller-events.ts` — controller event handlers (NameRegistered, NameRenewed by controller)
  - `registration-lifecycle.ts` — lifecycle state machine
  - `subregistry.ts` — subregistry tracking
  - `universal-registrar-renewal-with-referrer-events.ts` — referrer tracking for universal renewals

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

### Contracts Used

| Contract | Chain | Address | Start Block | Event Type |
|----------|-------|---------|-------------|------------|
| Seaport 1.5 | Mainnet (1) | `0x00000000000000adc04c56bf30ac9d3c0aaf14dc` | 17,129,405 | OrderFulfilled |
| EthBaseRegistrar | Mainnet (1) | `0x57f1887a8bf19b14fc0df6fd9b2acc9af147ea85` | 9,380,410 | ERC721 Transfer |
| BaseBaseRegistrar | Base (8453) | `0x03c4738ee98ae44591e1a4a4f3cab6641d95dd9a` | 17,571,486 | ERC721 Transfer |
| LineaBaseRegistrar | Linea (59144) | `0x6e84390dcc5195414ec91a8c56a5c91021b95704` | 6,682,892 | ERC721 Transfer |
| NameWrapper | Mainnet (1) | `0xd4416b13d2b3a9abae7acd5d6c2bbdbe25686401` | 16,925,608 | ERC1155 TransferSingle/Batch |
| ThreeDNSToken | Optimism (10) | `0xbb7b805b257d7c76ca9435b3ffe780355e4c4b17` | 110,393,959 | ERC1155 TransferSingle/Batch |
| ThreeDNSToken | Base (8453) | `0xbb7b805b257d7c76ca9435b3ffe780355e4c4b17` | 17,522,624 | ERC1155 TransferSingle/Batch |

### Handler Work

- [ ] Add `nameSales` and `nameTokens` entities to schema
- [ ] Add Seaport 1.5 ABI and contract config
- [ ] Migrate `BaseRegistrars.ts` handler — ERC721 Transfer tracking for **Eth + Base + Linea** BaseRegistrars (3 contracts across 3 chains)
- [ ] Migrate `NameWrapper.ts` handler — ERC1155 TransferSingle/TransferBatch tracking
- [ ] Migrate `ThreeDNSToken.ts` handler — ERC1155 TransferSingle/TransferBatch events on both Optimism and Base
- [ ] Migrate `Seaport.ts` handler — OrderFulfilled events for secondary market sales
- [ ] Port shared libraries:
  - `handle-nft-transfer.ts` — mint/burn detection, CAIP-19 asset ID generation
  - `nft-issuers.ts` — NFT issuer identification
  - `seaport.ts` — Seaport order fulfillment parsing

### Notes

- Seaport handler parses complex order structures to extract ENS domain sales
- CAIP-19 asset IDs follow `eip155:{chainId}/{namespace}:{contract}/{tokenId}` format
- TokenScope reuses Transfer events from BaseRegistrar and NameWrapper (same merge concern)
- **ThreeDNS quirk**: `allowMintedRemint = true` — 3DNS contracts allow a minted NFT to be reminted before an intermediate burn (non-standard behavior)

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

**Sepolia V2 test deployment (addresses known):**

| Contract | Chain | Address | Start Block |
|----------|-------|---------|-------------|
| RootRegistry | Sepolia | `0x245de1984f9bb890c5db0b1fb839470c6a4c7e08` | 9,374,708 |
| ETHRegistry | Sepolia | `0x3f0920aa92c5f9bce54643c09955c5f241f1f763` | 9,374,708 |
| ETHRegistrar | Sepolia | `0x3334f0ebcbc4b5b7067f3aff25c6da8973690d54` | 9,374,708 |
| EnhancedAccessControl | Sepolia | Per-chain from datasource config | 9,374,708 |

**Mainnet deployment: TBD** (contracts not yet deployed on mainnet)

**V1 contracts tracked in ENSv2 context (multi-chain):**
- ENSv1Registry: ENS Root + Basenames + Lineanames
- BaseRegistrar: ENS Root + Basenames + Lineanames
- NameWrapper: ENS Root + Lineanames
- RegistrarController: ENS Root (3 controllers) + Basenames (3 controllers) + Lineanames (1 controller)

### Handler Work

- [ ] Add all ENSv2 schema entities (12 total)
- [ ] Add ENSv2 contract ABIs (Registry, ETHRegistrar, EnhancedAccessControl)
- [ ] Migrate `ensv1/BaseRegistrar.ts` — v1 BaseRegistrar `Transfer` events across ENS Root + Basenames + Lineanames
- [ ] Migrate `ensv1/ENSv1Registry.ts` — v1 Registry `NewOwner` events on RegistryOld + Registry
- [ ] Migrate `ensv1/NameWrapper.ts` — v1 NameWrapper `TransferSingle`/`TransferBatch` events on ENS Root + Lineanames
- [ ] Migrate `ensv1/RegistrarController.ts` — v1 controller `NameRegistered`/`NameRenewed` events across all subregistries
- [ ] Migrate `ensv2/ENSv2Registry.ts` — v2 Registry events: `NameRegistered`, `ExpiryUpdated`, `SubregistryUpdated`, `TokenRegenerated`, `TransferSingle`, `TransferBatch`
- [ ] Migrate `ensv2/ETHRegistrar.ts` — v2 ETHRegistrar `NameRegistered` events
- [ ] Migrate `ensv2/EnhancedAccessControl.ts` — `EACRolesChanged` events for permissions tracking
- [ ] Label rainbow table population (labelHash → InterpretedLabel mapping)

### Notes

- ENSv2 Sepolia test deployment exists; mainnet deployment TBD — monitor ENS team announcements
- This plugin tracks BOTH v1 and v2 domains simultaneously for the migration period
- **Dual-registry architecture**: v1Domain (flat tree) + v2Domain (graph-based with sub-registries)
- **Materialized effective owner**: v1Domain.owner computed at index time (considers Registry, Registrars, NameWrapper ownership)
- Polymorphic registrations support types: `BaseRegistrar`, `NameWrapper`, `ENSv2Registry`
- **Multi-chain v1 tracking**: The ENSv2 plugin re-indexes v1 contract events across ENS Root, Basenames, and Lineanames chains

---

## Contract Reference

### All Chains Summary

| Chain | ID | Contracts | Plugins Using |
|-------|----|-----------|---------------|
| Ethereum Mainnet | 1 | ~15 | All plugins |
| Base | 8453 | ~8 | Subgraph, ProtocolAccel, Registrars, TokenScope |
| Linea | 59144 | ~6 | Subgraph, ProtocolAccel, Registrars, TokenScope |
| Optimism | 10 | ~3 | Subgraph (3DNS), ProtocolAccel, TokenScope |
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
| ENSv2 (Phase 7) | 12 | 0 | 12 |
| **Total** | **29** | **20** | **~49** |

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

The Ponder codebase has a rich shared handler architecture under `shared-handlers/`:

- `Registry.ts` — parameterized `handleNewOwner(isMigrated)` factory, used by Basenames, Lineanames, ENSRoot
- `Registrar.ts` — `makeRegistrarHandlers({ pluginName })` factory returning 5 handler functions, includes preminting support
- `NameWrapper.ts` — all NameWrapper event handlers, used by Lineanames + ENSRoot
- `Resolver.ts` — all resolver event handlers exported as individual functions
- `ThreeDNSToken.ts` — standalone shared handlers for ThreeDNS (320 lines)
- `multi-chain/Resolver.ts` — **idempotent registration wrapper** with `hasBeenRegistered` boolean flag to ensure multi-chain Resolver handlers are only registered once even when called from multiple plugins

In HyperIndex, consider creating equivalent shared functions that can be called from chain-specific handlers to avoid code duplication.

### 4. End Block Support

Basenames `RegistrarController` has an `endBlock` (35,936,564) — verify if HyperIndex config supports `end_block` for contracts that are superseded.

### 5. Preminting Support

Both Basenames and Lineanames support "preminted" names — names registered in the BaseRegistrar without a corresponding Registry `NewOwner` event. When a `NameRegistered` event fires and no Domain entity exists, the handler must create the Domain on-demand by invoking the equivalent of `handleNewOwner(isMigrated=true)`. This is controlled by `pluginSupportsPremintedNames` in the Ponder code.
