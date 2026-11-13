// GraphQL API compatible with the ENS subgraph's query shape.
// Types and filters are generated from the table below, so adding a field is one line.
import { GraphQLBoolean, GraphQLEnumType, GraphQLError, GraphQLID, GraphQLInputObjectType, GraphQLInt, GraphQLList, GraphQLNonNull, GraphQLObjectType, GraphQLScalarType, GraphQLSchema, GraphQLString } from "graphql";
import { q } from "./db.mjs";

const BigIntScalar = new GraphQLScalarType({ name: "BigInt", serialize: String, parseValue: String, parseLiteral: (a) => a.value });
const BytesScalar = new GraphQLScalarType({ name: "Bytes", serialize: String, parseValue: String, parseLiteral: (a) => a.value });

const SCALARS = { ID: GraphQLID, String: GraphQLString, Int: GraphQLInt, Boolean: GraphQLBoolean, BigInt: BigIntScalar, Bytes: BytesScalar };

// chainPrefixed: the stored id starts with "{chainId}-"; the subgraph's ids do not.
const ENTITIES = {
  Domain: {
    table: "ens_unified_domain", plural: "domains",
    fields: {
      id: { t: "ID", col: "id" }, name: { t: "String" }, labelName: { t: "String" }, labelhash: { t: "Bytes" },
      subdomainCount: { t: "Int" }, ttl: { t: "BigInt" }, isMigrated: { t: "Boolean" }, createdAt: { t: "BigInt" },
      expiryDate: { t: "BigInt" }, protocol: { t: "String" },
      parent: { ref: "Domain", col: "parent_id" },
      resolvedAddress: { ref: "Account", col: "resolvedAddress_id" },
      owner: { ref: "Account", col: "owner_id" },
      registrant: { ref: "Account", col: "registrant_id" },
      wrappedOwner: { ref: "Account", col: "wrappedOwner_id" },
      resolver: { ref: "Resolver", col: "resolver_id" },
      subdomains: { rev: "Domain", via: "parent_id" },
      registration: { rev: "Registration", via: "domain_id", single: true },
      wrappedDomain: { rev: "WrappedDomain", via: "domain_id", single: true },
    },
  },
  Account: {
    table: "subgraph_account", plural: "accounts",
    fields: {
      id: { t: "ID", col: "id" },
      domains: { rev: "Domain", via: "owner_id" },
      wrappedDomains: { rev: "WrappedDomain", via: "owner_id" },
      registrations: { rev: "Registration", via: "registrant_id" },
    },
  },
  Registration: {
    table: "ens_unified_registration", plural: "registrations",
    fields: {
      id: { t: "ID", col: "id" }, registrationDate: { t: "BigInt" }, expiryDate: { t: "BigInt" }, cost: { t: "BigInt" }, labelName: { t: "String" },
      domain: { ref: "Domain", col: "domain_id" }, registrant: { ref: "Account", col: "registrant_id" },
    },
  },
  WrappedDomain: {
    table: "subgraph_wrapped_domain", plural: "wrappedDomains",
    fields: {
      id: { t: "ID", col: "id" }, expiryDate: { t: "BigInt" }, fuses: { t: "Int" }, name: { t: "String" },
      domain: { ref: "Domain", col: "domain_id" }, owner: { ref: "Account", col: "owner_id" },
    },
  },
  Resolver: {
    table: "subgraph_resolver", plural: "resolvers", chainPrefixed: true,
    fields: {
      id: { t: "ID", col: "id" }, address: { t: "Bytes" }, contentHash: { t: "Bytes" },
      texts: { list: "String" }, coinTypes: { list: "BigInt" },
      domain: { ref: "Domain", col: "domain_id" }, addr: { ref: "Account", col: "addr_id" },
    },
  },
};

