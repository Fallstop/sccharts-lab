/*
 * Automatically generated C code by
 * KIELER SCCharts - The Key to Efficient Modeling
 *
 * http://rtsys.informatik.uni-kiel.de/kieler
 */

#include "Adder.h"

void logic(TickData* d) {
  d->_g4 = d->_pg3;
  d->_g6 = d->_pg2;
  d->_g4 = d->_GO || d->_g4 || d->_g6;
  d->_g6 = d->_pg24;
  d->_g24 = d->_GO || d->_g6;
  if (d->_g24) {
    d->sum_curval = 0;
  }
  d->_g3 = d->_g4 && d->a;
  if (d->_g3) {
    d->sum_curval += d->a_val;
  }
  d->sum = 0;
  if (d->_g3) {
    d->sum |= 1;
  }
  d->_g2 = d->_g4 && !d->a;
  d->_g11 = d->_pg13;
  d->_g13 = d->_pg9;
  d->_g11 = d->_GO || d->_g11 || d->_g13;
  d->_g13 = d->_g11 && d->b;
  if (d->_g13) {
    d->sum_curval += d->b_val;
    d->sum |= 1;
  }
  d->_g9 = d->_g11 && !d->b;
  d->_g18 = d->_pg18;
  d->_g20 = d->_pg16;
  d->_g20 = d->_GO || d->_g18 || d->_g20;
  d->_cg16 = d->sum;
  d->_g18 = d->_g20 && d->_cg16;
  if (d->_g18) {
    d->sum_val = d->sum_curval;
  }
  d->_g16 = d->_g20 && !d->_cg16;
}

void reset(TickData* d) {
  d->_GO = 1;
  d->_TERM = 0;
  d->sum_val = 0;
  d->sum_curval = 0;
  d->sum = 0;
  d->_pg3 = 0;
  d->_pg2 = 0;
  d->_pg24 = 0;
  d->_pg13 = 0;
  d->_pg9 = 0;
  d->_pg18 = 0;
  d->_pg16 = 0;
}

void tick(TickData* d) {
  logic(d);

  d->_pg3 = d->_g3;
  d->_pg2 = d->_g2;
  d->_pg24 = d->_g24;
  d->_pg13 = d->_g13;
  d->_pg9 = d->_g9;
  d->_pg18 = d->_g18;
  d->_pg16 = d->_g16;
  d->_GO = 0;
}
