import { isIPv4, isIPv6 } from 'node:net';

function expandIPv6(addr: string): string[] {
  const [head = '', tail] = addr.split('::');
  const h = head ? head.split(':') : [];
  const t = tail !== undefined && tail !== '' ? tail.split(':') : [];
  const fill = tail === undefined ? [] : new Array(8 - h.length - t.length).fill('0');
  return [...h, ...fill, ...t].map((g) => g.padStart(4, '0').toLowerCase());
}

/**
 * Rate-limit identity for a client address. IPv4 is used as-is (IPv4-mapped
 * IPv6 is unwrapped). IPv6 is reduced to its /64 prefix, because a single
 * subscriber typically controls a whole /64 and could otherwise rotate
 * addresses to get a fresh bucket per attempt.
 */
export function clientKey(ip: string): string {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) return mapped[1]!;
  if (isIPv4(ip)) return ip;
  if (isIPv6(ip)) return `${expandIPv6(ip).slice(0, 4).join(':')}::/64`;
  return `unknown:${ip}`;
}
