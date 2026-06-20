#!/bin/sh
set -eu

# Run database migrations before the default server start when explicitly enabled.
# Keep this disabled for scaled deployments and run one one-shot migration job per release instead.
if [ "${RUN_MIGRATIONS:-false}" = "true" ]; then
  echo "Running database migrations before application start..."
  npm run migrate
fi

exec "$@"
