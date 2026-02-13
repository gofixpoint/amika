#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 1 ]; then
    echo "Usage: copy-repo.sh <source-directory>" >&2
    exit 1
fi

srcdir="$1"

if [ ! -d "$srcdir" ]; then
    echo "Error: '$srcdir' is not a directory" >&2
    exit 1
fi

cp -r "$srcdir"/. .
