#ifndef ABRO_H
#define ABRO_H
/*
 * Automatically generated C code by
 * KIELER SCCharts - The Key to Efficient Modeling
 *
 * http://rtsys.informatik.uni-kiel.de/kieler
 */


typedef struct {
  char A;
  char B;
  char R;
  char O;
  char _g2;
  char _g5;
  char _g6;
  char _g7;
  char _g10;
  char _g11;
  char _g12;
  char _g13;
  char _g20;
  char _GO;
  char _cg13;
  char _cg16;
  char _cg7;
  char _cg5;
  char _cg12;
  char _cg10;
  char _g6_e1;
  char _g11_e2;
  char _TERM;
  char _pg6;
  char _pg7;
  char _pg13;
  char _pg2;
} TickData;

void reset(TickData* d);
void logic(TickData* d);
void tick(TickData* d);

#endif /* !ABRO_H */
