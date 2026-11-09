#!/usr/bin/env bash
# Compatibility entry point; Node owns parsing and host decisions.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node "$SCRIPT_DIR/check_plan_approved.mjs"
