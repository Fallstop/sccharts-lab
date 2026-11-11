#ifndef STRONGCANCEL_H
#define STRONGCANCEL_H
/*
 * Automatically generated C code by
 * KIELER SCCharts - The Key to Efficient Modeling
 *
 * http://rtsys.informatik.uni-kiel.de/kieler
 */


typedef struct {
  char start;
  char sheet;
  char cancel;
  int printed;
  char _g1;
  char _g2;
  char _g4;
  char _g5;
  char _g6;
  char _GO;
  char _cg4;
  char _cg2;
  char _cg5;
  char _TERM;
  char _pg5;
  char _pg1;
} TickData;

void reset(TickData* d);
void logic(TickData* d);
void tick(TickData* d);

#endif /* !STRONGCANCEL_H */
