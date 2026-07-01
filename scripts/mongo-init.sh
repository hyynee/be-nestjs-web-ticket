#!/bin/bash
# Initialize MongoDB replica set and create admin user for local development.
# Runs inside mongo1 container on first startup via docker-entrypoint-initdb.d.
#
# Flow:
#   1. Wait for mongod to accept connections
#   2. If replica set already initialized → skip RS init, ensure admin user exists
#   3. Initiate replica set with 2 data nodes + 1 arbiter
#   4. Wait for primary election
#   5. Create admin user (localhost exception applies before first user is created)
#
# Credentials are read from MONGO_ADMIN_USER / MONGO_ADMIN_PASS env vars
# (set in docker-compose.yml, defaults: admin / devMongoPass123).

set -e

MONGO_HOST="mongo1"
MONGO_PORT="27017"
REPLICA_SET="rs0"
ADMIN_USER="${MONGO_ADMIN_USER:-admin}"
ADMIN_PASS="${MONGO_ADMIN_PASS:-devMongoPass123}"

echo "[mongo-init] Waiting for MongoDB to accept connections..."
until mongosh --quiet --eval "db.adminCommand('ping')" &>/dev/null; do
  sleep 2
done

echo "[mongo-init] Checking replica set status..."
RS_STATUS=$(mongosh --quiet --eval "
  try {
    const s = rs.status();
    print(s.ok);
  } catch(e) {
    print(0);
  }
" 2>/dev/null || echo "0")

if [ "$RS_STATUS" = "1" ]; then
  echo "[mongo-init] Replica set already initialized — ensuring admin user exists..."
  # Attempt to create admin user; ignore error if it already exists (code 51003)
  mongosh --quiet admin --eval "
    try {
      db.createUser({
        user: '${ADMIN_USER}',
        pwd:  '${ADMIN_PASS}',
        roles: [{ role: 'root', db: 'admin' }]
      });
      print('[mongo-init] Admin user created.');
    } catch(e) {
      if (e.code === 51003 || String(e).includes('already exists')) {
        print('[mongo-init] Admin user already exists — OK.');
      } else {
        throw e;
      }
    }
  " 2>/dev/null || true
  exit 0
fi

echo "[mongo-init] Initiating replica set ${REPLICA_SET} with arbiter..."
mongosh --quiet --eval "
  rs.initiate({
    _id: '${REPLICA_SET}',
    members: [
      { _id: 0, host: 'mongo1:${MONGO_PORT}', priority: 2 },
      { _id: 1, host: 'mongo2:${MONGO_PORT}', priority: 1 },
      { _id: 2, host: 'mongo-arbiter:${MONGO_PORT}', arbiterOnly: true },
    ]
  });
"

echo "[mongo-init] Waiting for primary election..."
until mongosh --quiet --eval "
  const status = rs.status();
  const primary = status.members.find(m => m.stateStr === 'PRIMARY');
  if (!primary) { throw new Error('no primary yet'); }
  print('PRIMARY: ' + primary.name);
" &>/dev/null; do
  sleep 2
done

echo "[mongo-init] Creating admin user '${ADMIN_USER}'..."
mongosh --quiet admin --eval "
  db.createUser({
    user: '${ADMIN_USER}',
    pwd:  '${ADMIN_PASS}',
    roles: [{ role: 'root', db: 'admin' }]
  });
  print('[mongo-init] Admin user created successfully.');
"

echo "[mongo-init] Replica set ${REPLICA_SET} is ready with authentication enabled."
