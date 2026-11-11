#ifndef TOGGLE_H
#define TOGGLE_H
/*
 * Automatically generated C code by
 * KIELER SCCharts - The Key to Efficient Modeling
 *
 * http://rtsys.informatik.uni-kiel.de/kieler
 */


typedef struct {
  char button;
  char light;
  char _g2;
  char _g5;
  char _g6;
  char _GO;
  char _cg2;
  char _cg5;
  char _TERM;
  char _pg5;
  char _pg6;
} TickData;

void reset(TickData* d);
void logic(TickData* d);
void tick(TickData* d);

#endif /* !TOGGLE_H */
