/*
 * Automatically generated C code by
 * KIELER SCCharts - The Key to Efficient Modeling
 *
 * http://rtsys.informatik.uni-kiel.de/kieler
 */

#include <stdio.h>

#include "Tick1Print.h"

void logic(TickData* d) {
  if (d->_GO) {
    d->a = d->k + 1;
  }
}

void reset(TickData* d) {
  d->_GO = 1;
  d->_TERM = 0;
  d->k = 3;
  d->a = 1;
  printf("%s %d", "start", d->a);
}

void tick(TickData* d) {
  logic(d);

  d->_GO = 0;
}
