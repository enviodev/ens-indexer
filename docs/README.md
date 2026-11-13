# ENS indexer documentation

An indexer for the Ethereum Name Service, covering ENSv1 and ENSv2 in one database, built on [HyperIndex](https://docs.envio.dev). It reads chain data through HyperSync, writes to Postgres, and serves it through a GraphQL API with the ENS subgraph's query shape, a REST API, and a change stream.

- [Coverage](coverage.md): chains, contracts and events.
- [ENSv2](ensv2.md): how registries and resolvers are discovered and trusted, and how names are built.
- [Schema](schema.md): the tables, their keys, and how v1 and v2 join.
- [API](api.md): GraphQL, REST and the change stream.
- [Running](running.md): run the indexer, the API, the tests and the export locally.
- [Archive export](export.md): Parquet files in S3-compatible storage.
