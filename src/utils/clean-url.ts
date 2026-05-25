// Unwrap newsletter tracking URLs to the original article URL.
//
// Newsletters wrap outbound links in click-tracking redirects, e.g.:
//   https://tracking.tldrnewsletter.com/CL0/<percent-encoded-real-url>/<id>/<sig>=<n>
// The LLM faithfully returns whatever it was given, so we unwrap here.
// Also strips utm_* / tracking query params from the final URL so that
// equality / lookup against a clean gold-standard URL succeeds.

// Only hosts that wrap with the `/CL0/<encoded-url>/...` pattern. Short-URL
// hosts (e.g. links.tldrnewsletter.com) require an HTTP redirect to resolve,
// so they're left as-is — the gold standard uses those short URLs anyway.
const TRACKING_HOSTS = ["tracking.tldrnewsletter.com"];

const TRACKING_QUERY_PARAMS = [
  /^utm_/i,
  /^mc_/i,
  /^_hsenc$/i,
  /^_hsmi$/i,
  /^fbclid$/i,
  /^gclid$/i,
];

function stripTrackingParams(url: URL): URL {
  const toDelete: string[] = [];
  for (const key of url.searchParams.keys()) {
    if (TRACKING_QUERY_PARAMS.some((re) => re.test(key))) toDelete.push(key);
  }
  for (const key of toDelete) url.searchParams.delete(key);
  return url;
}

export function cleanUrl(input: string): string {
  let current = input;

  // Iteratively unwrap — a tracking URL can in principle wrap another.
  for (let i = 0; i < 5; i++) {
    let url: URL;
    try {
      url = new URL(current);
    } catch {
      return input; // not a URL we can parse; leave as-is
    }

    if (!TRACKING_HOSTS.includes(url.hostname)) {
      return stripTrackingParams(url).toString();
    }

    // tldr pattern: /CL0/<encoded-real-url>/<n>/<id>/<sig>=<n>
    // The encoded real URL is the segment after "CL0".
    const segments = url.pathname.split("/").filter(Boolean);
    const cl0Idx = segments.indexOf("CL0");
    const encoded = cl0Idx >= 0 ? segments[cl0Idx + 1] : undefined;
    if (!encoded) return current;

    const decoded = decodeURIComponent(encoded);
    current = decoded;
  }
  return current;
}
