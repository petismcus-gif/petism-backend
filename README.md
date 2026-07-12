# Petism Backend

Express server handling order forwarding to dropship suppliers (Spocket, TopDawg).

## Run locally

```bash
npm install
cp .env.example .env   # fill in real keys
npm run dev
```

## Deploy to Railway

1. Push this folder to a new GitHub repo:
   ```bash
   git init
   git add .
   git commit -m "Initial Petism backend"
   git branch -M main
   git remote add origin https://github.com/YOUR_USERNAME/petism-backend.git
   git push -u origin main
   ```
2. On railway.app → **New Project → GitHub Repository** → select `petism-backend`.
3. Railway auto-detects Node.js and runs `npm install` + `npm start`.
4. Go to your Railway project → **Variables** tab, and add everything from
   `.env.example` with real values (Spocket key, TopDawg key, Supabase
   service role key, Stripe secret key). Railway restarts automatically
   when you save.
5. Once deployed, Railway gives you a public URL like
   `petism-backend-production.up.railway.app`. Test it by visiting the
   root — you should see `{"status":"ok","service":"petism-backend"}`.

## Still needed before this is production-ready

- Middleware to load `req.order` from Supabase before the forward route runs
  (see the NOTE in `src/server.js`)
- Real Spocket/TopDawg endpoint URLs confirmed from your account dashboards
  (current ones in `src/supplier-adapters.js` are placeholders)
- Stripe webhook handler to trigger `/orders/:id/forward` after payment succeeds
