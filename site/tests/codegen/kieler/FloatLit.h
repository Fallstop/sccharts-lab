#ifndef FLOATLIT_H
#define FLOATLIT_H
/*
 * Automatically generated C code by
 * KIELER SCCharts - The Key to Efficient Modeling
 *
 * http://rtsys.informatik.uni-kiel.de/kieler
 */


typedef struct {
  int k;
  double x;
  double y;
  int n;
  char _GO;
  char _TERM;
} TickData;

void reset(TickData* d);
void logic(TickData* d);
void tick(TickData* d);

#endif /* !FLOATLIT_H */