const col = (name) => `"${name.replace(/"/g, "")}"`;
const OPS = { "": "=", _not: "<>", _gt: ">", _lt: "<", _gte: ">=", _lte: "<=" };
const SUFFIXES = ["_not_in", "_in", "_not_starts_with_nocase", "_starts_with_nocase", "_not_ends_with_nocase", "_ends_with_nocase", "_not_contains_nocase", "_contains_nocase", "_not_starts_with", "_starts_with", "_not_ends_with", "_ends_with", "_not_contains", "_contains", "_nocase", "_gte", "_lte", "_gt", "_lt", "_not"];
const STRING_SUFFIXES = SUFFIXES.filter((s) => /starts|ends|contains|nocase/.test(s));
const likeEscape = (v) => String(v).replace(/[\\%_]/g, "\\$&");

function columnOf(entity, field) {
  const f = ENTITIES[entity].fields[field];
  if (!f || f.rev || f.list) throw new GraphQLError(`cannot filter ${entity} by ${field}`);
  return f.col ?? field;
}

function compileWhere(entity, where, values) {
  const parts = [];
  for (const [key, raw] of Object.entries(where ?? {})) {
    if (key === "and" || key === "or") {
      const subs = raw.map((w) => compileWhere(entity, w, values)).filter(Boolean).map((s) => `(${s})`);
      if (subs.length) parts.push(`(${subs.join(key === "and" ? " AND " : " OR ")})`);
      continue;
    }
    const suffix = SUFFIXES.find((s) => key.endsWith(s) && ENTITIES[entity].fields[key.slice(0, -s.length)]) ?? "";
    const field = key.slice(0, key.length - suffix.length);
    let c = col(columnOf(entity, field));
    let value = raw;
    if (field === "id" && ENTITIES[entity].chainPrefixed) {
      c = `substring(${c} from position('-' in ${c}) + 1)`;
    }
    const ref = ENTITIES[entity].fields[field].ref;
    if (ref && ENTITIES[ref].chainPrefixed && typeof value === "string") value = `__CHAIN__-${value}`;
    if (suffix === "_in" || suffix === "_not_in") {
      values.push(raw.map((v) => (ref && ENTITIES[ref].chainPrefixed ? `__CHAIN__-${v}` : String(v))));
      parts.push(`${suffix === "_not_in" ? "NOT " : ""}${c} = ANY($${values.length})`);
    } else if (/contains|starts|ends|nocase/.test(suffix)) {
      const nocase = suffix.includes("nocase");
      const neg = suffix.includes("_not_");
      const body = likeEscape(raw);
      values.push(suffix.includes("contains") ? `%${body}%` : suffix.includes("starts") ? `${body}%` : suffix.includes("ends") ? `%${body}` : body);
      parts.push(`${c} ${neg ? "NOT " : ""}${nocase ? "ILIKE" : "LIKE"} $${values.length}`);
    } else {
      values.push(String(value));
      parts.push(`${c} ${OPS[suffix]} $${values.length}`);
    }
  }
  return parts.join(" AND ");
}

function withChain(sql, values, chainId) {
  const bind = (v) => (typeof v === "string" ? v.replace("__CHAIN__", String(chainId)) : Array.isArray(v) ? v.map(bind) : v);
  return { sql, values: values.map(bind) };
}

class Loaders {
  constructor(chainId) {
    this.chainId = chainId;
    this.pending = new Map();
  }
  load(entity, column, key) {
    const k = `${entity}|${column}`;
    let batch = this.pending.get(k);
    if (!batch) {
      batch = { keys: new Map() };
      this.pending.set(k, batch);
      queueMicrotask(() => this.flush(k, entity, column, batch));
    }
    let entry = batch.keys.get(key);
    if (!entry) {
      entry = {};
      entry.promise = new Promise((resolve, reject) => { entry.resolve = resolve; entry.reject = reject; });
      batch.keys.set(key, entry);
    }
    return entry.promise;
  }
  async flush(k, entity, column, batch) {
    this.pending.delete(k);
    try {
      const keys = [...batch.keys.keys()];
      const rows = await q(`SELECT * FROM ${col(ENTITIES[entity].table)} WHERE ${col(column)} = ANY($1) AND "chainId" = $2 LIMIT 5000`, [keys, this.chainId]);
      const grouped = new Map();
      for (const row of rows) {
        const key = row[column];
        if (!grouped.has(key)) grouped.set(key, []);
        grouped.get(key).push(row);
      }
      for (const [key, entry] of batch.keys) entry.resolve(grouped.get(key) ?? []);
    } catch (err) {
      for (const entry of batch.keys.values()) entry.reject(err);
    }
  }
}

