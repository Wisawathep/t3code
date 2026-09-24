import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;

  // Idempotent so a later upstream migration sharing this ID cannot fail on
  // databases that already ran the fork's version.
  if (!columns.some((column) => column.name === "pinned_messages_json")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN pinned_messages_json TEXT
    `;
  }
});
