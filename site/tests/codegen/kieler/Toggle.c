/*
 * Automatically generated C code by
 * KIELER SCCharts - The Key to Efficient Modeling
 *
 * http://rtsys.informatik.uni-kiel.de/kieler
 */

#include "Toggle.h"

void logic(TickData* d) {
  d->_g5 = d->_pg5;
  d->_g6 = d->_g5 && d->button;
  if (d->_g6) {
    d->light = 0;
  }
  d->_g2 = d->_pg6;
  d->_g6 = d->_GO || d->_g6 || (d->_g2 && !d->button);
  d->_g2 = d->_g2 && d->button;
  if (d->_g2) {
    d->light = 1;
  }
  d->_g5 = d->_g2 || (d->_g5 && !d->button);
}

void reset(TickData* d) {
  d->_GO = 1;
  d->_TERM = 0;
  d->light = 0;
  d->_pg5 = 0;
  d->_pg6 = 0;
}

void tick(TickData* d) {
  logic(d);

  d->_pg5 = d->_g5;
  d->_pg6 = d->_g6;
  d->_GO = 0;
}
