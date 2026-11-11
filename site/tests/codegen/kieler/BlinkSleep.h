#ifndef BLINKSLEEP_H
#define BLINKSLEEP_H
/*
 * Automatically generated C code by
 * KIELER SCCharts - The Key to Efficient Modeling
 *
 * http://rtsys.informatik.uni-kiel.de/kieler
 */


typedef struct {
  char led;
  double t;
  double deltaT;
  double sleepT;
  double _reg_sleepT;
  double _pre_sleepT;
  char _Atrig;
  char _Atrig1;
  char _g2;
  char _g5;
  char _g6;
  char _g8;
  char _g10;
  char _g11;
  char _g12;
  char _g13;
  char _g14;
  char _g16;
  char _g17;
  char _g20;
  char _g21;
  char _g25;
  char _g26;
  char _g30;
  char _g31;
  char _g33;
  char _g36;
  char _g40;
  char _g41;
  char _g42;
  char _g50;
  char _GO;
  char _cg3;
  char _cg5;
  char _cg7;
  char _cg8;
  char _cg12;
  char _cg11;
  char _cg14;
  char _cg17;
  char _cg20;
  char _cg23;
  char _cg25;
  char _cg27;
  char _cg28;
  char _cg32;
  char _cg31;
  char _cg34;
  char _cg37;
  char _cg40;
  char _g6_e1;
  char _g13_e2;
  char _g21_e3;
  char _g26_e1;
  char _g33_e2;
  char _g41_e3;
  char _TERM;
  char _pg20;
  char _pg6;
  char _pg13;
  char _pg21_e3;
  char _pg6_e1;
  char _pg41_e3;
  char _pg14;
  char _pg8;
  char _pg17;
} TickData;

void reset(TickData* d);
void logic(TickData* d);
void tick(TickData* d);

#endif /* !BLINKSLEEP_H */
