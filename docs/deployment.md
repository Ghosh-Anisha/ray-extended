# Deployment notes

## Supported demo topology

The prototype uses `better-sqlite3` and is supported for the demo on one long-running Node.js server process with one persistent, writable disk volume. Do not run multiple replicas, serverless functions, or a cluster against separate local files. Vercel/serverless functions with per-instance or ephemeral `/tmp` files are not supported: each instance can see a different set of cases, rules, approvals, and events.

Mount a persistent volume at `/var/lib/ray` and set:

```sh
RAY_DB_PATH=/var/lib/ray/data/ray.db
```

The process user must be able to create `/var/lib/ray/data` and read/write the database and its SQLite `-wal`/`-shm` sidecars. Keep the volume attached across restarts and deploys. Back it up while the app is stopped or using a SQLite-aware backup. Do not place the file in the repository, a read-only image layer, or an instance-local temporary directory in production.

## Manual deployment

1. Provision one long-running Node server and mount its persistent disk at `/var/lib/ray`.
2. Before starting the app, create the directory and grant it to the service user (replace `ray` with that account):

   ```sh
   sudo mkdir -p /var/lib/ray/data
   sudo chown -R ray:ray /var/lib/ray
   ```

3. Set `RAY_DB_PATH=/var/lib/ray/data/ray.db` in the service environment. Keep the volume mount and environment value stable between restarts.
4. Install and build from the repository, then start the single Node server with `npm run start`. Check startup logs for errors, open the demo, and verify a saved rule/case remains after a restart.
5. Do not configure a second independent instance or a Vercel function deployment and expect its state to match this server.

At startup the instrumentation hook applies migrations and seeds the demo world if needed. A database-open error includes the configured path and permission/volume guidance. `RAY_DB_PATH` defaults locally to `./data/ray.db`; `.env.example` lists the setting. Do not point separate app instances at independent files and expect state to synchronize.

This is a deployment preparation note, not a deployed service or a production-readiness claim. No external deployment or database migration was performed in this pass.
