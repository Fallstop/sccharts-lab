/*
 * Automatically generated C code by
 * KIELER SCCharts - The Key to Efficient Modeling
 *
 * http://rtsys.informatik.uni-kiel.de/kieler
 */

#include "Delays.h"

void logic(TickData* d) {
  d->now = d->level;
  if (!d->_GO) {
    d->_Delays_local___iop_0 = d->level;
  }
  d->start = d->_Delays_local___iop_0;
  if (!d->_GO) {
    d->_Delays_local___fbp_0 = d->_Delays_local___fbp_next0;
  }
  d->late = d->_Delays_local___fbp_0;
  d->_pre_level = d->_reg_level;
  d->_reg_level = d->level;
  d->before = d->_pre_level;
  d->_Delays_local___fbp_next0 = d->level;
}

void reset(TickData* d) {
  d->_GO = 1;
  d->_TERM = 0;
  d->now = 0;
  d->start = 0;
  d->late = 0;
  d->before = 0;
  d->_reg_level = 0;
  d->_Delays_local___iop_0 = 100;
  d->_Delays_local___fbp_0 = 100;
}

void tick(TickData* d) {
  logic(d);

  d->_GO = 0;
}
