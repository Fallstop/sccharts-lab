#ifndef DISTANCE_H
#define DISTANCE_H
/*
 * Automatically generated C code by
 * KIELER SCCharts - The Key to Efficient Modeling
 *
 * http://rtsys.informatik.uni-kiel.de/kieler
 */

#include <stdlib.h>


typedef struct {
  int position;
  int distance;
  char _GO;
  char _TERM;
} TickData;

void reset(TickData* d);
void logic(TickData* d);
void tick(TickData* d);

#endif /* !DISTANCE_H */
