/*
 * Automatically generated C code by
 * KIELER SCCharts - The Key to Efficient Modeling
 *
 * http://rtsys.informatik.uni-kiel.de/kieler
 */

#include "ABRO.h"

void logic(TickData* d) {
  d->_g5 = d->_pg6;
  d->_g6_e1 = !d->_g5;
  d->_g7 = d->_g5 && !d->R;
  d->_g5 = (d->_g5 && d->R) || (d->_g7 && d->A);
  d->_g10 = d->_pg7;
  d->_g11_e2 = !d->_g10;
  d->_g12 = d->_g10 && !d->R;
  d->_g10 = (d->_g10 && d->R) || (d->_g12 && d->B);
  d->_g11_e2 = (d->_g6_e1 || d->_g5) && (d->_g11_e2 || d->_g10) && (d->_g5 || d->_g10);
  d->_g11 = d->_pg13;
  d->_g6_e1 = d->_GO || (d->_g11_e2 && d->R) || (d->_g11 && d->R);
  d->_g6 = d->_g6_e1 || (d->_g7 && !d->A);
  d->_g7 = d->_g6_e1 || (d->_g12 && !d->B);
  d->_g12 = d->_pg2;
  d->_g2 = d->_GO || d->_g12;
  if (d->_g2) {
    d->O = 0;
  }
  d->_g20 = d->_g11_e2 && !d->R;
  if (d->_g20) {
    d->O |= 1;
  }
  d->_g13 = d->_g20 || (d->_g11 && !d->R);
}

void reset(TickData* d) {
  d->_GO = 1;
  d->_TERM = 0;
  d->O = 0;
  d->_pg6 = 0;
  d->_pg7 = 0;
  d->_pg13 = 0;
  d->_pg2 = 0;
}

void tick(TickData* d) {
  logic(d);

  d->_pg6 = d->_g6;
  d->_pg7 = d->_g7;
  d->_pg13 = d->_g13;
  d->_pg2 = d->_g2;
  d->_GO = 0;
}
