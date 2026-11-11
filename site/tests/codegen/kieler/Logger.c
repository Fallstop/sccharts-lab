/*
 * Automatically generated C code by
 * KIELER SCCharts - The Key to Efficient Modeling
 *
 * http://rtsys.informatik.uni-kiel.de/kieler
 */

#include "Logger.h"

void logic(TickData* d) {
  d->_g2 = d->_pg3;
  d->_g3 = d->_g2 && d->sample;
  if (d->_g3) {
    d->latest.value = d->temperature;
    d->latest.number++;
  }
  d->_cg3 = d->latest.number == 1 || d->latest.value > d->highest.value;
  d->_g4 = d->_g3 && d->_cg3;
  if (d->_g4) {
    d->highest.value = d->latest.value;
    d->highest.number = d->latest.number;
  }
  d->_g4 = d->_g4 || (d->_g3 && !d->_cg3);
  if (d->_g4) {
    d->peak = d->highest.value;
    d->peakNumber = d->highest.number;
  }
  d->_g3 = d->_GO || d->_g4 || (d->_g2 && !d->sample);
}

void reset(TickData* d) {
  d->_GO = 1;
  d->_TERM = 0;
  d->peak = 0;
  d->peakNumber = 0;
  d->latest.value = 0;
  d->latest.number = 0;
  d->highest.value = 0;
  d->highest.number = 0;
  d->_pg3 = 0;
}

void tick(TickData* d) {
  logic(d);

  d->_pg3 = d->_g3;
  d->_GO = 0;
}
