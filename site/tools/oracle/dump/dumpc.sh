#!/bin/sh
# KIELER's generated C code for charts (DumpC.java): the reference output of tests/codegen/kieler/.
#
#   tools/oracle/dump/dumpc.sh de.cau.cs.kieler.sccharts.netlist out/ chart1.sctx chart2.sctx ...
#
# One JVM for all charts; same Java and JAR defaults as the oracle. Check `pgrep -fa sccharts-lite-server` first.
J=${SCCHARTS_JAVA:-$(node -e "import(process.argv[1]).then(m => console.log(m.defaultJava()))" "$(cd "$(dirname "$0")/.." && pwd)/java.mjs")}
JAR=${SCCHARTS_SERVER_JAR:-$(dirname "$0")/../../../../../kieler-server-fork/server/target/sccharts-lite-server.jar}
H=$(dirname "$0")
OUT=${TMPDIR:-/tmp}/sccharts-dump-classes
if [ ! -f "$OUT/DumpC.class" ] || [ "$H/DumpC.java" -nt "$OUT/DumpC.class" ]; then
  mkdir -p "$OUT" && "$(dirname "$J")/javac" -cp "$JAR" -d "$OUT" "$H/DumpC.java" || exit 1
fi
exec "$J" -Xmx1500m -Djava.awt.headless=true -cp "$OUT:$JAR" DumpC "$@" 2>/dev/null
