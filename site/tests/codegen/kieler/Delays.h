#ifndef DELAYS_H
#define DELAYS_H
/*
 * Automatically generated C code by
 * KIELER SCCharts - The Key to Efficient Modeling
 *
 * http://rtsys.informatik.uni-kiel.de/kieler
 */


typedef struct {
  int level;
  int now;
  int start;
  int late;
  int before;
  int _reg_level;
  int _pre_level;
  int _Delays_local___iop_0;
  int _Delays_local___fbp_0;
  int _Delays_local___fbp_next0;
  char _GO;
  char _TERM;
} TickData;

void reset(TickData* d);
void logic(TickData* d);
void tick(TickData* d);

#endif /* !DELAYS_H */
