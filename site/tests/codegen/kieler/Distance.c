/*
 * Automatically generated C code by
 * KIELER SCCharts - The Key to Efficient Modeling
 *
 * http://rtsys.informatik.uni-kiel.de/kieler
 */

#include <stdlib.h>

#include "Distance.h"

void logic(TickData* d) {
  if (!d->_GO) {
    d->distance = abs(d->position);
  }
}

void reset(TickData* d) {
  d->_GO = 1;
  d->_TERM = 0;
  d->distance = 0;
}

void tick(TickData* d) {
  logic(d);

  d->_GO = 0;
}
