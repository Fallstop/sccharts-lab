#!/bin/sh
# Prints the model KIELER produces at any step of a compilation chain (e.g. the core SCChart that the
# extended features are rewritten into), to see exactly how a construct is implemented.
#
#   tools/oracle/dump/dump.sh chart.sctx de.cau.cs.kieler.sccharts.extended last|all|<processor-id>
#
# Compiles Dump.java on first use. Same Java and JAR defaults as the oracle.
J=${SCCHARTS_JAVA:-/mnt/home/fallstop/.minecraft/runtime/java-runtime-delta/linux/java-runtime-delta/bin/java}
JAR=${SCCHARTS_SERVER_JAR:-$(dirname "$0")/../../../../../kieler-server-fork/server/target/sccharts-lite-server.jar}
H=$(dirname "$0")
OUT=${TMPDIR:-/tmp}/sccharts-dump-classes
if [ ! -f "$OUT/Dump.class" ] || [ "$H/Dump.java" -nt "$OUT/Dump.class" ]; then
  mkdir -p "$OUT" && "$(dirname "$J")/javac" -cp "$JAR" -d "$OUT" "$H/Dump.java" || exit 1
fi
exec "$J" -Djava.awt.headless=true -cp "$OUT:$JAR" Dump "$@" 2>/dev/null
