/**
 * Pause for the given number of millis.
 * @param ms millis to pause for
 */
export function pause(ms: number): Promise<void> {
  return new Promise((res) => {
    setTimeout((args) => {
      res();
    }, ms);
  });
}
