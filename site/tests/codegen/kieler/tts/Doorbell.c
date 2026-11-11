/*
 * Automatically generated C code by
 * KIELER SCCharts - The Key to Efficient Modeling
 *
 * http://rtsys.informatik.uni-kiel.de/kieler
 */

#include "Doorbell.h"

void logic(TickData* d) {
  d->chime = 0;
  d->rings = 0;
  d->_g3 = d->_pg4;
  d->_g4 = d->_g3 && d->button;
  if (d->_g4) {
    d->count++;
    d->chime |= 1;
    d->rings_curval = d->count;
    d->rings |= 1;
    d->_taken_transitions[0] += 1;
  }
  d->_g4 = d->_GO || d->_g4 || (d->_g3 && !d->button);
  d->_g3 = d->_pg13;
  d->_g15 = d->_pg11;
  d->_g15 = d->_GO || d->_g3 || d->_g15;
  d->_cg11 = d->rings;
  d->_g13 = d->_g15 && d->_cg11;
  if (d->_g13) {
    d->rings_val = d->rings_curval;
  }
  d->_g11 = d->_g15 && !d->_cg11;
}

void reset(TickData* d) {
  d->_GO = 1;
  d->_TERM = 0;
  d->count = 0;
  d->chime = 0;
  d->rings_val = 0;
  d->rings_curval = 0;
  d->rings = 0;
  d->_taken_transitions[0] = 0;
  d->_pg4 = 0;
  d->_pg13 = 0;
  d->_pg11 = 0;
}

void tick(TickData* d) {
  logic(d);

  d->_pg4 = d->_g4;
  d->_pg13 = d->_g13;
  d->_pg11 = d->_g11;
  d->_GO = 0;
}
