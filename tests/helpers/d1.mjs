import {readFile} from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';

export class SqliteD1 {
  constructor(database) { this.database = database; }
  prepare(sql) { return new SqliteStatement(this.database, sql); }
  batch(statements) {
    this.database.exec('BEGIN');
    try {
      const results = statements.map(statement => /^\s*(SELECT|PRAGMA)/i.test(statement.sql) ? statement.all() : statement.run());
      this.database.exec('COMMIT');
      return results;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }
}

class SqliteStatement {
  constructor(database, sql) { this.database = database; this.sql = sql; this.values = []; }
  bind(...values) { this.values = values; return this; }
  all() { return {results: this.database.prepare(this.sql).all(...this.values)}; }
  first() { return this.database.prepare(this.sql).get(...this.values) ?? null; }
  run() {
    const result = this.database.prepare(this.sql).run(...this.values);
    return {meta: {changes: Number(result.changes)}};
  }
}

export async function createTestD1() {
  const database = new DatabaseSync(':memory:');
  const schema = await readFile(new URL('../../cloud/migrations/0001_initial.sql', import.meta.url), 'utf8');
  database.exec(schema);
  return {database, binding: new SqliteD1(database)};
}
