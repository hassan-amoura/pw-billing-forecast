# Billing Forecast Utility — Hosting Options

Reference document. Four viable options, assessed on cost, difficulty, delivery time, and
ongoing burden. Platform pricing and limits are current as of writing and should be re-checked
before committing.

---

## What the tool requires from any host

These are properties of the application, not preferences. They constrain every option below.

| Requirement | Detail |
|---|---|
| **Node.js 18+ runtime** | Single Express process, two dependencies, no build step. Very portable. |
| **Server-side credential storage** | Projectworks API credentials sit in server environment variables and never reach the browser. Rules out static-only hosting. |
| **A writable, persistent disk** | Supplier lines and the audit trail live in `data/store.json`. Platforms with throwaway filesystems lose this data on every deploy and cold start. |
| **Authentication added externally** | The tool has no login. The user dropdown labels audit entries; it does not authenticate. Anything on a public URL needs auth in front of it. |
| **Single tenant per instance** | Credentials are per-tenant environment variables. One deployment serves one Projectworks tenant. |
| **Outbound HTTPS to the Projectworks API** | No inbound access to the tenant required. |

Two further notes that affect Option D specifically:

- Every grid load pulls **all** projects, modules and invoices, paginated at 200 records per
  page. On a large tenant that is a lot of sequential outbound requests in one user action.
- There is no caching layer. Each page load repeats the full pull.

---

## Shared prerequisite work

Applies to all four options and only needs doing once. Roughly **one day**.

| Item | Detail | Effort |
|---|---|---|
| Dockerfile | `node:20-alpine`, no build step | ~1 hr |
| `docker-compose.yml` | With `./data:/app/data` volume mapping | ~30 min |
| Optional basic-auth middleware | Env-var gated, so the app is safe even when the platform isn't | 2–4 hrs |
| Runbook | Credential rotation, backup/restore of `store.json`, toggling writes | ~2 hrs |
| Platform config in repo | `fly.toml` / `render.yaml` / `railway.json` | ~1 hr |

Completing this makes all four options available and defers the final choice.

---

## Option A — Standalone executable, run locally

### What it is
The tool compiled into a single executable file. The client double-clicks it; it starts a local
server and opens in their browser. Credentials live in a config file beside the executable.

### How it's built
`bun build --compile` produces a single binary bundling the runtime (Node's own single-executable
support exists but is still experimental). Output is roughly 50–100 MB per platform. Needs a
separate build per operating system.

### Numbers

| | |
|---|---|
| **Setup cost** | $0, unless code signing is needed — see cons |
| **Ongoing cost** | $0 |
| **Our build effort** | ~1 day, plus testing on each target OS |
| **Time to client having it** | 1–2 days |
| **Difficulty** | **Low** |
| **Ongoing burden on us** | Low, but every update means redistributing a new binary |
| **Who holds credentials** | The client, on their own machine |
| **Where data lives** | That one machine, in a local file |
| **Auth** | Not applicable — bound to localhost, never exposed |

### Pros
- Cheapest and fastest option by a wide margin.
- No hosting, no uptime obligation, no data-processing agreement, no attack surface.
- Nothing for the client's security team to review — no public endpoint exists.
- Works offline apart from the Projectworks API calls themselves.

### Cons
- **Data is per-machine.** Two people using it do not see each other's supplier lines, and
  there is no shared audit trail. This is the disqualifying constraint.
- No central backup. If that laptop dies, the supplier lines and audit history die with it.
- Unsigned binaries trigger security warnings on both macOS and Windows. Signing means an Apple
  Developer Program membership (~$99/yr) and a Windows code-signing certificate (~$200–400/yr).
  Without it, expect the client to need talking through the warning dialogs.
- Updates are manual: we send a new file, they replace the old one.
- Harder to support — we cannot see logs or reproduce their environment.

### Best fit when
A single person uses the tool, and shared state genuinely does not matter.

---

## Option B — Container image, hosted by the client

### What it is
We deliver a Docker image and documentation. The client's IT runs it on their own
infrastructure, mounts a volume for the data directory, and puts their existing single sign-on
in front of it.

### How it's delivered
Either a private container registry (they authenticate and pull), or a `docker save` tarball of
around 150–200 MB transferred as a file — no registry access needed on their side.

### Numbers

