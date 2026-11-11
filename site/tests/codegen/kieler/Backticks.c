/*
 * Automatically generated C code by
 * KIELER SCCharts - The Key to Efficient Modeling
 *
 * http://rtsys.informatik.uni-kiel.de/kieler
 */

#include "Backticks.h"

void logic(TickData* d) {
  if (!d->_GO) {
    d->x = 42;;
    d->y = 7 * 6;
  }
}

void reset(TickData* d) {
  d->_GO = 1;
  d->_TERM = 0;
  d->x = 0;
  d->y = 0;
}

void tick(TickData* d) {
  logic(d);

  d->_GO = 0;
}
