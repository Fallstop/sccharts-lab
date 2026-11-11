/*
 * Automatically generated C code by
 * KIELER SCCharts - The Key to Efficient Modeling
 *
 * http://rtsys.informatik.uni-kiel.de/kieler
 */

#include "Greeting.h"

void logic(TickData* d) {
  if (!d->_GO) {
    d->nameIsHi = d->name == "hi";
    d->replyIsHi = d->reply == "hi";
  }
}

void reset(TickData* d) {
  d->_GO = 1;
  d->_TERM = 0;
  d->reply = "hi";
  d->nameIsHi = 0;
  d->replyIsHi = 0;
}

void tick(TickData* d) {
  logic(d);

  d->_GO = 0;
}
