// Re-exports the generated app-data DDL and the extra statements the client database needs.
export { LOCAL_DATA_TABLES, LOCAL_SCHEMA_SQL } from "./schema.generated.ts";

/** Foreign keys stay off. Routes only need the id column; encryption_mode is a server concern. */
export const LOCAL_USER_STUB_SQL = "CREATE TABLE IF NOT EXISTS user (id TEXT PRIMARY KEY);";
