/*
 * Automatically generated C code by
 * KIELER SCCharts - The Key to Efficient Modeling
 *
 * http://rtsys.informatik.uni-kiel.de/kieler
 */

#include "StrongCancel.h"

void logic(TickData* d) {
  d->_g4 = d->_pg5;
  d->_g2 = d->_pg1;
  d->_g1 = d->_GO || (d->_g4 && d->cancel) || (d->_g2 && !d->start);
  d->_g4 = d->_g4 && !d->cancel;
  d->_g6 = d->_g4 && d->sheet;
  if (d->_g6) {
    d->printed++;
  }
  d->_g5 = (d->_g2 && d->start) || d->_g6 || (d->_g4 && !d->sheet);
}

void reset(TickData* d) {
  d->_GO = 1;
  d->_TERM = 0;
  d->printed = 0;
  d->_pg5 = 0;
  d->_pg1 = 0;
}

void tick(TickData* d) {
  logic(d);

  d->_pg5 = d->_g5;
  d->_pg1 = d->_g1;
  d->_GO = 0;
}
