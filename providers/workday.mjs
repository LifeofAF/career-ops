// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// Workday provider — hits the public CXS job-search endpoint that every
// myworkdayjobs.com tenant exposes:
//
//   POST https://{tenant}.{wdN}.myworkdayjobs.com/wday/cxs/{tenant}/{site}/jobs
//   body: {"limit":20,"offset":0,"searchText":""}
//
// Auto-detects tenant/site from a careers_url of the form
//   https://{tenant}.{wdN}.myworkdayjobs.com[/{locale}]/{site}[/...]
//
// Quirk this provider exists to absorb: Workday populates `total` ONLY on the
// first page. Later pages return `total: 0`, so a naive
// `offset + limit >= total` loop breaks after one page and silently truncates
// the board to 20 rows. We capture `total` from the first response and page
// against that.

const PAGE = 20;
const MAX_PAGES = 25; // 500 postings per entry — plenty after title filtering

const LOCALE_RE = /^[a-z]{2}([-_][A-Za-z]{2,4})?$/;

function parseCareersUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:') return null;
  const host = parsed.hostname.toLowerCase();
  const m = host.match(/^([a-z0-9][a-z0-9-]*)\.(wd\d+)\.myworkdayjobs\.com$/);
  if (!m) return null;
  const [, tenant, wd] = m;
  // First path segment that is not a locale is the site name.
  const site = parsed.pathname.split('/').filter(Boolean).find(s => !LOCALE_RE.test(s));
  if (!site) return null;
  return { tenant, wd, site, host };
}

function resolve(entry) {
  if (entry.workday && entry.workday.tenant && entry.workday.site) {
    const { tenant, site } = entry.workday;
    const wd = entry.workday.wd || 'wd1';
    if (!/^[a-z0-9][a-z0-9-]*$/i.test(tenant) || !/^wd\d+$/.test(wd) || !/^[A-Za-z0-9_-]+$/.test(site)) return null;
    return { tenant, wd, site, host: `${tenant}.${wd}.myworkdayjobs.com` };
  }
  return parseCareersUrl(entry.careers_url || '');
}

/** @type {Provider} */
export default {
  id: 'workday',

  detect(entry) {
    const r = resolve(entry);
    return r ? { url: `https://${r.host}/wday/cxs/${r.tenant}/${r.site}/jobs` } : null;
  },

  async fetch(entry, ctx) {
    const r = resolve(entry);
    if (!r) throw new Error(`workday: cannot derive tenant/site for ${entry.name}`);
    const { tenant, wd, site, host } = r;
    const api = `https://${host}/wday/cxs/${tenant}/${site}/jobs`;
    const searchText = typeof entry.search_text === 'string' ? entry.search_text : '';

    const out = [];
    let total = null;

    for (let page = 0; page < MAX_PAGES; page++) {
      const offset = page * PAGE;
      const json = await ctx.fetchJson(api, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ limit: PAGE, offset, searchText }),
        redirect: 'error',
        timeoutMs: 30_000,
      });

      // `total` is only trustworthy on the first page (see header note).
      if (total === null) total = Number(json?.total) || 0;

      const posts = Array.isArray(json?.jobPostings) ? json.jobPostings : [];
      if (posts.length === 0) break;

      for (const p of posts) {
        const externalPath = typeof p.externalPath === 'string' ? p.externalPath : '';
        if (!externalPath) continue;
        out.push({
          title: p.title || '',
          url: `https://${host}/en-US/${site}${externalPath}`,
          company: entry.name,
          location: p.locationsText || '',
        });
      }

      if (offset + PAGE >= total) break;
    }

    return out;
  },
};
