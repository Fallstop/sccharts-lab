#ifndef SCOREBOARD_H
#define SCOREBOARD_H
/*
 * Automatically generated C code by
 * KIELER SCCharts - The Key to Efficient Modeling
 *
 * http://rtsys.informatik.uni-kiel.de/kieler
 */

typedef struct {
  int count;
} Scoreboard_Counter;

typedef struct {
  char homeGoal;
  char awayGoal;
  char newMatch;
  int homeScore;
  int awayScore;
  Scoreboard_Counter home,  away;
  char _g3;
  char _g4;
  char _g5;
  char _g6;
  char _g10;
  char _g11;
  char _g13;
  char _GO;
  char _cg5;
  char _cg3;
  char _cg12;
  char _cg10;
  char _TERM;
  char _pg5;
  char _pg11;
} TickData;

void reset(TickData* d);
void logic(TickData* d);
void tick(TickData* d);

#endif /* !SCOREBOARD_H */
