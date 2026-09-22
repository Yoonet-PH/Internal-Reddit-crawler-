# bataaneyes

A private Devvit app for one person. Once a day it searches Reddit for a short list of terms (Yoonet, Clinic Admin, Clinic Sites, Cliniko by default), keeps only posts from the last week that contain the exact phrase, and emails the new ones to the app owner. If the email cannot be sent it falls back to the modmail of the subreddit it is installed in. The owner reads them and replies from his own account.

It never posts, comments, votes or messages anyone on Reddit.

## How it runs

- **Daily**: a scheduler task at 18:00 UTC, which is 7am New Zealand time during daylight saving.
- **On demand**: the subreddit menu item "Run Reddit watch now", moderators only.
- **Install and upgrade**: a dry run that only logs what the next real run would send, and whether email is configured, without sending anything.

## Settings

Subreddit setting "Watch terms", one per line:

- `Yoonet` matches the exact phrase, case ignored
- `r/podiatry` watches every new post in that community
- `-r/Bataan` mutes a community, `-u/someone` mutes a person

App settings, set with `npx devvit settings set <name>`:

- `resendApiKey` (secret): a Resend key limited to sending
- `emailTo`: where digests go
- `emailFrom`: defaults to `Reddit watch <reddit@ube.ph>`

## Fetch Domains

The following domains are requested for this app:

- `api.resend.com`: sends the daily digest email to the app owner through Resend's documented email API. Devvit has no way to send email, and the owner needs the digest outside Reddit so he sees it with the rest of his working day. One request a day, to one recipient, containing post titles, links, subreddit, author and a short excerpt of public posts.

## Data

Redis holds only post ids, each expiring after 30 days, so the same post is not sent twice. No post text is stored by the app. Each digest email goes to the owner only. See [terms](docs/terms.md) and [privacy](docs/privacy.md).

## Develop

Node 24 (`fnm use 24`).

- `npm run test:unit`, `npm run test:types`, `npm run lint`, `npm run build`
- `npx devvit upload` then `npx devvit install bataaneyes_dev` to update the test subreddit
- `npx devvit logs bataaneyes_dev` to read what a run did
