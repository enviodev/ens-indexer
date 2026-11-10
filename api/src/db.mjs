import pg from "pg";
import { readFileSync } from "node:fs";

pg.types.setTypeParser(pg.types.builtins.NUMERIC, (v) => v);
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => v);

export const pool = new pg.Pool({
  host: process.env.ENVIO_PG_HOST ?? "localhost",
  port: Number(process.env.ENVIO_PG_PORT ?? 5433),
  user: process.env.ENVIO_PG_USER ?? "postgres",
  password: process.env.ENVIO_PG_PASSWORD ?? "testing",
  database: process.env.ENVIO_PG_DATABASE ?? "envio-dev",
  max: Number(process.env.API_PG_MAX ?? 10),
});

export async function applyViews() {
  await pool.query(readFileSync(new URL("./views.sql", import.meta.url), "utf8"));
}

export const q = async (text, values) => (await pool.query(text, values)).rows;
