#ifndef LOGGER_H
#define LOGGER_H
/*
 * Automatically generated C code by
 * KIELER SCCharts - The Key to Efficient Modeling
 *
 * http://rtsys.informatik.uni-kiel.de/kieler
 */

typedef struct {
  int value;
  int number;
} Logger_Reading;

typedef struct {
  char sample;
  int temperature;
  int peak;
  int peakNumber;
  Logger_Reading latest,  highest;
  char _g2;
  char _g3;
  char _g4;
  char _GO;
  char _cg2;
  char _cg3;
  char _TERM;
  char _pg3;
} TickData;

void reset(TickData* d);
void logic(TickData* d);
void tick(TickData* d);

#endif /* !LOGGER_H */
