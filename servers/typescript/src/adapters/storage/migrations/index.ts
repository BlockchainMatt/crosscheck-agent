// Migrations registry. Adapters call `MIGRATIONS` to get the ordered
// list to apply at init time. Adding a new migration = appending it
// here in id order.

import { m0001_init } from "./0001_init.js";
import type { Migration } from "./types.js";

export const MIGRATIONS: readonly Migration[] = [m0001_init];
export type { Migration };
