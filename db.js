import pg from "pg";
const { Pool } = pg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 10000, // give up trying to connect after 10s
  statement_timeout: 20000, // give up on any single query after 20s
  query_timeout: 20000,
  idle_in_transaction_session_timeout: 20000,
});

// CRITICAL: without this, any transient error on an idle pooled connection
// (network blip, DB restart, idle timeout) crashes the entire Node process.
pool.on("error", (err) => {
  console.error("Unexpected error on idle PG client (handled, not crashing):", err.message);
});

export async function query(text, params) {
  const res = await pool.query(text, params);
  return res.rows;
}
