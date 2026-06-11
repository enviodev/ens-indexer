# ENSDb DB-Level Parity — Gap Analysis

Context: Step 1 of the Envio↔ENS collaboration scopes Envio as a compatible
**EnsDbWriter** for the ENS Subgraph data model. The ENSDb standard means an
ENSDbReader (e.g. [ENSApi](https://github.com/namehash/ensnode/tree/main/apps/ensapi))
reads the writer's Postgres directly via its drizzle schema. GraphQL-level
parity (verified by `ens-subgraph-transition-tools`) is therefore necessary but
not sufficient — the **physical Postgres surface** (table names, column names,
column types, metadata tables) must also line up, or the standard must evolve
to accommodate writer-specific naming (which lightwalker explicitly offered).

This document maps the current envio output (verified against a live
`envio@3.0.0-rc.0` database) to the ENSNode/Ponder reference (from
`apps/ensindexer`'s schema files) and lists options for closing each gap.

## 1. Table names

Envio derives the physical table name directly from the schema entity name.
Entities were renamed (branch `nb/ensdb-naming-parity`) to match the ENSNode
ponder schema **export** names — but Ponder's physical table names come from
the first argument of `onchainTable(...)`, which is pluralized for most
entities.

| envio table (actual)               | ENSDb table (ponder reference)        | gap        |
| ---------------------------------- | ------------------------------------- | ---------- |
| `subgraph_domain`                  | `subgraph_domains`                    | plural     |
| `subgraph_account`                 | `subgraph_accounts`                   | plural     |
| `subgraph_resolver`                | `subgraph_resolvers`                  | plural     |
| `subgraph_registration`            | `subgraph_registrations`              | plural     |
| `subgraph_wrapped_domain`          | `subgraph_wrapped_domains`            | plural     |
| `subgraph_transfer`                | `subgraph_transfers`                  | plural     |
| `subgraph_new_owner`               | `subgraph_new_owners`                 | plural     |
| `subgraph_new_resolver`            | `subgraph_new_resolvers`              | plural     |
| `subgraph_new_ttl`                 | `subgraph_new_ttls`                   | plural     |
| `subgraph_wrapped_transfer`        | `subgraph_wrapped_transfers`          | plural     |
| `subgraph_name_wrapped`            | `subgraph_name_wrapped`               | none ✓     |
| `subgraph_name_unwrapped`          | `subgraph_name_unwrapped`             | none ✓     |
| `subgraph_fuses_set`               | `subgraph_fuses_set`                  | none ✓     |
| `subgraph_expiry_extended`         | `subgraph_expiry_extended`            | none ✓     |
| `subgraph_name_registered`         | `subgraph_name_registered`            | none ✓     |
| `subgraph_name_renewed`            | `subgraph_name_renewed`               | none ✓     |
| `subgraph_name_transferred`        | `subgraph_name_transferred`           | none ✓     |
| `subgraph_*_changed` (10 tables)   | `subgraph_*_changed`                  | none ✓     |
| `resolver`                         | `resolvers`                           | plural     |
| `resolver_records`                 | `resolver_records`                    | none ✓     |
| `resolver_address_record`          | `resolver_address_records`            | plural     |
| `resolver_text_record`             | `resolver_text_records`               | plural     |
| `domain_resolver_relation`         | `domain_resolver_relations`           | plural     |
| `reverse_name_record`              | `reverse_name_records`                | plural     |
| `migrated_node_by_node`            | `migrated_nodes_by_node`              | plural     |
| —                                  | `migrated_nodes_by_parent`            | not built (Ponder prefetch optimization; envio doesn't need it) |
| `subregistry`                      | `subregistries`                       | plural     |
| `registration_lifecycle`           | `registration_lifecycles`             | plural     |
| `registrar_action`                 | `registrar_actions`                   | plural     |
| `internal_registrar_action_metadata` | `_ensindexer_registrar_action_metadata` | name + leading underscore |
| `name_token`                       | `name_tokens`                         | plural     |
| `name_sale`                        | `name_sales`                          | plural     |

Net: ~19 tables differ only by pluralization; 17 already exact.

Why not just rename entities to the plural table names: envio couples entity
name = GraphQL type = Hasura field = TS context key = table name. Plural
entity names are livable, but the cleaner fix is decoupling (see options).

## 2. Column names

envio uses the schema field name verbatim as the column name (camelCase).
Ponder runs drizzle with snake_case casing, so its physical columns are
snake_case versions of the TS property names.

Verified envio columns vs expected ENSDb columns (subgraph_registration):

| envio column (actual) | ENSDb column (expected) | gap |
| --------------------- | ----------------------- | --- |
| `id`                  | `id`                    | ✓   |
| `domain_id`           | `domain_id`             | ✓   |
| `registrationDate`    | `registration_date`     | case |
| `expiryDate`          | `expiry_date`           | case |
| `cost`                | `cost`                  | ✓   |
| `registrant_id`       | `registrant_id`         | ✓   |
| `labelName`           | `label_name`            | case |

Pattern: relationship columns (`*_id`) already match because envio's `_id`
convention coincides with drizzle's snake_case of ponder's `*Id` fields.
Multi-word value columns (`subdomainCount`, `createdAt`, `isMigrated`,
`contentHash`, `transactionID`, `blockNumber`, …) differ by case only.

⚠️ TO VERIFY against a live ENSDb dump: drizzle's exact snake_case output for
irregular names (`transactionID` → `transaction_id` vs `transaction_i_d`;
`contentHash` → `content_hash`). Do this before any rename work.

## 3. Column types

| schema type | envio (actual)     | ponder (reference)        | compatible? |
| ----------- | ------------------ | ------------------------- | ----------- |
| `ID!`/refs  | `text`             | `text` (`t.hex()`/`t.text()`) | ✓ (hex stored as lowercase text both sides) |
| `BigInt`    | `numeric`          | `numeric(78)`             | ✓ reads fine; precision declaration differs |
| `Int`       | `integer`          | `t.integer()` → `integer` | ✓ |
| `chainId`   | `integer`          | `t.int8({mode:"number"})` → `bigint` | type width differs; reads coerce |
| `Boolean`   | `boolean`          | `boolean`                 | ✓ |
| `[String!]` | `text[]`           | `text[]`                  | ✓ |
| `[BigInt!]` | `text[]` (!)       | `numeric[]` (ponder `t.bigint().array()`) | ✗ element type differs (`subgraph_resolver.coinTypes`) |

Also: graph-node uses collation `"C"` for string ordering; ENSNode
monkeypatches `subgraph_domains.name/label_name` to `COLLATE "C"`. envio
columns use DB default collation — affects `ORDER BY` results on name columns
at the reader layer. Lowercase-hex `id` columns are unaffected.

## 4. Indexing metadata tables

| envio                                    | ponder/ENSDb                  |
| ---------------------------------------- | ----------------------------- |
| `envio_chains`, `envio_addresses`, `envio_checkpoints`, `envio_info` | `_ponder_meta`, `_ponder_status`, `_ponder_checkpoint` |
| `envio_history_*` (reorg history, per entity) | `_reorg__*` (per table)  |
| `chain_metadata`, `_meta`, `raw_events`  | —                             |

No overlap. This is the "first engineering problem" lightwalker scoped:
ENSDb's metadata model is mid-refactor on their side, and they explicitly
offered to evolve the standard so envio's representation fits naturally.
Deliverable here is a proposal, not a rename: define what an ENSDbReader
actually needs (per-chain indexed height, readiness, reorg safety horizon) and
map both writers' native tables onto that contract.

## 5. Options for closing the gaps

**A. Postgres view layer (recommended short-term).** Ship a SQL migration that
creates an `ensdb` schema of views over the envio tables:

```sql
CREATE VIEW ensdb.subgraph_registrations AS
SELECT id,
       domain_id,
       "registrationDate" AS registration_date,
       "expiryDate"       AS expiry_date,
       cost,
       registrant_id,
       "labelName"        AS label_name
FROM public.subgraph_registration;
```

- Zero envio changes, zero reindex, reversible, testable today (point ENSApi at
  `ensdb` schema).
- Covers table names, column names, and the metadata contract (views over
  `envio_chains` emulating `_ponder_status`).
- Cost: views are read-only surface; writes stay on envio names (fine — reader
  standard only needs reads). Type gaps (`coinTypes text[]` vs `numeric[]`)
  can be cast in the view.

**B. envio feature: physical-name mapping.** `@config(table: "...")`-style
directive (or config-level map) decoupling entity name from table name +
snake_case column option. Best long-term DX; needs envio core work —
candidate for the Step-2 feature-prioritization agreement.

**C. Evolve the ENSDb standard.** Per lightwalker: "we want to listen to your
perspectives and actually evolve the ENSDb standard so that it can more
naturally be achieved by Envio." Propose the standard specify a small
**naming manifest** (logical entity → physical table/column map) that readers
like ENSApi consume, instead of hardcoding ponder's drizzle output. Then both
writers comply natively and option A/B become optional.

Recommended sequence: A now (unblocks ENSApi-on-envio experiments), C as the
standards conversation, B if/when C lands on writer-native naming.

## 6. Current status

- [x] GraphQL-level entity naming aligned to ENSNode schema exports
- [x] snapshot-eq harness extended with envio mode (transforms verified on
      synthetic data; see `ens-subgraph-transition-tools` clone)
- [x] `config.validation.yaml` — mainnet-only subgraph scope for the
      validation sync (excludes L2 chains + PA statics + registrars/tokenscope
      contracts so `subgraph_*` tables receive only subgraph-equivalent data)
- [ ] Validation sync + snapshot diff (requires sync to target blockheight)
- [ ] Verify drizzle snake_case output against live ENSDb dump (§2)
- [ ] View-layer migration (option A) if DB-level reads are pursued before
      the standard evolves
