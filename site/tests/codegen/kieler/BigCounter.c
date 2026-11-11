/*
 * Automatically generated C code by
 * KIELER SCCharts - The Key to Efficient Modeling
 *
 * http://rtsys.informatik.uni-kiel.de/kieler
 */

typedef long long int64;

#include "BigCounter.h"

void logic(TickData* d) {
  if (!d->_GO) {
    d->big += 1;
    d->low = (int) (d->big & 0xFF);
  }
}

void reset(TickData* d) {
  d->_GO = 1;
  d->_TERM = 0;
  d->low = 0;
  d->big = 1LL << 40;
}

void tick(TickData* d) {
  logic(d);

  d->_GO = 0;
}
