/** Seed one sample client/project/environment so the UI and worker have something to work on. */
import { clients, createDb, environments, projects } from "./index";

const db = createDb();
const [client] = await db.insert(clients).values({ name: "Sample Client", slug: "sample-client" }).onConflictDoNothing().returning();
if (client) {
  const [project] = await db.insert(projects).values({ clientId: client.id, name: "Sample storefront", status: "active" }).returning();
  await db.insert(environments).values({ projectId: project!.id, name: "production", baseUrl: "https://example.com" });
  console.log(`seeded project ${project!.id}`);
} else {
  console.log("already seeded");
}
await db.$client.end();
