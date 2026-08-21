# External setup checklist

- [ ] Create/choose a Supabase project.
- [ ] Create the initial internal users or configure the desired auth provider.
- [ ] Apply `supabase/migrations/001_init.sql`.
- [ ] Add each pilot user to `user_access_scopes` for the pilot scope.
- [ ] Create a Notion integration/connection with read access only to the pilot knowledge tree.
- [ ] Share the pilot Notion pages/data source with that integration.
- [ ] Set `NOTION_API_TOKEN`, `NOTION_ROOT_PAGE_ID`, `NOTION_CONTENTS_DATABASE_ID`, and `NOTION_CONTENTS_DATA_SOURCE_ID` as server secrets.
- [ ] Deploy `sync-notion-page` and `notion-webhook` functions.
- [ ] Register the public Notion webhook URL and complete subscription verification.
- [ ] Store the Notion webhook verification token as `NOTION_WEBHOOK_VERIFICATION_TOKEN`.
- [ ] Subscribe to page/content lifecycle events needed by the pilot.
- [ ] Set `OPENAI_API_KEY`, generation model, and embedding model as server secrets.
- [ ] Deploy the chat function.
- [ ] For direct manual sync calls, use the staging Supabase secret key only from a trusted backend
      environment and send it as `apikey: sb_secret_...`; never put it in browser code or chat.
- [ ] Configure the web app's public Supabase URL/anon key and chat function URL.
- [ ] For local web testing, set `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, and `NEXT_PUBLIC_CHAT_FUNCTION_URL` in `.env.local`.
- [ ] Run `pnpm dev` and sign in with a pilot Supabase Auth user that has an allowed row in `public.user_access_scopes`.
- [ ] Validate the pilot chat flow with one supported question and one unsupported question.
- [ ] Treat the current web feedback buttons as session-local only until a dedicated safe feedback API is added.
- [ ] Run an initial manual crawl/sync of the pilot knowledge tree (to be implemented in Phase 2).
- [ ] Replace fixture evaluation source keys with real document IDs/keys and expand to 30+ cases.
- [ ] Run production security gate before broader internal access.
