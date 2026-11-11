/*
 * Automatically generated C code by
 * KIELER SCCharts - The Key to Efficient Modeling
 *
 * http://rtsys.informatik.uni-kiel.de/kieler
 */

#include <stdlib.h>

#include "Dice.h"

void logic(TickData* d) {
  if (!d->_GO) {
    d->r = ((float) rand() / RAND_MAX);
    d->face = (int)(d->r * 6 + 1);
  }
}

void reset(TickData* d) {
  d->_GO = 1;
  d->_TERM = 0;
  d->r = 0;
  d->face = 0;
}

void tick(TickData* d) {
  logic(d);

  d->_GO = 0;
}
