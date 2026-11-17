#include <stdio.h>
#include "Turnstile.h"

int main(void) {
  TickData d;
  reset(&d);

  /* One row per tick: coin, push. */
  char inputs[4][2] = { {0, 0}, {1, 0}, {0, 1}, {0, 1} };
  for (int i = 0; i < 4; i++) {
    d.coin = inputs[i][0];
    d.push = inputs[i][1];
    tick(&d);
    printf("tick %d: unlocked=%d passed=%d\n",
           i + 1, d.unlocked, d.passed);
  }
  return 0;
}
