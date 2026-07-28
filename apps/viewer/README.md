# Showroom viewer

## Chatbot (OpenAI)

The **Chatbot** panel calls `POST /api/chat`, implemented as a Cloudflare Pages Function. The OpenAI API key must **never** be exposed in the browser; configure it only in the Worker environment.

### Production / Cloudflare Pages

1. In the Pages project (**Settings → Environment variables** or Wrangler), add:
   - **`OPENAI_API_KEY`** — secret (OpenAI [API keys](https://platform.openai.com/api-keys)).
   - **`OPENAI_MODEL`** (optional) — defaults to `gpt-4o-mini` if unset.

2. For Wrangler CLI from this app directory (use **`pages`**, not Workers `secret put`):

   ```bash
   pnpm exec wrangler pages secret put OPENAI_API_KEY --project-name=changan-showroom
   ```

   **Production vs preview:** `wrangler pages deploy --branch main` only sees secrets from the **production** environment if the Pages project’s **Production branch** is also `main`. If your deploys are treated as **preview** (mismatched branch), add the same secret for preview or fix the branch:

   ```bash
   pnpm exec wrangler pages secret put OPENAI_API_KEY --project-name=changan-showroom --env preview
   ```

   Or in the dashboard: **Workers & Pages** → project → **Settings** → set **Production branch** to `main` (matches `scripts/pages-wrangler-deploy.sh`).

   Optional text variable:

   ```bash
   pnpm exec wrangler pages project list   # find project name
   # In dashboard: Settings → Variables → OPENAI_MODEL = gpt-4o-mini
   ```

### Knowledge files

Editable copy lives under `public/knowledge/`:

- `changan.txt` — brand, tone, and assistant behavior.
- One file per model: `alsvin.txt`, `cs35.txt`, `cs55.txt`, `cs95.txt`, `hunter-d.txt`, `hunter-g.txt`.

They are copied into the build output and read by the chat function at request time.

### Local development

- **`pnpm dev`** / **`dev:viewer`**: the dev server reads **`OPENAI_API_KEY`** (and optional **`OPENAI_MODEL`**) from, in order:
  1. **`apps/viewer/.env.local`** — copy from [`.env.example`](.env.example) and paste your key.
  2. **Repo root** `.env.local` (monorepo root next to `pnpm-workspace.yaml`), if you keep secrets there.
  3. Your **shell environment** (`export OPENAI_API_KEY=sk-...`).
  
  Restart Vite after changing env files. Chat uses the same logic as production; knowledge is read from `public/knowledge/`.
- **`pnpm pages:dev`**: builds, then runs `wrangler pages dev` on `dist`. Use **`apps/viewer/.dev.vars`** with `OPENAI_API_KEY=...`, or Cloudflare dashboard secrets.
