export const CSP = "default-src 'self'; script-src 'self' https://www.youtube.com https://s.ytimg.com; style-src 'self'; img-src 'self' https://i.ytimg.com; frame-src https://www.youtube.com; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";
export function securityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Content-Security-Policy', CSP);
}
