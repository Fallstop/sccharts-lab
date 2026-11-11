/*
 * Automatically generated C code by
 * KIELER SCCharts - The Key to Efficient Modeling
 *
 * http://rtsys.informatik.uni-kiel.de/kieler
 */

#include "Stopwatch.h"

void logic(TickData* d) {
  d->_g12 = d->_pg4;
  d->_g13 = d->_g12 && d->startStop;
  if (d->_g13) {
    d->_Atrig = 1;
  }
  d->_g3 = d->_pg7_e1;
  d->_g4 = d->_g3 && d->startStop;
  if (d->_g4) {
    d->_Atrig = 0;
  }
  d->_g9 = d->_pg8;
  if (d->_g9) {
    d->time++;
  }
  d->_g9 = d->_g4 || d->_g9;
  d->_cg6 = d->_Atrig;
  d->_g8 = d->_g9 && !d->_cg6;
  d->_g7_e1 = !d->_g8;
  d->_g6 = d->_g9 && d->_cg6;
  d->_g4 = d->_g4 || (d->_g12 && !d->startStop);
  d->_g12 = !d->_g4;
  d->_g13_e2 = (d->_g7_e1 || d->_g6) && (d->_g12 || d->_g13) && (d->_g6 || d->_g13);
  d->_g7 = d->_g3 && !d->startStop;
  d->_g13 = d->_g7 && d->clear;
  if (d->_g13) {
    d->time = 0;
  }
  d->_g7_e1 = d->_GO || d->_g13_e2 || d->_g13 || (d->_g7 && !d->clear);
  d->_g3 = d->_pg22_e1;
  d->_g15 = d->_GO || (d->_g3 && d->lap);
  if (d->_g15) {
    d->_Atrig1 = 0;
  }
  d->_g16 = d->_pg21;
  d->_g14 = d->_g15 || d->_g16;
  if (d->_g14) {
    d->display = d->time;
  }
  d->_g24 = d->_pg19;
  d->_g28 = d->_g24 && d->lap;
  if (d->_g28) {
    d->_Atrig1 = 1;
  }
  d->_cg21 = d->_Atrig1;
  d->_g22 = d->_g14 && d->_cg21;
  d->_g21 = d->_g14 && !d->_cg21;
  d->_g19 = d->_g15 || (d->_g24 && !d->lap);
  d->_g27 = !d->_g21;
  d->_g28_e2 = !d->_g19;
  d->_g28_e2 = (d->_g27 || d->_g22) && (d->_g28_e2 || d->_g28) && (d->_g22 || d->_g28);
  d->_g22_e1 = d->_g28_e2 || (d->_g3 && !d->lap);
}

void reset(TickData* d) {
  d->_GO = 1;
  d->_TERM = 0;
  d->time = 0;
  d->display = 0;
  d->_pg4 = 0;
  d->_pg7_e1 = 0;
  d->_pg8 = 0;
  d->_pg22_e1 = 0;
  d->_pg21 = 0;
  d->_pg19 = 0;
}

void tick(TickData* d) {
  logic(d);

  d->_pg4 = d->_g4;
  d->_pg7_e1 = d->_g7_e1;
  d->_pg8 = d->_g8;
  d->_pg22_e1 = d->_g22_e1;
  d->_pg21 = d->_g21;
  d->_pg19 = d->_g19;
  d->_GO = 0;
}
