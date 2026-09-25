import type { Row } from "./client.js";
import { cellKey } from "./rows.js";

export interface Group {
  values: string[];
  count: number;
}

/** Counts rows grouped by up to three fields. Blank cells group as "(blank)". */
export class GroupCounter {
  private readonly counts = new Map<string, Group>();
  total = 0;

  constructor(readonly fields: string[]) {}

  add(row: Row): void {
    this.total += 1;
    const values = this.fields.map((f) => cellKey(row[f]));
    const key = JSON.stringify(values);
    const group = this.counts.get(key);
    if (group) group.count += 1;
    else this.counts.set(key, { values, count: 1 });
  }

  addMany(rows: Iterable<Row>): void {
    for (const row of rows) this.add(row);
  }

  /** Largest group first; ties in field-value order. */
  groups(): Group[] {
    return [...this.counts.values()].sort((a, b) => b.count - a.count || a.values.join("\u0000").localeCompare(b.values.join("\u0000")));
  }
}
