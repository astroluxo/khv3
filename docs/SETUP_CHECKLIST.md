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
- [ ] Configure the web app's public Supabase URL/anon key and chat function URL.
- [ ] Run an initial manual crawl/sync of the pilot knowledge tree (to be implemented in Phase 2).
- [ ] Replace fixture evaluation source keys with real document IDs/keys and expand to 30+ cases.
- [ ] Run production security gate before broader internal access.