const objectTypes = {};
const whereTypes = {};
const orderEnums = {};

function makeWhere(entity) {
  if (whereTypes[entity]) return whereTypes[entity];
  const self = new GraphQLInputObjectType({
    name: `${entity}_filter`,
    fields: () => {
      const out = { and: { type: new GraphQLList(self) }, or: { type: new GraphQLList(self) } };
      for (const [name, f] of Object.entries(ENTITIES[entity].fields)) {
        if (f.rev || f.list) continue;
        const base = f.ref ? GraphQLString : SCALARS[f.t];
        const isText = f.ref || ["String", "Bytes", "ID"].includes(f.t);
        out[name] = { type: base };
        for (const s of ["_not", "_gt", "_lt", "_gte", "_lte"]) out[name + s] = { type: base };
        out[`${name}_in`] = { type: new GraphQLList(new GraphQLNonNull(base)) };
        out[`${name}_not_in`] = { type: new GraphQLList(new GraphQLNonNull(base)) };
        if (isText) for (const s of STRING_SUFFIXES) out[name + s] = { type: GraphQLString };
      }
      return out;
    },
  });
  whereTypes[entity] = self;
  return self;
}

function makeOrder(entity) {
  if (orderEnums[entity]) return orderEnums[entity];
  const values = {};
  for (const [name, f] of Object.entries(ENTITIES[entity].fields)) if (!f.rev && !f.list) values[name] = { value: name };
  return (orderEnums[entity] = new GraphQLEnumType({ name: `${entity}_orderBy`, values }));
}

const OrderDirection = new GraphQLEnumType({ name: "OrderDirection", values: { asc: { value: "asc" }, desc: { value: "desc" } } });

const listArgs = (entity) => ({
  first: { type: GraphQLInt, defaultValue: 100 },
  skip: { type: GraphQLInt, defaultValue: 0 },
  orderBy: { type: makeOrder(entity) },
  orderDirection: { type: OrderDirection, defaultValue: "asc" },
  where: { type: makeWhere(entity) },
});

function listSql(entity, args, chainId, extra) {
  const values = [chainId];
  const conds = [`"chainId" = $1`];
  if (extra) { values.push(extra.value); conds.push(`${col(extra.column)} = $${values.length}`); }
  const w = compileWhere(entity, args.where, values);
  if (w) conds.push(w);
  const first = Math.min(args.first ?? 100, 1000);
  if (first < 0) throw new GraphQLError("first must be >= 0");
  const skip = Math.min(args.skip ?? 0, 5000);
  const orderField = args.orderBy ?? "id";
  const order = `${col(columnOf(entity, orderField))} ${args.orderDirection === "desc" ? "DESC" : "ASC"} NULLS LAST`;
  const tiebreak = orderField === "id" ? "" : `, ${col("id")} ASC`;
  const sql = `SELECT * FROM ${col(ENTITIES[entity].table)} WHERE ${conds.join(" AND ")} ORDER BY ${order}${tiebreak} LIMIT ${first} OFFSET ${skip}`;
  return withChain(sql, values, chainId);
}

const stripChain = (chainId, id) => (id == null ? id : String(id).replace(new RegExp(`^${chainId}-`), ""));

