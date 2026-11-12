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
- **Assigned:** a registry points at it (resolvers).
- **Signature:** events are matched on any address on the chains that use them, and trusted only through a proven link. See [ENSv2](ensv2.md).

| Contract | Found by | Events |
|---|---|---|
| ENS registry (old and current) | Fixed | NewOwner, Transfer, NewResolver, NewTTL |
| .eth base registrar | Fixed | NameRegistered, NameRenewed, Transfer |
| Name wrapper | Fixed | NameWrapped, NameUnwrapped, FusesSet, ExpiryExtended, TransferSingle, TransferBatch |
| .eth registrar controllers (legacy, wrapped, unwrapped) | Fixed | NameRegistered, NameRenewed |
| Basenames registrar and controllers | Fixed | NameRegistered, NameRegisteredWithRecord, NameRenewed, Transfer, ETHPaymentProcessed |
| Linea registrar and controller | Fixed | NameRegistered, NameRenewed, Transfer, OwnerNameRegistered, PohNameRegistered |
| 3DNS token | Fixed | NewOwner, Transfer, RegistrationCreated, RegistrationExtended, TransferSingle, TransferBatch |
| Resolvers | Signature, applied from the block a registry first assigns the resolver | AddrChanged, AddressChanged, NameChanged, ABIChanged, PubkeyChanged, TextChanged, ContenthashChanged, InterfaceChanged, AuthorisationChanged, VersionChanged, DNSRecordChanged, DNSRecordDeleted |
| Reverse registrar (legacy) | Fixed | ReverseClaimed |
| Standalone reverse registrar | Fixed | NameForAddrChanged |
| Universal renewal | Fixed | RenewalReferred |
| Seaport | Fixed | OrderFulfilled (sales of ENS names) |
| ENSv2 registries (root, .eth, user and wrapper registries) | Root and .eth fixed; the rest by signature | RegistryCreated, LabelRegistered, LabelReserved, LabelUnregistered, ExpiryUpdated, SubregistryUpdated, ResolverUpdated, ParentUpdated, TokenRegenerated, TokenResource, EACRolesChanged, TransferSingle, TransferBatch |
| ENSv2 registrar and renewer | Fixed | NameRegistered, NameRenewed |
| ENSv2 resolvers (permissioned and others) | Signature | ResolverCreated, Linked, Cleared, AddressUpdated, TextUpdated, ContenthashUpdated, NameUpdated, DataUpdated, ABIUpdated, InterfaceUpdated, AliasChanged |
| Node-keyed resolvers linked from ENSv2 | Signature, from the ENSv2 start block | AddrChanged, AddressChanged, TextChanged, ContenthashChanged, NameChanged |

ERC-1155 transfers on ENSv2 registries share their signature with every ERC-1155 token. They are read only from registries that have created a registry, been linked, or registered a label.

## Not covered

- Offchain (CCIP-Read) resolvers: the resolver is recorded, but records served offchain are not.
- Past-block queries: the API serves the current state.
