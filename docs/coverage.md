# Coverage

## Chains

| Chain | ID | What is indexed |
|---|---|---|
| Ethereum | 1 | ENSv1 (registry, .eth registrar, name wrapper, controllers, resolvers, reverse registrars, renewals, Seaport sales of names) and ENSv2 |
| Base | 8453 | Basenames registry, registrar and controllers, resolvers, 3DNS, reverse registrar |
| Linea | 59144 | Linea names registry, registrar, name wrapper and controller, resolvers, reverse registrar |
| Optimism | 10 | 3DNS and its resolver, reverse registrar |
| Arbitrum | 42161 | Reverse registrar |
| Scroll | 534352 | Reverse registrar |
| Sepolia | 11155111 | ENSv2 only |

ENSv2 is deployed on Ethereum and Sepolia. The other chains run ENSv1-style contracts.

Addresses are in `config.yaml`. ENSv2 addresses come from ENS's deployment artifacts (`ensdomains/contracts-v2`, `contracts/deployments/{mainnet,sepolia}`); the commit is noted in `src/lib/v2-deployments.ts`.

## Contracts and events

How a contract is found:

- **Fixed:** the address is in `config.yaml`.
- **Signature:** events are matched on any address on the chains that use them. ENSv2 events are trusted only through a proven link; see [ENSv2](ensv2.md).

| Contract | Found by | Events |
|---|---|---|
| ENS registry (old and current) | Fixed | NewOwner, Transfer, NewResolver, NewTTL |
| .eth base registrar | Fixed | NameRegistered, NameRenewed, Transfer |
| Name wrapper | Fixed | NameWrapped, NameUnwrapped, FusesSet, ExpiryExtended, TransferSingle, TransferBatch |
| .eth registrar controllers (legacy, wrapped, unwrapped) | Fixed | NameRegistered, NameRenewed |
| Basenames registrar and controllers | Fixed | NameRegistered, NameRegisteredWithRecord, NameRenewed, Transfer, ETHPaymentProcessed |
| Linea registrar and controller | Fixed | NameRegistered, NameRenewed, Transfer, OwnerNameRegistered, PohNameRegistered |
| 3DNS token | Fixed | NewOwner, Transfer, RegistrationCreated, RegistrationExtended, TransferSingle, TransferBatch |
| Resolvers | Signature, from any address, whether or not a registry has assigned it (as the ENS subgraph does) | AddrChanged, AddressChanged, NameChanged, ABIChanged, PubkeyChanged, TextChanged, ContenthashChanged, InterfaceChanged, AuthorisationChanged, VersionChanged, DNSRecordChanged, DNSRecordDeleted |
| Reverse registrar (legacy) | Fixed | ReverseClaimed |
| Standalone reverse registrar | Fixed | NameForAddrChanged |
| Universal renewal | Fixed | RenewalReferred |
| Seaport | Fixed | OrderFulfilled (sales of ENS names) |
| ENSv2 registries (root, .eth, user and wrapper registries) | Root and .eth fixed; the rest by signature | RegistryCreated, LabelRegistered, LabelReserved, LabelUnregistered, ExpiryUpdated, SubregistryUpdated, ResolverUpdated, ParentUpdated, TokenRegenerated, TokenResource, EACRolesChanged, TransferSingle, TransferBatch |
| ENSv2 registrar and renewer | Fixed | NameRegistered, NameRenewed |
| ENSv2 resolvers (permissioned and others) | Signature | ResolverCreated, Linked, Cleared, AddressUpdated, TextUpdated, ContenthashUpdated, NameUpdated, DataUpdated, ABIUpdated, InterfaceUpdated, AliasChanged |
| Node-keyed resolvers linked from ENSv2 | Signature, from the ENSv2 start block | AddrChanged, AddressChanged, TextChanged, ContenthashChanged, NameChanged |

ERC-1155 transfers on ENSv2 registries share their signature with every ERC-1155 token. They are matched on any address from the ENSv2 start block and applied only for the root and .eth registries and for addresses already known as registries: one that emitted RegistryCreated or any label, link or token event, or that a SubregistryUpdated points at. Transfers from other ERC-1155 contracts are skipped. No contract is watched by address after discovery, so no data depends on when HyperIndex starts watching one.

## Rules that differ from the ENS subgraph

- **Primary names on Ethereum.** `reverse_name_record` is set from a `NameChanged` on an `<address>.addr.reverse` node only when it comes from the resolver the registry assigns to that node. The subgraph has no primary-name table. Without this rule any contract could emit `NameChanged` for another address's reverse node and set its primary name. The `NameChanged` event is still recorded, and the resolver's own row is still updated.

- **ENSv2-era rules: where our port differs from the subgraph (ens-subgraph v2.2.0, 16846b1).**
  - Migration controllers: our sink list includes the controllers superseded on 2026-10-18 as well as the two current ones the subgraph lists. Any controller that held v1 state is a sink.
  - Registrar tables (`registrar_action`, `expiry_day_stat`, `registration_daily_stat` and related) are ours; the subgraph has none. A Graveyard retirement is not counted there.
  - The projection is re-derived from the whole v2 row after every v2 write (`src/lib/legacy-projection.ts`), not by one function per event. For example, the subgraph clears the resolver on registration and re-attaches it on ResolverUpdated; we take the v2 resolver as it stands. The result after each block is the same.
  - A NameWrapper event for a name with no row yet: the subgraph creates the row; we log it and skip, as before.
- **Label names.** The subgraph names labels from graph-node's label table (`ens.nameByHash`). We name a label only when an event carries it, plus `eth`, `reverse` and `addr`. Names with other unknown labels read `[labelhash].parent`.

## Not covered

- Offchain (CCIP-Read) resolvers: the resolver is recorded, but records served offchain are not.
- Past-block queries: the API serves the current state.
