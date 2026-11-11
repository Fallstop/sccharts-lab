/*
 * Automatically generated C code by
 * KIELER SCCharts - The Key to Efficient Modeling
 *
 * http://rtsys.informatik.uni-kiel.de/kieler
 */

#include <stdio.h>

#include "FloatLit.h"

void logic(TickData* d) {
  if (!d->_GO) {
    d->y = d->x * 0.30000001192092896 + 150.0;
    d->n = (int)(d->y + d->k);
    printf("%X %f %d", (d->n + 1), d->x, d->k);
  }
}

void reset(TickData* d) {
  d->_GO = 1;
  d->_TERM = 0;
  d->x = 0.10000000149011612;
  d->y = 0.0;
  d->n = 0;
}

void tick(TickData* d) {
  logic(d);

  d->_GO = 0;
}
