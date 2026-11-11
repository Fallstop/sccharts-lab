#ifndef DOORBELL_H
#define DOORBELL_H
/*
 * Automatically generated C code by
 * KIELER SCCharts - The Key to Efficient Modeling
 *
 * http://rtsys.informatik.uni-kiel.de/kieler
 */


typedef struct {
  int count;
  int _taken_transitions[1];
  char button;
  char chime;
  int rings_val;
  int rings_curval;
  char rings;
  char _g3;
  char _g4;
  char _g11;
  char _g13;
  char _g15;
  char _GO;
  char _cg3;
  char _cg11;
  char _TERM;
  char _pg4;
  char _pg13;
  char _pg11;
} TickData;

void reset(TickData* d);
void logic(TickData* d);
void tick(TickData* d);

#endif /* !DOORBELL_H */
