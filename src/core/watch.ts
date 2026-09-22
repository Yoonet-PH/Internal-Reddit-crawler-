import type { Post } from '@devvit/web/server';
import { reddit, redis, settings } from '@devvit/web/server';

const DEFAULT_TERMS = 'Yoonet\nClinic Admin\nClinic Sites\nCliniko';
const SEARCH_LIMIT = 250; // per term, Reddit pages 100 at a time
const WINDOW_DAYS = 7;
const SEEN_DAYS = 30; // Devvit rules ask for stored data to expire within 30 days
const DIGEST_MAX = 25;
const EXCERPT = 240;

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

function toHit(post: Post, matched: string[]): Hit {
  const body = (post.body ?? '').replace(/\s+/g, ' ').trim();
  return {
    id: post.id,
    title: post.title,
    subreddit: post.subredditName,
    author: post.authorName,
    url: `https://www.reddit.com${post.permalink}`,
    createdAt: post.createdAt,
    comments: post.numberOfComments,
    matched,
    excerpt: body.length > EXCERPT ? `${body.slice(0, EXCERPT)}…` : body,
  };
}

export async function loadConfig(): Promise<WatchConfig> {
  const raw = (await settings.get<string>('terms')) ?? DEFAULT_TERMS;
  return parseTerms(raw);
}

/** Search Reddit for every term and community, keep exact matches from the last
 * week that have not been reported before. `markSeen: false` is a dry run. */
export async function runWatch(
  config: WatchConfig,
  { markSeen }: { markSeen: boolean }
): Promise<WatchResult> {
  const since = Date.now() - WINDOW_DAYS * 86_400_000;
  const candidates = new Map<string, { post: Post; community?: string }>();
  let searched = 0;

  for (const term of config.terms) {
    const posts = await reddit
      .searchPosts({
        query: `"${term}"`,
        sort: 'new',
        timeframe: 'week',
        limit: SEARCH_LIMIT,
        pageSize: 100,
      })
      .all();
    searched += posts.length;
    console.log(`search "${term}": ${posts.length} posts`);
    for (const post of posts) candidates.set(post.id, { post });
  }

  for (const name of config.communities) {
    const posts = await reddit
      .getNewPosts({ subredditName: name, limit: 100, pageSize: 100 })
      .all();
    searched += posts.length;
    console.log(`community r/${name}: ${posts.length} posts`);
    for (const post of posts) {
      const existing = candidates.get(post.id);
      candidates.set(post.id, { post, community: `r/${name}`, ...existing });
    }
  }

  const hits: Hit[] = [];
  let droppedLoose = 0;
  let alreadySeen = 0;
  for (const { post, community } of candidates.values()) {
    if (post.createdAt.getTime() < since) continue;
    if (config.mutedSubs.has(post.subredditName.toLowerCase())) continue;
    if (config.mutedUsers.has(post.authorName.toLowerCase())) continue;
    const matched = matchedTerms(
      { title: post.title, body: post.body ?? '', subreddit: post.subredditName },
      config.terms
    );
    if (community) matched.push(community);
    if (!matched.length) {
      droppedLoose++;
      continue;
    }
    if (await redis.exists(`seen:${post.id}`)) {
      alreadySeen++;
      continue;
    }
    hits.push(toHit(post, matched));
  }

  hits.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  if (markSeen) {
    const expiration = new Date(Date.now() + SEEN_DAYS * 86_400_000);
    for (const hit of hits) {
      await redis.set(`seen:${hit.id}`, '1', { expiration });
    }
  }
  return { hits, searched, droppedLoose, alreadySeen };
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
  if (n > shown.length) lines.push(`…and ${n - shown.length} more.`);
  lines.push(
    `^(Searched ${result.searched} posts, dropped ${result.droppedLoose} loose matches, skipped ${result.alreadySeen} already sent.)`
  );
  return { subject, body: lines.join('\n\n---\n\n') };
}
