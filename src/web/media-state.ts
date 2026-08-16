/** A failed URL stays hidden, but a replacement URL gets a fresh load attempt. */
export function mediaSourceVisible(src: string | null, failedSrc: string | null): src is string {
  return Boolean(src) && src !== failedSrc;
}
