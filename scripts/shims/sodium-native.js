export function sodium_memzero(buf) {
  if (buf && typeof buf.fill === "function") {
    buf.fill(0);
  }
}

export function sodium_malloc(n) {
  return Buffer.alloc(n);
}

export function sodium_free(buf) {
  if (buf && typeof buf.fill === "function") {
    buf.fill(0);
  }
}

export default {
  sodium_memzero,
  sodium_malloc,
  sodium_free,
  ready: Promise.resolve(),
};