| | |
|---|---|
| **Setup cost** | $0 to us |
| **Ongoing cost** | $0 to us; the client's existing infrastructure spend |
| **Our build effort** | ~1 day — this is the shared prerequisite work, nothing extra |
| **Time to client having it running** | Our part: 1 day. **Their part: days to weeks**, depending on their change process |
| **Difficulty for us** | **Low** |
| **Difficulty for them** | Low if they already run containers; high if they don't |
| **Ongoing burden on us** | Very low — support questions only |
| **Who holds credentials** | The client |
| **Where data lives** | A volume in their environment, covered by their existing backups |
| **Auth** | Their existing SSO or reverse proxy; our basic-auth fallback if they have neither |

### Pros
- Cleanest liability position available: we hold no credentials, no data, no uptime obligation,
  and need no data-processing agreement.
- Their financial data never leaves their environment — the easiest version of this to get
  through a security review.
- Backups, monitoring and patching fold into processes they already run.
- Their infrastructure choices become their own problem, in the good sense.
- Zero marginal cost to us per client.

### Cons
- **Entirely dependent on their IT being willing and able.** Our work is a day; their approval
  queue is not under our control and is the real delivery timeline.
- Debugging is harder — no access to logs or environment. Support becomes a conversation rather
  than an investigation.
- No control over version drift. They may run an old image indefinitely.
- If they have no SSO or reverse proxy, the auth question lands back with us.
- Requires a competent counterpart on their side. If there isn't one, this option quietly fails.

### Variant: no public endpoint at all
The container runs on a machine they own and connects outbound through a secure tunnel
(Cloudflare Tunnel or similar) with SSO in front. No inbound ports, no public web address. Free
at their likely user count, and a notably strong story for a security reviewer looking at a
finance tool. Adds a few hours of documentation.

### Best fit when
Multiple people use the tool and the client has functioning IT.

---

## Option C — Small cloud platform, hosted by us, built to transfer

### What it is
Deployed to Fly.io, Render or Railway with a persistent volume attached, with single sign-on in
front. All deployment configuration lives in the repository, so relocating it to the client's
own account later is a redeploy rather than a rebuild.

### Platform comparison

| | Fly.io | Render | Railway |
|---|---|---|---|
| Monthly cost | ~$2–3 (256 MB machine + 1 GB volume) | $7 Starter + ~$0.25/GB disk | $5 Hobby, includes usage |
| Deploys from | Docker | Docker or repo | Docker or repo |
| Config file | `fly.toml` | `render.yaml` | `railway.json` |
| Region control | Yes — Sydney is closest to the Projectworks API | Limited | Limited |
| Account transfer | Redeploy under their account | Redeploy under their account | Native project transfer |
| Notes | Cheapest, most control, most CLI-driven | Most clickable, least surprising | Best developer experience |

A service with an attached disk runs as a single instance and gives up zero-downtime deploys.
Not a real constraint here — the JSON file store could not safely serve two instances anyway.

### Numbers

| | |
|---|---|
| **Setup cost** | $0 |
| **Ongoing cost** | $3–15/mo depending on platform. SSO via Cloudflare Access is free up to 50 users but requires a domain on Cloudflare |
| **Our build effort** | ~half a day on top of the shared prerequisite work |
| **Time to client having it** | 2 days total |
| **Difficulty** | **Low to medium** — the deployment is easy; the operational commitments are the work |
| **Ongoing burden on us** | **Medium and permanent**: backups, uptime monitoring, credential custody, incident response |
| **Who holds credentials** | Us |
| **Where data lives** | A volume we own and must back up |
| **Auth** | SSO at the edge, configured by us |

### Pros
- Fastest route to the client having a working URL, with no dependency on their IT.
- We control the environment, so support and debugging are straightforward.
- Cheap in direct cost.
- Region selection puts the server near the Projectworks API.
- Designed for handover from day one — because config is in the repo, moving it to their account
  is an afternoon, not a project.

### Cons
- **We take on the liability.** Holding their API credentials and processing their financial data
  means a data-processing agreement and a credential-custody story.
- **Someone must own backups.** `store.json` holds supplier lines and audit history that exist
  nowhere else, including not in Projectworks. A volume is not a backup.
- Ongoing operational duties with no natural end: monitoring, patching, incident response.
- Creates an expectation of availability that nobody has scoped or resourced.
- Without a written end date, "temporary hosting" becomes permanent hosting.
- One deployment per client. This does not scale to a second and third client without more work.

### If we choose this
Set the handover date in writing at the start. A bridge arrangement with no end date is
indistinguishable from an open-ended commitment.

### Best fit when
The client needs it working before their own deployment can be approved, and we want a defined
bridge rather than a permanent arrangement.

---

## Option D — Replace the storage layer, then host free

