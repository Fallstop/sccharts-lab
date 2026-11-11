/*
 * Automatically generated C code by
 * KIELER SCCharts - The Key to Efficient Modeling
 *
 * http://rtsys.informatik.uni-kiel.de/kieler
 */

static int clamp(int v, int lo, int hi) { return v < lo ? lo : (v > hi ? hi : v); }

#include "Gauge.h"

void logic(TickData* d) {
  if (!d->_GO) {
    d->needle = clamp(d->reading, 0, 100);
  }
}

void reset(TickData* d) {
  d->_GO = 1;
  d->_TERM = 0;
  d->needle = 0;
}

void tick(TickData* d) {
  logic(d);

  d->_GO = 0;
}
