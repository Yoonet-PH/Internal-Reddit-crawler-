# bataaneyes

A private Devvit app operated by UBE. Once a day it searches Reddit for a short list of terms (Yoonet, Clinic Admin, Clinic Sites, Cliniko by default), keeps only posts from the last week that contain the exact phrase, and posts the new ones to one private channel in UBE's own Slack workspace. If Slack cannot be reached it falls back to the modmail of the subreddit it is installed in. People read them there and reply from their own Reddit accounts.

It never posts, comments, votes or messages anyone on Reddit.

## How it runs

- **Daily**: a scheduler task at 18:00 UTC, which is 7am New Zealand time during daylight saving.
- **On demand**: the subreddit menu item "Run Reddit watch now", moderators only.
- **Install and upgrade**: a dry run that only logs what the next real run would send, and whether Slack is configured, without sending anything.
- **Reddit refuses a search**: each search retries twice; a term that still fails is skipped and named in the digest, and the week long window means the next run picks it up.

## Settings

Subreddit setting "Watch terms", one per line:

- `Yoonet` matches the exact phrase, case ignored
- `r/podiatry` watches every new post in that community
- `-r/Bataan` mutes a community, `-u/someone` mutes a person

App settings, set with `npx devvit settings set <name>`:

- `slackBotToken` (secret): the bot token of a Slack app with only the `chat:write` scope
- `slackChannel`: the channel ID the digest posts to; the bot must be a member

## Fetch Domains

The following domains are requested for this app:

- `slack.com`: calls Slack's documented `chat.postMessage` method to post the daily digest into one private channel in the operator's own Slack workspace. Devvit cannot reach Slack otherwise, and the operator works from Slack, not Reddit's inbox. One request a day, to one channel, containing post titles, links, subreddit, author and a short excerpt of public posts.

## Data

Redis holds only post ids, each expiring after 30 days, so the same post is not sent twice. No post text is stored by the app. Each digest goes to one private Slack channel only. See [terms](docs/terms.md) and [privacy](docs/privacy.md).

## Develop

Node 24 (`fnm use 24`).

- `npm run test:unit`, `npm run test:types`, `npm run lint`, `npm run build`
- `npx devvit upload` then `npx devvit install bataaneyes_dev` to update the test subreddit
- `npx devvit logs bataaneyes_dev` to read what a run did