### What it is
Move supplier lines and the audit trail out of the JSON file and into a managed database
(Cloudflare D1, Turso or Neon — all have usable free tiers). The application becomes stateless,
which unlocks genuinely free hosting on Cloudflare Workers or Vercel, with SSO included.

### What the work involves
1. Replace the file-based store with database queries — the read-modify-write pattern in
   `server.js` disappears.
2. Port the framework if targeting Cloudflare Workers, which does not run Express. Hono is the
   usual replacement and the route logic maps across fairly directly.
3. **Add caching.** This is the part that is easy to underestimate. Serverless platforms impose
   short function timeouts (on the order of 10–60 seconds on free tiers) and cap outbound
   requests per invocation — Cloudflare's free plan allows 50 subrequests. The current design
   makes a full paginated pull of every collection on each grid load, which can exceed both
   limits on a large tenant. Making this work reliably means caching the reference data, not
   just swapping the database.

### Numbers

| | |
|---|---|
| **Setup cost** | $0 in fees; 3–5 days of development |
| **Ongoing cost** | $0/mo at this usage level |
| **Our build effort** | **3–5 days.** 2–3 for storage and framework, 1–2 for caching and the request-limit work |
| **Time to client having it** | 1–2 weeks including testing |
| **Difficulty** | **Medium to high** — the only option requiring meaningful changes to the application |
| **Ongoing burden on us** | Low once built. Managed database, no servers, no volume backups |
| **Who holds credentials** | Us (platform secrets) |
| **Where data lives** | Managed database, backed up by the provider |
| **Auth** | Included free on both platforms |

### Pros
- No ongoing hosting cost, permanently.
- Removes the most fragile part of the current design. The JSON file is not concurrency-safe: two
  simultaneous edits lose one of them. A database fixes this properly.
- No volume to back up, no server to patch, no single instance to keep alive.
- Makes the tool genuinely repeatable — a second client becomes an hour of setup rather than a
  fresh deployment.
- Adding real authentication and multi-tenancy later is far easier from this starting point.

### Cons
- **The only option that requires changing the application**, which means new bugs in code that
  currently works.
- Effort estimate carries the most uncertainty. The caching requirement is discovered work, not
  planned work, and could grow.
- Free-tier limits need verifying against a realistically sized tenant before committing.
- Cold starts on free tiers will make the first load of the day noticeably slow.
- Overkill for a single client. The investment only returns if the tool gets reused.
- We still host it, so the credential-custody and data-processing questions from Option C remain.

### Best fit when
This is the first of several clients, or the tool is heading toward becoming a supported
internal product.

---

## Comparison summary

| | A: Local executable | B: Client-hosted container | C: We host on PaaS | D: Rebuilt for serverless |
|---|---|---|---|---|
| Ongoing cost | $0 | $0 to us | $3–15/mo | $0 |
| Our effort | ~1 day | ~1 day | ~1.5 days | 3–5 days |
| Time to delivery | 1–2 days | 1 day + their queue | 2 days | 1–2 weeks |
| Difficulty | Low | Low | Low–medium | Medium–high |
| Shared data | **No** | Yes | Yes | Yes |
| We hold credentials | No | No | **Yes** | **Yes** |
| Data-processing agreement | No | No | **Yes** | **Yes** |
| Ongoing burden on us | Low | Very low | **Medium, permanent** | Low |
| Depends on their IT | No | **Yes** | No | No |
| Application changes needed | No | No | No | **Yes** |
| Scales to more clients | No | Yes | Poorly | **Yes** |

---

## Questions that decide the answer

1. **How many people will use it?** One person makes Option A viable. More than one eliminates it
   outright — there is no shared state.
2. **Will the client's IT accept and run a container?** Yes points to B. No points to C.
3. **Is this the only client, or the first of several?** Only D pays for itself across multiple
   clients; only D makes the second deployment cheap.
4. **Who owns support after handover?** Needs a named person. The tool is a third-party utility
   and not part of the Projectworks product, so this does not default to anyone.
5. **How critical is the supplier-line and audit data?** It exists only in this tool, not in
   Projectworks. This sets the backup requirement under B, C and D.
6. **Stage tenant or production?** Writes are disabled by default and should stay that way until
   validated against stage, whichever hosting option is chosen.

---

## Related note

Supplier lines exist locally because Projectworks has no supplier grain in forecasts. If they
were instead modelled as child modules inside Projectworks, `data/store.json` would not be needed
at all, the tool would become stateless without any of Option D's work, and the rollup that
currently overwrites existing Projectworks forecast values would no longer be necessary. Worth
investigating before committing to Option D, since it reaches the same end state through the
product rather than through infrastructure.
