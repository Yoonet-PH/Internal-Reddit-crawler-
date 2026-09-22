// Pure logic, no Devvit imports, so it runs under node --test.

export const DIGEST_MAX = 25;

export type WatchConfig = {
  terms: string[];
  communities: string[];
  mutedSubs: Set<string>;
  mutedUsers: Set<string>;
};

export type Hit = {
  id: string;
  title: string;
  subreddit: string;
  author: string;
  url: string;
  createdAt: Date;
  comments: number;
  matched: string[];
  excerpt: string;
};

export type WatchResult = {
  hits: Hit[];
  searched: number;
  droppedLoose: number;
  alreadySeen: number;
};

export function parseTerms(raw: string): WatchConfig {
  const config: WatchConfig = {
    terms: [],
    communities: [],
    mutedSubs: new Set(),
    mutedUsers: new Set(),
  };
  for (const line of raw.split('\n').map((l) => l.trim())) {
    if (!line || line.startsWith('#')) continue;
    const low = line.toLowerCase();
    if (low.startsWith('-r/')) config.mutedSubs.add(low.slice(3));
    else if (low.startsWith('-u/')) config.mutedUsers.add(low.slice(3));
    else if (low.startsWith('r/')) config.communities.push(line.slice(2));
    else config.terms.push(line.replace(/^"|"$/g, ''));
  }
  return config;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Reddit's search stems words and ignores quotes ("Clinic Sites" returns every
 * nursing post about clinical sites), so a hit must contain the exact phrase or
 * sit in a community named after the term. */
export function matchedTerms(
  post: { title: string; body: string; subreddit: string },
  terms: string[]
): string[] {
  const blob = `${post.title} ${post.body}`;
  const found = terms.filter((t) =>
    new RegExp(`(?<!\\w)${escape(t)}(?!\\w)`, 'i').test(blob)
  );
  for (const t of terms) {
    if (!found.includes(t) && squash(t) === squash(post.subreddit)) {
      found.push(`${t} (community)`);
    }
  }
  return found;
}

const ddmm = (d: Date) =>
  `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}`;

export function digest(result: WatchResult): { subject: string; body: string } {
  const n = result.hits.length;
  const subject = `Reddit watch: ${n} new post${n === 1 ? '' : 's'}`;
  const shown = result.hits.slice(0, DIGEST_MAX);
  const lines = shown.map((h) =>
    [
      `**[${h.title.replace(/[[\]]/g, '')}](${h.url})**`,
      `r/${h.subreddit} · u/${h.author} · ${ddmm(h.createdAt)} · ${h.comments} comment${h.comments === 1 ? '' : 's'} · matched ${h.matched.join(', ')}`,
      h.excerpt ? `> ${h.excerpt}` : '',
    ]
      .filter(Boolean)
      .join('\n\n')
  );
  if (n > shown.length) lines.push(`…and ${n - shown.length} more, which will come in the next digest.`);
  lines.push(
    `^(Searched ${result.searched} posts, dropped ${result.droppedLoose} loose matches, skipped ${result.alreadySeen} already sent.)`
  );
  return { subject, body: lines.join('\n\n---\n\n') };
}

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The same digest as an email: light, one column, readable on a phone. */
export function digestHtml(result: WatchResult): string {
  const shown = result.hits.slice(0, DIGEST_MAX);
  const items = shown
    .map(
      (h) => `<tr><td style="padding:16px 0;border-bottom:1px solid #e5e5e5">
<a href="${esc(h.url)}" style="font-size:18px;font-weight:600;color:#1a1a1a;text-decoration:none">${esc(h.title)}</a>
<div style="font-size:14px;color:#595959;margin-top:6px">r/${esc(h.subreddit)} · u/${esc(h.author)} · ${ddmm(h.createdAt)} · ${h.comments} comment${h.comments === 1 ? '' : 's'} · matched ${esc(h.matched.join(', '))}</div>
${h.excerpt ? `<div style="font-size:17px;color:#333333;margin-top:8px;line-height:1.5">${esc(h.excerpt)}</div>` : ''}
</td></tr>`
    )
    .join('\n');
  const more = result.hits.length > shown.length
    ? `<p style="max-width:600px;margin:16px auto 0;font-size:17px;color:#333333">…and ${result.hits.length - shown.length} more, which will come in the next digest.</p>`
    : '';
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body style="margin:0;padding:24px 16px;background:#ffffff;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;overflow-wrap:anywhere">
<table role="presentation" width="100%" style="max-width:600px;margin:0 auto;border-collapse:collapse">
<tr><td style="font-size:20px;font-weight:700;color:#1a1a1a;padding-bottom:4px">New on Reddit for your watch terms</td></tr>
${items}
</table>
${more}
<p style="max-width:600px;margin:16px auto 0;font-size:14px;color:#595959">Searched ${result.searched} posts, dropped ${result.droppedLoose} loose matches, skipped ${result.alreadySeen} already sent. Reply from your own account; this app never posts.</p>
</body></html>`;
}
