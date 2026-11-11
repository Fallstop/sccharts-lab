#ifndef STOPWATCH_H
#define STOPWATCH_H
/*
 * Automatically generated C code by
 * KIELER SCCharts - The Key to Efficient Modeling
 *
 * http://rtsys.informatik.uni-kiel.de/kieler
 */


typedef struct {
  int time;
  int display;
  char startStop;
  char clear;
  char lap;
  char _Atrig;
  char _Atrig1;
  char _g3;
  char _g4;
  char _g6;
  char _g7;
  char _g8;
  char _g9;
  char _g12;
  char _g13;
  char _g14;
  char _g15;
  char _g16;
  char _g19;
  char _g21;
  char _g22;
  char _g24;
  char _g27;
  char _g28;
  char _GO;
  char _cg15;
  char _cg3;
  char _cg6;
  char _cg12;
  char _cg31;
  char _cg21;
  char _cg27;
  char _g7_e1;
  char _g13_e2;
  char _g22_e1;
  char _g28_e2;
  char _TERM;
  char _pg4;
  char _pg7_e1;
  char _pg8;
  char _pg22_e1;
  char _pg21;
  char _pg19;
} TickData;

void reset(TickData* d);
void logic(TickData* d);
void tick(TickData* d);

#endif /* !STOPWATCH_H */
