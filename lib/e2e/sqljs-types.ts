// Ambient types. sql.js ships none, and a module augmentation is rejected because the
// package resolves to untyped JavaScript. This file stays a script on purpose.
declare module "sql.js" {
  export type SqlValue = string | number | Uint8Array | null;

  export interface Statement {
    bind(values?: SqlValue[]): boolean;
    step(): boolean;
    getAsObject(): Record<string, SqlValue>;
    free(): boolean;
  }

  export interface QueryExecResult {
    columns: string[];
    values: SqlValue[][];
  }

  export interface Database {
    run(sql: string, params?: SqlValue[]): Database;
    exec(sql: string): QueryExecResult[];
    prepare(sql: string): Statement;
    getRowsModified(): number;
    close(): void;
  }

  export interface SqlJsStatic {
    Database: new () => Database;
  }

  export default function initSqlJs(config?: { wasmBinary?: ArrayBuffer | Uint8Array }): Promise<SqlJsStatic>;
}
