#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")" && pwd)"
cd "$repo_root"

test -f package.json
test -f packages/db/prisma/schema.prisma

npm run db:generate
npm run db:validate
npm run db:test:prepare
npm run test:backend
npm run test:providers
npm run test:worker
npm run lint:web
npm run typecheck:web
npm run typecheck:providers
npm run typecheck:worker
npm run check:offline
npm run qa:work7:static
npm run build:web
