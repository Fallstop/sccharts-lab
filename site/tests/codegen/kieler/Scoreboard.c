/*
 * Automatically generated C code by
 * KIELER SCCharts - The Key to Efficient Modeling
 *
 * http://rtsys.informatik.uni-kiel.de/kieler
 */

#include "Scoreboard.h"

void logic(TickData* d) {
  d->_g3 = d->_pg5;
  d->_g4 = d->_g3 && d->newMatch;
  if (d->_g4) {
    d->home.count = 0;
    d->homeScore = d->home.count;
  }
  d->_g3 = d->_g3 && !d->newMatch;
  d->_g6 = d->_g3 && d->homeGoal;
  if (d->_g6) {
    d->home.count++;
    d->homeScore = d->home.count;
  }
  d->_g5 = d->_GO || d->_g4 || d->_g6 || (d->_g3 && !d->homeGoal);
  d->_g4 = d->_pg11;
  d->_g6 = d->_g4 && d->newMatch;
  if (d->_g6) {
    d->away.count = 0;
    d->awayScore = d->away.count;
  }
  d->_g10 = d->_g4 && !d->newMatch;
  d->_g13 = d->_g10 && d->awayGoal;
  if (d->_g13) {
    d->away.count++;
    d->awayScore = d->away.count;
  }
  d->_g11 = d->_GO || d->_g6 || d->_g13 || (d->_g10 && !d->awayGoal);
}

void reset(TickData* d) {
  d->_GO = 1;
  d->_TERM = 0;
  d->homeScore = 0;
  d->awayScore = 0;
  d->home.count = 0;
  d->away.count = 0;
  d->_pg5 = 0;
  d->_pg11 = 0;
}

void tick(TickData* d) {
  logic(d);

  d->_pg5 = d->_g5;
  d->_pg11 = d->_g11;
  d->_GO = 0;
}
