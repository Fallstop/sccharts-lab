#ifndef ADDER_H
#define ADDER_H
/*
 * Automatically generated C code by
 * KIELER SCCharts - The Key to Efficient Modeling
 *
 * http://rtsys.informatik.uni-kiel.de/kieler
 */


typedef struct {
  int a_val;
  char a;
  int b_val;
  char b;
  int sum_val;
  int sum_curval;
  char sum;
  char _g2;
  char _g3;
  char _g4;
  char _g6;
  char _g9;
  char _g11;
  char _g13;
  char _g16;
  char _g18;
  char _g20;
  char _g24;
  char _GO;
  char _cg2;
  char _cg9;
  char _cg16;
  char _TERM;
  char _pg3;
  char _pg2;
  char _pg24;
  char _pg13;
  char _pg9;
  char _pg18;
  char _pg16;
} TickData;

void reset(TickData* d);
void logic(TickData* d);
void tick(TickData* d);

#endif /* !ADDER_H */
