#!/usr/bin/env python3
"""
Byte-for-byte comparison of the subgraph_* tables between:
  - the ENSIndexer reference implementation (Ponder/ENSDb), and
  - the Envio HyperIndex implementation.

Both databases run in local docker containers; rows are dumped with
`COPY ... TO STDOUT WITH CSV` ordered by id and compared cell-by-cell over the
intersection of columns (extra columns on either side are reported once).

Usage:
  python3 scripts/compare-ensdb.py [--ref-schema ensindexer_370k] [--limit-diffs 20]
"""

import argparse
import csv
import io
import subprocess
import sys

REF = dict(container="ens-ref-pg", user="postgres", db="ensref")
ENV = dict(container="envio-postgres", user="postgres", db="envio-dev", schema="public")

# Envio-internal column, not part of the data model
IGNORED_ENVIO_COLUMNS = {"db_write_timestamp"}

SUBGRAPH_TABLES = [
    "subgraph_accounts",
    "subgraph_domains",
    "subgraph_resolvers",
    "subgraph_registrations",
    "subgraph_wrapped_domains",
    "subgraph_transfers",
    "subgraph_new_owners",
    "subgraph_new_resolvers",
    "subgraph_new_ttls",
    "subgraph_wrapped_transfers",
    "subgraph_name_wrapped",
    "subgraph_name_unwrapped",
    "subgraph_fuses_set",
    "subgraph_expiry_extended",
    "subgraph_name_registered",
    "subgraph_name_renewed",
    "subgraph_name_transferred",
    "subgraph_addr_changed",
    "subgraph_multicoin_addr_changed",
    "subgraph_name_changed",
    "subgraph_abi_changed",
    "subgraph_pubkey_changed",
    "subgraph_text_changed",
    "subgraph_contenthash_changed",
    "subgraph_interface_changed",
    "subgraph_authorisation_changed",
    "subgraph_version_changed",
]


def psql(side, schema, sql):
    cmd = [
        "docker", "exec", "-i", side["container"],
        "psql", "-U", side["user"], "-d", side["db"], "-v", "ON_ERROR_STOP=1",
        "-tAc", sql,
    ]
    out = subprocess.run(cmd, capture_output=True, text=True)
    if out.returncode != 0:
        raise RuntimeError(f"psql failed on {side['container']}: {out.stderr}")
    return out.stdout


def columns(side, schema, table):
    sql = (
        "select column_name, data_type from information_schema.columns "
        f"where table_schema='{schema}' and table_name='{table}' order by column_name"
    )
    rows = [l.split("|") for l in psql(side, schema, sql).splitlines() if l]
    return {name: dtype for name, dtype in rows}


def dump(side, schema, table, cols):
    collist = ", ".join(f'"{c}"' for c in cols)
    sql = f"COPY (select {collist} from {schema}.{table} order by id) TO STDOUT WITH CSV"
    cmd = [
        "docker", "exec", "-i", side["container"],
        "psql", "-U", side["user"], "-d", side["db"], "-v", "ON_ERROR_STOP=1", "-c", sql,
    ]
    out = subprocess.run(cmd, capture_output=True, text=True)
    if out.returncode != 0:
        raise RuntimeError(f"COPY failed on {side['container']}.{table}: {out.stderr}")
    return list(csv.reader(io.StringIO(out.stdout)))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ref-schema", default="ensindexer_370k")
    ap.add_argument("--limit-diffs", type=int, default=20)
    args = ap.parse_args()

    ref_schema = args.ref_schema
    env_schema = ENV["schema"]

    total_tables_ok = 0
    total_tables_diff = 0
    summary = []

    for table in SUBGRAPH_TABLES:
        ref_cols = columns(REF, ref_schema, table)
        env_cols = columns(ENV, env_schema, table)
        env_cols = {c: t for c, t in env_cols.items() if c not in IGNORED_ENVIO_COLUMNS}

        if not ref_cols:
            summary.append((table, "MISSING IN REFERENCE"))
            total_tables_diff += 1
            continue
        if not env_cols:
            summary.append((table, "MISSING IN ENVIO"))
            total_tables_diff += 1
            continue

        problems = []

        only_ref = sorted(set(ref_cols) - set(env_cols))
        only_env = sorted(set(env_cols) - set(ref_cols))
        if only_ref:
            problems.append(f"columns only in reference: {only_ref}")
        if only_env:
            problems.append(f"columns only in envio: {only_env}")

        shared = sorted(set(ref_cols) & set(env_cols))
        # id first for readability
        if "id" in shared:
            shared.remove("id")
            shared.insert(0, "id")

        ref_rows = dump(REF, ref_schema, table, shared)
        env_rows = dump(ENV, env_schema, table, shared)

        if len(ref_rows) != len(env_rows):
            problems.append(f"row count: reference={len(ref_rows)} envio={len(env_rows)}")

        ref_by_id = {r[0]: r for r in ref_rows}
        env_by_id = {r[0]: r for r in env_rows}

        missing_in_env = [i for i in ref_by_id if i not in env_by_id]
        missing_in_ref = [i for i in env_by_id if i not in ref_by_id]
        if missing_in_env:
            problems.append(
                f"{len(missing_in_env)} ids only in reference (first: {missing_in_env[:5]})"
            )
        if missing_in_ref:
            problems.append(
                f"{len(missing_in_ref)} ids only in envio (first: {missing_in_ref[:5]})"
            )

        cell_diffs = []
        for rid, rrow in ref_by_id.items():
            erow = env_by_id.get(rid)
            if erow is None or rrow == erow:
                continue
            for col, rv, ev in zip(shared, rrow, erow):
                if rv != ev:
                    cell_diffs.append((rid, col, rv, ev))

        if cell_diffs:
            problems.append(f"{len(cell_diffs)} differing cells")

        if problems:
            total_tables_diff += 1
            print(f"\n✗ {table}")
            for p in problems:
                print(f"    {p}")
            for rid, col, rv, ev in cell_diffs[: args.limit_diffs]:
                print(f"    id={rid} col={col}\n      ref:   {rv!r}\n      envio: {ev!r}")
            if len(cell_diffs) > args.limit_diffs:
                print(f"    ... and {len(cell_diffs) - args.limit_diffs} more cell diffs")
            summary.append((table, "DIFFS"))
        else:
            total_tables_ok += 1
            print(f"✓ {table} ({len(ref_rows)} rows, {len(shared)} columns)")
            summary.append((table, f"OK ({len(ref_rows)} rows)"))

    print("\n" + "=" * 60)
    print(f"RESULT: {total_tables_ok} tables byte-identical, {total_tables_diff} with differences")
    sys.exit(1 if total_tables_diff else 0)


if __name__ == "__main__":
    main()
