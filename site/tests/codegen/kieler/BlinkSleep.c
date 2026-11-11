/*
 * Automatically generated C code by
 * KIELER SCCharts - The Key to Efficient Modeling
 *
 * http://rtsys.informatik.uni-kiel.de/kieler
 */

#include "BlinkSleep.h"

void logic(TickData* d) {
  d->_g25 = d->_pg20;
  d->_g26_e1 = !d->_g25;
  d->_pre_sleepT = d->_reg_sleepT;
  d->_g50 = d->_pg6;
  if (d->_g50) {
    d->deltaT = d->_pre_sleepT;
  }
  if (d->_g25) {
    d->t += d->deltaT;
  }
  d->_g40 = d->_pg13;
  d->_cg40 = d->t >= 300;
  d->_g41 = d->_g40 && d->_cg40;
  if (d->_g41) {
    d->_Atrig1 = 1;
  }
  d->_cg25 = d->_Atrig1;
  d->_g26 = d->_g25 && d->_cg25;
  d->_g36 = d->_pg21_e3;
  d->_g30 = d->_pg6_e1;
  d->_g33_e2 = !(d->_g36 || d->_g30);
  d->sleepT = 1000.0;
  d->_g30 = d->_g30 || d->_g36;
  d->_cg31 = d->t < 300.0;
  d->_g36 = d->_g30 && d->_cg31;
  if (d->_g36) {
    d->sleepT = (d->sleepT < (300.0 - d->t)) ? d->sleepT : (300.0 - d->t);
  }
  d->_cg32 = d->_Atrig1;
  d->_g31 = d->_g30 && !d->_cg31;
  d->_cg34 = d->_Atrig1;
  d->_g33 = (d->_g36 && d->_cg32) || (d->_g31 && d->_cg34);
  d->_g41_e3 = !d->_g40;
  d->_g26 = (d->_g26_e1 || d->_g26) && (d->_g33_e2 || d->_g33) && (d->_g41_e3 || d->_g41) && (d->_g26 || d->_g33 || d->_g41);
  if (d->_g26) {
    d->led = 0;
    d->t = 0;
  }
  d->_g41 = d->_GO || d->_g26;
  if (d->_g41) {
    d->_Atrig = 0;
  }
  d->_cg3 = d->_Atrig;
  d->_g26_e1 = d->_pg41_e3;
  if (d->_g26_e1) {
    d->t += d->deltaT;
  }
  d->_g33 = d->_pg14;
  d->_cg20 = d->t >= 500;
  d->_g33_e2 = d->_g33 && d->_cg20;
  if (d->_g33_e2) {
    d->_Atrig = 1;
  }
  d->_cg5 = d->_Atrig;
  d->_g41_e3 = (d->_g41 && !d->_cg3) || (d->_g26_e1 && !d->_cg5);
  d->_g42 = d->_g26_e1 && d->_cg5;
  d->_cg7 = d->t < 500.0;
  d->_g8 = d->_g41 && d->_cg7;
  if (d->_g8) {
    d->sleepT = (d->sleepT < (500.0 - d->t)) ? d->sleepT : (500.0 - d->t);
  }
  d->_cg8 = d->_Atrig;
  d->_g10 = d->_pg8;
  d->_g16 = d->_pg17;
  d->_g11 = d->_g10 || d->_g16;
  d->_cg11 = d->t < 500.0;
  d->_g12 = d->_g11 && d->_cg11;
  if (d->_g12) {
    d->sleepT = (d->sleepT < (500.0 - d->t)) ? d->sleepT : (500.0 - d->t);
  }
  d->_cg12 = d->_Atrig;
  d->_g8 = (d->_g8 && !d->_cg8) || (d->_g12 && !d->_cg12);
  d->_g11 = d->_g11 && !d->_cg11;
  d->_cg14 = d->_Atrig;
  d->_g12 = (d->_g12 && d->_cg12) || (d->_g11 && d->_cg14);
  d->_g17 = d->_g41 && !d->_cg7;
  d->_cg17 = d->_Atrig;
  d->_g17 = (d->_g11 && !d->_cg14) || (d->_g17 && !d->_cg17);
  d->_g14 = d->_g41 || (d->_g33 && !d->_cg20);
  d->_g2 = !d->_g26_e1;
  d->_g5 = !(d->_g16 || d->_g10);
  d->_g16 = !d->_g33;
  d->_g10 = (d->_g2 || d->_g42) && (d->_g5 || d->_g12) && (d->_g16 || d->_g33_e2) && (d->_g42 || d->_g12 || d->_g33_e2);
  if (d->_g10) {
    d->led = 1;
    d->t = 0;
    d->_Atrig1 = 0;
  }
  d->_cg23 = d->_Atrig1;
  d->_g20 = (d->_g10 && !d->_cg23) || (d->_g25 && !d->_cg25);
  d->_cg27 = d->t < 300.0;
  d->_g21 = d->_g10 && d->_cg27;
  if (d->_g21) {
    d->sleepT = (d->sleepT < (300.0 - d->t)) ? d->sleepT : (300.0 - d->t);
  }
  d->_cg28 = d->_Atrig1;
  d->_g6_e1 = (d->_g21 && !d->_cg28) || (d->_g36 && !d->_cg32);
  d->_g13_e2 = d->_g10 && !d->_cg27;
  d->_cg37 = d->_Atrig1;
  d->_g21_e3 = (d->_g31 && !d->_cg34) || (d->_g13_e2 && !d->_cg37);
  d->_g13 = d->_g10 || (d->_g40 && !d->_cg40);
  d->_g6 = d->_GO || d->_g50;
  d->_reg_sleepT = d->sleepT;
}

void reset(TickData* d) {
  d->_GO = 1;
  d->_TERM = 0;
  d->led = 0;
  d->t = 0.0;
  d->deltaT = 0.0;
  d->sleepT = 0.0;
  d->_reg_sleepT = 0.0;
  d->_pg20 = 0;
  d->_pg6 = 0;
  d->_pg13 = 0;
  d->_pg21_e3 = 0;
  d->_pg6_e1 = 0;
  d->_pg41_e3 = 0;
  d->_pg14 = 0;
  d->_pg8 = 0;
  d->_pg17 = 0;
}

void tick(TickData* d) {
  logic(d);

  d->_pg20 = d->_g20;
  d->_pg6 = d->_g6;
  d->_pg13 = d->_g13;
  d->_pg21_e3 = d->_g21_e3;
  d->_pg6_e1 = d->_g6_e1;
  d->_pg41_e3 = d->_g41_e3;
  d->_pg14 = d->_g14;
  d->_pg8 = d->_g8;
  d->_pg17 = d->_g17;
  d->_GO = 0;
}
