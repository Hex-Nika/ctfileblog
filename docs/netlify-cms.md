# Decap CMS on Vercel

The CMS at `/admin` uses a Vercel-hosted username/password login. There is no signup flow: only accounts listed in the `CMS_USERS` environment variable can sign in. CMS changes are sent through a Vercel API proxy, which keeps the GitHub token on the server.

## Configure environment variables

Set these variables in the Vercel project and redeploy:

- `CMS_USERS`: JSON object of usernames and passwords, for example `{"editor":"use-a-long-unique-password"}`. Add more accounts as additional key/value pairs.
- `CMS_SESSION_SECRET`: random secret of at least 32 characters used to sign login sessions.
- `GITHUB_TOKEN`: fine-grained GitHub personal access token restricted to `Hex-Nika/ctfileblog`, with repository contents read/write, pull requests read/write, and metadata read permissions.

The GitHub token is only used by the server-side proxy. Do not add it to the CMS config or client-side code. Change a password by editing `CMS_USERS`; removing an account revokes its next login. Rotating `CMS_SESSION_SECRET` expires existing sessions.

## Use the CMS

Open `https://thectfiles.lol/admin/` and sign in with a configured username and password. Published changes are committed to the `master` branch and trigger a Vercel deployment. Drafts remain in the repository's editorial workflow until published.

The login endpoint is configured for `thectfiles.lol`; use the deployed site for CMS access.