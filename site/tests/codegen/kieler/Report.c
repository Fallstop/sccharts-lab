/*
 * Automatically generated C code by
 * KIELER SCCharts - The Key to Efficient Modeling
 *
 * http://rtsys.informatik.uni-kiel.de/kieler
 */

#include <stdio.h>

#include "Report.h"

void logic(TickData* d) {
  if (!d->_GO) {
    printf("%s %d", "level is", d->level);
    d->reports++;
  }
}

void reset(TickData* d) {
  d->_GO = 1;
  d->_TERM = 0;
  d->reports = 0;
}

void tick(TickData* d) {
  logic(d);

  d->_GO = 0;
}
