# Suggestions Box — deployment repo

Four independent folders, four Railway services, three live subdomains.

| Folder | Railway service | Domain | What it is |
|---|---|---|---|
| `/www` | www | www.suggestionsbox.com.au | Marketing site (index, pricing) — static HTML, no build |
| `/app` | app | app.suggestionsbox.com.au | The real product (login, signup, dashboard, board) — static HTML, no build |
| `/server` | server | api.suggestionsbox.com.au | Express API — needs a persistent volume for `data.json` |
| `/client` | (optional, separate) | — | The original Fix It Right Plumbing pilot React app. Not part of the www/app/api split — deploy separately later if/when needed, since it needs a build step (`npm run build`) and isn't linked to the new signup system yet. |

See the full setup walkthrough in chat for exact click-by-click steps. Short version:
in Railway, create one service per folder above using "root directory" to point
at each one, then add the matching custom domain under each service's
Settings → Networking → Public Networking.