function makeObject(entity) {
  if (objectTypes[entity]) return objectTypes[entity];
  const cfg = ENTITIES[entity];
  const type = new GraphQLObjectType({
    name: entity,
    fields: () => {
      const out = {};
      for (const [name, f] of Object.entries(cfg.fields)) {
        if (f.t) {
          const type2 = name === "id" ? new GraphQLNonNull(GraphQLID) : SCALARS[f.t];
          out[name] = {
            type: type2,
            resolve: (row, _a, ctx) => (name === "id" && cfg.chainPrefixed ? stripChain(ctx.chainId, row.id) : row[f.col ?? name]),
          };
        } else if (f.list) {
          out[name] = { type: new GraphQLList(new GraphQLNonNull(SCALARS[f.list])), resolve: (row) => row[name] };
        } else if (f.ref) {
          out[name] = {
            type: makeObject(f.ref),
            resolve: async (row, _a, ctx) => {
              const key = row[f.col];
              if (key == null) return null;
              const rows = await ctx.loaders.load(f.ref, "id", key);
              if (rows.length) return rows[0];
              // An owner with no account row is still an address.
              return f.ref === "Account" ? { id: key } : null;
            },
          };
        } else if (f.single) {
          out[name] = {
            type: makeObject(f.rev),
            resolve: async (row, _a, ctx) => (await ctx.loaders.load(f.rev, f.via, row.id))[0] ?? null,
          };
        } else {
          out[name] = {
            type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(makeObject(f.rev)))),
            args: listArgs(f.rev),
            resolve: async (row, args, ctx) => {
              const { sql, values } = listSql(f.rev, args, ctx.chainId, { column: f.via, value: row.id });
              return q(sql, values);
            },
          };
        }
      }
      return out;
    },
  });
  return (objectTypes[entity] = type);
}

const MetaBlock = new GraphQLObjectType({ name: "_Block_", fields: { number: { type: new GraphQLNonNull(GraphQLInt) }, timestamp: { type: GraphQLInt }, hash: { type: BytesScalar } } });
const Meta = new GraphQLObjectType({ name: "_Meta_", fields: { block: { type: new GraphQLNonNull(MetaBlock) }, deployment: { type: new GraphQLNonNull(GraphQLString) }, hasIndexingErrors: { type: new GraphQLNonNull(GraphQLBoolean) } } });
const BlockHeight = new GraphQLInputObjectType({ name: "Block_height", fields: { number: { type: GraphQLInt }, hash: { type: BytesScalar }, number_gte: { type: GraphQLInt } } });

function queryFields() {
  const out = {
    _meta: {
      type: Meta,
      args: { block: { type: BlockHeight } },
      resolve: async (_s, _a, ctx) => {
        const [row] = await q(`SELECT progress_block, progress_block_time FROM envio_chains WHERE id = $1`, [ctx.chainId]);
        if (!row) throw new GraphQLError(`chain ${ctx.chainId} is not indexed`);
        return { block: { number: row.progress_block, timestamp: row.progress_block_time ? Math.floor(new Date(row.progress_block_time).getTime() / 1000) : null, hash: null }, deployment: `ens-indexer-${ctx.chainId}`, hasIndexingErrors: false };
      },
    },
  };
  for (const [entity, cfg] of Object.entries(ENTITIES)) {
    const singular = entity[0].toLowerCase() + entity.slice(1);
    const rejectTimeTravel = (args) => { if (args.block) throw new GraphQLError("querying at a past block is not supported"); };
    out[singular] = {
      type: makeObject(entity),
      args: { id: { type: new GraphQLNonNull(GraphQLID) }, block: { type: BlockHeight } },
      resolve: async (_s, args, ctx) => {
        rejectTimeTravel(args);
        const id = cfg.chainPrefixed ? `${ctx.chainId}-${args.id}` : args.id;
        const rows = await q(`SELECT * FROM ${col(cfg.table)} WHERE id = $1 AND "chainId" = $2`, [id, ctx.chainId]);
        return rows[0] ?? (entity === "Account" ? { id: args.id } : null);
      },
    };
    out[cfg.plural] = {
      type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(makeObject(entity)))),
      args: { ...listArgs(entity), block: { type: BlockHeight } },
      resolve: async (_s, args, ctx) => {
        rejectTimeTravel(args);
        const { sql, values } = listSql(entity, args, ctx.chainId);
        return q(sql, values);
      },
    };
  }
  return out;
}

export const schema = new GraphQLSchema({ query: new GraphQLObjectType({ name: "Query", fields: queryFields }) });
export const makeContext = (chainId) => ({ chainId, loaders: new Loaders(chainId) });
export { listSql };
