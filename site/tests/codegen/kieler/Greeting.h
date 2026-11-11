#ifndef GREETING_H
#define GREETING_H
/*
 * Automatically generated C code by
 * KIELER SCCharts - The Key to Efficient Modeling
 *
 * http://rtsys.informatik.uni-kiel.de/kieler
 */


typedef struct {
  char* name;
  char* reply;
  char nameIsHi;
  char replyIsHi;
  char _GO;
  char _TERM;
} TickData;

void reset(TickData* d);
void logic(TickData* d);
void tick(TickData* d);

#endif /* !GREETING_H */
