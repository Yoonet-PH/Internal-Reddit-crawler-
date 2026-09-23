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
  /** Terms or communities Reddit refused to search this run. */
  failed: string[];
};

const failedNote = (failed: string[]) =>
  failed.length
    ? `Reddit would not search ${failed.join(', ')} this time, so ${failed.length === 1 ? 'it is' : 'they are'} tried again tomorrow.`
    : '';

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
  if (result.failed.length) lines.push(failedNote(result.failed));
  lines.push(
    `^(Searched ${result.searched} posts, dropped ${result.droppedLoose} loose matches, skipped ${result.alreadySeen} already sent.)`
  );
  return { subject, body: lines.join('\n\n---\n\n') };
}

/** Slack mrkdwn needs only &, < and > escaped; links are <url|text>. */
const slackEsc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** The digest as one Slack message. */
export function slackText(result: WatchResult): string {
  const n = result.hits.length;
  const shown = result.hits.slice(0, DIGEST_MAX);
  const lines = [`*${n} new Reddit post${n === 1 ? '' : 's'} for your watch terms*`];
  for (const h of shown) {
    lines.push(
      [
        `<${h.url}|${slackEsc(h.title)}>`,
        `r/${slackEsc(h.subreddit)} · u/${slackEsc(h.author)} · ${ddmm(h.createdAt)} · ${h.comments} comment${h.comments === 1 ? '' : 's'} · matched ${slackEsc(h.matched.join(', '))}`,
        h.excerpt ? `> ${slackEsc(h.excerpt)}` : '',
      ]
        .filter(Boolean)
        .join('\n')
    );
  }
  if (n > shown.length) lines.push(`…and ${n - shown.length} more, which will come in the next digest.`);
  if (result.failed.length) lines.push(slackEsc(failedNote(result.failed)));
  lines.push(
    `_Searched ${result.searched} posts, dropped ${result.droppedLoose} loose matches, skipped ${result.alreadySeen} already sent._`
  );
  return lines.join('\n\n');
}
